"""Client-side context for a backend that cannot read this machine's files.

The backend used to learn a session's git root, branch, titles, tasks and
transcript content by reading this machine's filesystem. That only works when
it runs on the same machine (and outside a container). This module gathers
those facts here, where the files are, and attaches them to the event payload:

* ``host``           this machine's name (always sent, it is cheap).
* ``client_git``     git root, repo identity, branch and a status snapshot
                     (throttled: at most every ``GIT_TTL`` seconds, and only
                     re-sent when something changed).
* ``custom_title`` / ``ai_title``  the session titles, tailed incrementally
                     from the transcript.
* ``task_files``     the session's task list (``~/.claude/tasks``) when it
                     changed.
* ``transcript_sync`` the transcript lines (main + subagents) appended since
                     the last event, trimmed, for the backend's mirror.

Per-session progress (title offset, last git snapshot, ...) lives in a small
JSON file under ``STATE_DIR`` so each hook run only does incremental work.

The backend answers each event with ``"context": "local" | "push"``: "local"
means it reads this session's files itself, so the push is skipped from then
on (only ``host`` keeps being sent so it can tell).

IMPORTANT: must never write to stdout/stderr and must never raise into the
hook; every public function swallows its own errors.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, cast

STATE_DIR = Path.home() / ".claude" / "claude-office-state"
STATE_MAX_AGE = 7 * 24 * 3600  # prune state files of sessions idle this long

GIT_TTL = 30.0  # seconds between status snapshots (forced on session start)
GIT_IDENTITY_TTL = 600.0  # seconds between root/origin lookups for one cwd
GIT_RESEND = 300.0  # re-send an unchanged snapshot this often (backend restarts)
GIT_TIMEOUT = 1.0  # per git command
GIT_MAX_FILES = 200
GIT_MAX_COMMITS = 10
# Tools that can change the working tree (refresh the snapshot after them).
GIT_TOOLS = frozenset({"Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "PowerShell"})

TASKS_DIR = Path.home() / ".claude" / "tasks"
TASK_MAX_FILES = 200
TASK_MAX_BYTES = 64 * 1024  # skip a task file larger than this

# Transcript mirror (backend app.core.transcript_mirror).
SYNC_INITIAL_TAIL = 2 * 1024 * 1024  # first sync of an existing transcript: its tail
SYNC_MAX_READ = 1024 * 1024  # raw bytes read per hook run, all files together
SYNC_MAX_SEND = 768 * 1024  # trimmed bytes sent per hook run
SYNC_STR_CAP = 8 * 1024  # any longer string in a record is cut
SYNC_LINE_CAP = 64 * 1024  # a record still longer is cut harder
SYNC_DROP_TYPES = frozenset({"file-history-snapshot"})
SYNC_SKIP_SCAN = 64 * 1024 * 1024  # how far to look for the end of a giant line
META_MAX_BYTES = 64 * 1024

TITLE_SCAN_BYTES = 32 * 1024 * 1024  # catch up at most this much per hook run
TITLE_MAX_CHARS = 200

_CREATE_NO_WINDOW = 0x08000000  # Windows: no console flash for git.exe


# ---------------------------------------------------------------------------
# State file
# ---------------------------------------------------------------------------


def _state_path(session_id: str) -> Path:
    safe = "".join(c for c in session_id if c.isalnum() or c in "-_")[:128] or "default"
    return STATE_DIR / f"{safe}.json"


def load_state(session_id: str) -> dict[str, Any]:
    try:
        raw = json.loads(_state_path(session_id).read_text(encoding="utf-8"))
        return cast(dict[str, Any], raw) if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(session_id: str, state: dict[str, Any]) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        path = _state_path(session_id)
        tmp = path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        pass


def drop_state(session_id: str) -> None:
    with contextlib.suppress(OSError):
        _state_path(session_id).unlink()


def prune_states(now: float | None = None) -> None:
    """Remove state files of sessions not seen for ``STATE_MAX_AGE``."""
    cutoff = (now or time.time()) - STATE_MAX_AGE
    try:
        for p in STATE_DIR.glob("*.json"):
            with contextlib.suppress(OSError):
                if p.stat().st_mtime < cutoff:
                    p.unlink()
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Host
# ---------------------------------------------------------------------------


def host_name() -> str:
    try:
        return socket.gethostname() or "unknown"
    except OSError:
        return "unknown"


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------


def _git(args: list[str], cwd: str) -> str | None:
    """Run one git command; stdout (stripped) or None on any failure."""
    try:
        proc = subprocess.run(
            ["git", "--no-optional-locks", *args],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=GIT_TIMEOUT,
            stdin=subprocess.DEVNULL,
            creationflags=_CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0"},
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def parse_github_repo(url: str | None) -> str | None:
    """``owner/name`` for a GitHub remote (https, ssh, scp-like), else None."""
    if not url:
        return None
    u = url.strip()
    low = u.lower()
    idx = low.find("github.com")
    if idx < 0:
        return None
    rest = u[idx + len("github.com") :].lstrip(":/")
    if rest.endswith(".git"):
        rest = rest[:-4]
    parts = [p for p in rest.split("/") if p]
    if len(parts) < 2:
        return None
    return f"{parts[0]}/{parts[1]}"


def git_identity(cwd: str) -> dict[str, Any] | None:
    """Root, main repo root (worktrees -> owning repo), origin repo, default branch."""
    out = _git(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], cwd)
    if not out:
        return None
    lines = out.splitlines()
    if len(lines) < 2:
        return None
    root, common = lines[0].strip(), lines[1].strip()
    common_path = Path(common)
    main_root = str(common_path.parent) if common_path.name == ".git" else root
    origin = _git(["config", "--get", "remote.origin.url"], root)
    default_ref = _git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], root)
    default_branch = None
    if default_ref:
        default_branch = default_ref.split("/", 1)[1] if "/" in default_ref else default_ref
    return {
        "root": root,
        "main_root": main_root,
        "repo": parse_github_repo(origin),
        "default_branch": default_branch,
    }


def parse_status(output: str) -> tuple[str | None, int, int, list[dict[str, Any]]]:
    """Parse ``git status --porcelain --branch``: (branch, ahead, behind, files)."""
    branch: str | None = None
    ahead = behind = 0
    files: list[dict[str, Any]] = []
    for line in output.splitlines():
        if line.startswith("## "):
            head = line[3:]
            info = ""
            if " [" in head and head.endswith("]"):
                head, _, info = head.partition(" [")
                info = info.rstrip("]")
            name = head.split("...", 1)[0]
            if name.startswith("No commits yet on "):
                name = name[len("No commits yet on ") :]
            branch = None if name.startswith("HEAD (no branch)") else name or None
            for part in info.split(","):
                key, _, num = part.strip().partition(" ")
                if num.isdigit():
                    if key == "ahead":
                        ahead = int(num)
                    elif key == "behind":
                        behind = int(num)
            continue
        if len(line) < 4 or len(files) >= GIT_MAX_FILES:
            continue
        index_st, work_st, path = line[0], line[1], line[3:]
        if " -> " in path:
            path = path.split(" -> ", 1)[1]
        path = path.strip('"').replace("\\", "/").rstrip("/")
        if not path:
            continue
        staged = index_st not in (" ", "?")
        status = index_st if staged else work_st
        if status not in "MADRC?!":
            status = "M"
        files.append({"path": path, "status": status, "staged": staged})
    return branch, ahead, behind, files


def parse_log(output: str) -> list[dict[str, str]]:
    commits: list[dict[str, str]] = []
    for line in output.splitlines():
        parts = line.split("|", 4)
        if len(parts) < 5:
            continue
        h, author, ts, rel, msg = parts
        commits.append(
            {"hash": h, "author": author, "timestamp": ts, "relative_time": rel, "message": msg}
        )
    return commits[:GIT_MAX_COMMITS]


def git_snapshot(cwd: str, identity: dict[str, Any]) -> dict[str, Any]:
    """Identity plus branch/ahead/behind/changed files/last commits."""
    snap = dict(identity)
    status = _git(["status", "--porcelain", "--branch"], identity["root"])
    if status is not None:
        branch, ahead, behind, files = parse_status(status)
        snap.update(branch=branch, ahead=ahead, behind=behind, changed_files=files)
    log = _git(["log", f"-{GIT_MAX_COMMITS}", "--format=%h|%an|%aI|%ar|%s"], identity["root"])
    if log is not None:
        snap["commits"] = parse_log(log)
    return snap


def _snapshot_hash(snap: dict[str, Any]) -> str:
    return hashlib.sha1(json.dumps(snap, sort_keys=True).encode("utf-8")).hexdigest()


def collect_git(
    state: dict[str, Any], cwd: str, event_type: str, tool_name: str | None, now: float
) -> dict[str, Any] | None:
    """Git snapshot to send with this event, or None (throttled / unchanged)."""
    gs = cast(dict[str, Any], state.setdefault("git", {}))
    if gs.get("disabled_until", 0) > now:
        return None
    forced = event_type == "session_start"
    due = now - float(gs.get("at", 0)) >= GIT_TTL
    relevant = event_type in ("session_start", "user_prompt_submit", "stop") or (
        event_type == "post_tool_use" and tool_name in GIT_TOOLS
    )
    if not forced and not (due and relevant) and gs.get("cwd") == cwd:
        return None

    identity = cast(dict[str, Any] | None, gs.get("identity"))
    if (
        identity is None
        or gs.get("cwd") != cwd
        or now - float(gs.get("identity_at", 0)) >= GIT_IDENTITY_TTL
    ):
        identity = git_identity(cwd)
        gs["identity_at"] = now
        gs["cwd"] = cwd
        gs["identity"] = identity
    gs["at"] = now
    if identity is None:
        # Not a repo (or no git): look again only after the identity TTL.
        gs["disabled_until"] = now + GIT_IDENTITY_TTL
        return None
    snap = git_snapshot(cwd, identity)
    digest = _snapshot_hash(snap)
    if (
        not forced
        and digest == gs.get("sent_hash")
        and now - float(gs.get("sent_at", 0)) < GIT_RESEND
    ):
        return None
    gs["sent_hash"] = digest
    gs["sent_at"] = now
    return snap


# ---------------------------------------------------------------------------
# Titles
# ---------------------------------------------------------------------------


def _clean_title(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    v = " ".join(value.split())
    return v[:TITLE_MAX_CHARS] or None


def scan_titles(state: dict[str, Any], transcript_path: str) -> tuple[str | None, str | None]:
    """Latest (custom_title, ai_title), reading only bytes appended since last run."""
    ts = cast(dict[str, Any], state.setdefault("titles", {}))
    if ts.get("path") != transcript_path:
        ts.clear()
        ts["path"] = transcript_path
    custom = cast(str | None, ts.get("custom"))
    ai = cast(str | None, ts.get("ai"))
    offset = int(ts.get("offset", 0))
    try:
        size = os.path.getsize(transcript_path)
        if size < offset:  # rewritten / truncated
            offset, custom, ai = 0, None, None
        if size > offset:
            with open(transcript_path, "rb") as fh:
                fh.seek(offset)
                chunk = fh.read(min(size - offset, TITLE_SCAN_BYTES))
            end = chunk.rfind(b"\n")
            if end >= 0:
                for line in chunk[: end + 1].splitlines():
                    if b'"custom-title"' not in line and b'"ai-title"' not in line:
                        continue
                    try:
                        rec = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(rec, dict):
                        continue
                    rec_d = cast(dict[str, Any], rec)
                    kind = rec_d.get("type")
                    if kind == "custom-title":
                        custom = _clean_title(rec_d.get("customTitle")) or custom
                    elif kind == "ai-title":
                        ai = _clean_title(rec_d.get("aiTitle")) or ai
                offset += end + 1
    except OSError:
        pass
    ts.update(offset=offset, custom=custom, ai=ai)
    return custom, ai


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


def _safe_name(name: str) -> bool:
    return bool(name) and "/" not in name and "\\" not in name and name not in (".", "..")


def task_dirs(session_id: str, task_list_id: str | None, state: dict[str, Any]) -> list[Path]:
    """Where Claude Code keeps this session's tasks (same lookup as the backend's).

    ``CLAUDE_CODE_TASK_LIST_ID`` wins; else the session id, then a folder named
    after the repo (a shared, named task list).
    """
    if task_list_id:
        return [TASKS_DIR / task_list_id] if _safe_name(task_list_id) else []
    dirs = [TASKS_DIR / session_id] if _safe_name(session_id) else []
    identity = cast(
        dict[str, Any] | None, cast(dict[str, Any], state.get("git", {})).get("identity")
    )
    if identity:
        parts = [p for p in str(identity.get("root", "")).replace("\\", "/").split("/") if p]
        if parts and _safe_name(parts[-1]):
            dirs.append(TASKS_DIR / parts[-1])
    return dirs


def collect_tasks(state: dict[str, Any], dirs: list[Path]) -> list[dict[str, Any]] | None:
    """The task files' JSON objects when they changed since last sent, else None.

    Returns [] once when a previously sent list disappeared.
    """
    ts = cast(dict[str, Any], state.setdefault("tasks", {}))
    files: list[Path] = []
    for d in dirs:
        try:
            files = sorted(d.glob("*.json"))[:TASK_MAX_FILES]
        except OSError:
            files = []
        if files:
            break
    sig: list[list[Any]] = []
    for f in files:
        try:
            st = f.stat()
        except OSError:
            continue
        sig.append([str(f), st.st_mtime_ns, st.st_size])
    if sig == ts.get("sig", []):
        return None
    ts["sig"] = sig
    tasks: list[dict[str, Any]] = []
    for path_str, _mtime, size in sig:
        if size > TASK_MAX_BYTES:
            continue
        try:
            obj = json.loads(Path(path_str).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(obj, dict):
            tasks.append(cast(dict[str, Any], obj))
    return tasks


# ---------------------------------------------------------------------------
# Transcript sync (new lines only, trimmed)
# ---------------------------------------------------------------------------


def _trim(value: Any, cap: int) -> Any:
    """Cap every string at *cap* chars; drop inline image/document data."""
    if isinstance(value, str):
        return value if len(value) <= cap else value[:cap] + "...[truncated]"
    if isinstance(value, list):
        return [_trim(v, cap) for v in cast(list[Any], value)]
    if isinstance(value, dict):
        d = cast(dict[str, Any], value)
        if d.get("type") in ("image", "document") and isinstance(d.get("source"), dict):
            return {"type": d["type"], "source": {"type": "omitted"}}
        return {k: _trim(v, cap) for k, v in d.items()}
    return value


def trim_line(raw: bytes) -> str | None:
    """One transcript record, trimmed for the mirror (None to skip it)."""
    try:
        rec = json.loads(raw)
    except ValueError:
        return None
    if isinstance(rec, dict) and cast(dict[str, Any], rec).get("type") in SYNC_DROP_TYPES:
        return None
    out = json.dumps(_trim(rec, SYNC_STR_CAP), ensure_ascii=False, separators=(",", ":"))
    if len(out) > SYNC_LINE_CAP:
        out = json.dumps(_trim(rec, 512), ensure_ascii=False, separators=(",", ":"))
    return out


def sync_targets(transcript_path: str) -> tuple[list[str], list[str]]:
    """(jsonl files, subagent meta files) of a session: main + its subagents."""
    files = [transcript_path]
    metas: list[str] = []
    sub = Path(transcript_path[: -len(".jsonl")] if transcript_path.endswith(".jsonl") else "")
    if sub.parts:
        try:
            entries = sorted((sub / "subagents").iterdir())
        except OSError:
            entries = []
        for p in entries:
            if p.name.endswith(".meta.json"):
                metas.append(str(p))
            elif p.suffix == ".jsonl":
                files.append(str(p))
    return files, metas


def _initial_offset(fh: Any, size: int) -> int:
    """Start of the first whole line within the last ``SYNC_INITIAL_TAIL`` bytes."""
    if size <= SYNC_INITIAL_TAIL:
        return 0
    # The tail may start inside a long line (tool results reach megabytes).
    return _skip_line(fh, size - SYNC_INITIAL_TAIL, size)


def _skip_line(fh: Any, off: int, size: int) -> int:
    """Offset just past the line starting at *off* (a line too big to send)."""
    pos = off
    fh.seek(off)
    while pos < size and pos - off < SYNC_SKIP_SCAN:
        block = cast(bytes, fh.read(1024 * 1024))
        if not block:
            break
        nl = block.find(b"\n")
        if nl >= 0:
            return pos + nl + 1
        pos += len(block)
    return pos


def collect_sync(state: dict[str, Any], transcript_path: str) -> list[dict[str, Any]]:
    """Chunks of lines appended since the last run (offsets kept in *state*)."""
    offsets = cast(dict[str, int], state.setdefault("sync", {}))
    meta_sigs = cast(dict[str, list[int]], state.setdefault("meta", {}))
    files, metas = sync_targets(transcript_path)
    read_left, send_left = SYNC_MAX_READ, SYNC_MAX_SEND
    chunks: list[dict[str, Any]] = []
    for path in files:
        if read_left <= 0 or send_left <= 0:
            break
        try:
            size = os.path.getsize(path)
            if offsets.get(path) == size:
                continue  # unchanged (the common case: no open)
            with open(path, "rb") as fh:
                off = offsets.get(path)
                if off is None:
                    off = _initial_offset(fh, size)
                if size < off:
                    off = 0  # rewritten
                if size == off:
                    offsets[path] = off
                    continue
                fh.seek(off)
                data = fh.read(min(size - off, read_left))
                last_nl = data.rfind(b"\n")
                if last_nl < 0:
                    if len(data) >= SYNC_MAX_READ:
                        offsets[path] = _skip_line(fh, off, size)  # one giant line
                        chunks.append({"path": path, "end": offsets[path], "lines": []})
                    continue  # a line still being written
        except OSError:
            continue
        lines: list[list[Any]] = []
        pos = off
        for raw in data[: last_nl + 1].split(b"\n")[:-1]:
            line_off = pos
            text = trim_line(raw)
            if text is not None:
                if lines and len(text) > send_left:
                    break  # the rest goes with the next hook run
                lines.append([line_off, text])
                send_left -= len(text)
            pos = line_off + len(raw) + 1
        read_left -= pos - off
        offsets[path] = pos
        chunks.append({"path": path, "end": pos, "lines": lines})
    for meta in metas:
        try:
            st = os.stat(meta)
            sig = [st.st_mtime_ns, st.st_size]
            if meta_sigs.get(meta) == sig or st.st_size > META_MAX_BYTES:
                continue
            content = Path(meta).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        meta_sigs[meta] = sig
        chunks.append({"path": meta, "content": content})
    return chunks


# ---------------------------------------------------------------------------
# Entry points used by main.py
# ---------------------------------------------------------------------------


def enrich(payload: dict[str, Any], state: dict[str, Any]) -> None:
    """Attach client context to *payload* in place (never raises)."""
    try:
        data = cast(dict[str, Any], payload.setdefault("data", {}))
        data["host"] = host_name()
        if state.get("mode") == "local":
            return
        now = time.time()
        event_type = str(payload.get("event_type", ""))
        cwd = str(data.get("project_dir") or data.get("working_dir") or "")
        if cwd:
            tool = cast(str | None, data.get("tool_name"))
            snap = collect_git(state, cwd, event_type, tool, now)
            if snap is not None:
                data["client_git"] = snap
        session_id = str(payload.get("session_id") or "")
        list_id = cast(str | None, data.get("task_list_id"))
        tasks = collect_tasks(state, task_dirs(session_id, list_id, state))
        if tasks is not None:
            data["task_files"] = tasks
        transcript = data.get("transcript_path")
        if isinstance(transcript, str) and transcript:
            custom, ai = scan_titles(state, transcript)
            if custom:
                data["custom_title"] = custom
            if ai:
                data["ai_title"] = ai
            chunks = collect_sync(state, transcript)
            if chunks:
                data["transcript_sync"] = chunks
    except Exception:  # noqa: BLE001 - context is best effort, never break the hook
        pass


def absorb_response(state: dict[str, Any], body: bytes | None) -> None:
    """Record the backend's answer (``context`` mode) in *state*."""
    if not body:
        return
    try:
        resp = json.loads(body)
    except ValueError:
        return
    if not isinstance(resp, dict):
        return
    resp_d = cast(dict[str, Any], resp)
    mode = resp_d.get("context")
    if mode in ("local", "push"):
        state["mode"] = mode
    mirror = resp_d.get("mirror")
    if isinstance(mirror, dict):
        # The backend's copy is the truth: resume from where it actually got.
        offsets = cast(dict[str, Any], state.setdefault("sync", {}))
        for path, end in cast(dict[str, Any], mirror).items():
            if isinstance(end, int) and end >= 0:
                offsets[path] = end
