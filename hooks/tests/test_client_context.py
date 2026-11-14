"""Tests for client_context: context the hook pushes for a remote backend."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from claude_office_hooks import client_context as cc


@pytest.fixture(autouse=True)
def _state_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "state"
    monkeypatch.setattr(cc, "STATE_DIR", d)
    return d


def test_parse_github_repo_variants() -> None:
    assert cc.parse_github_repo("https://github.com/o/r.git") == "o/r"
    assert cc.parse_github_repo("git@github.com:o/r.git") == "o/r"
    assert cc.parse_github_repo("ssh://git@github.com/o/r") == "o/r"
    assert cc.parse_github_repo("https://gitlab.com/o/r") is None
    assert cc.parse_github_repo(None) is None


def test_parse_status_branch_and_files() -> None:
    out = "\n".join(
        [
            "## feat/x...origin/feat/x [ahead 2, behind 1]",
            " M src/a.py",
            "A  src/b.py",
            "R  old.py -> new.py",
            "?? notes/",
        ]
    )
    branch, ahead, behind, files = cc.parse_status(out)
    assert (branch, ahead, behind) == ("feat/x", 2, 1)
    assert files == [
        {"path": "src/a.py", "status": "M", "staged": False},
        {"path": "src/b.py", "status": "A", "staged": True},
        {"path": "new.py", "status": "R", "staged": True},
        {"path": "notes", "status": "?", "staged": False},
    ]


def test_parse_status_detached_and_unborn() -> None:
    assert cc.parse_status("## HEAD (no branch)")[0] is None
    assert cc.parse_status("## No commits yet on main")[0] == "main"


def test_parse_log() -> None:
    commits = cc.parse_log("abc1234|Ann|2026-11-14T10:00:00+00:00|2 hours ago|fix: a|b")
    assert commits == [
        {
            "hash": "abc1234",
            "author": "Ann",
            "timestamp": "2026-11-14T10:00:00+00:00",
            "relative_time": "2 hours ago",
            "message": "fix: a|b",
        }
    ]


def _git_repo(path: Path) -> Path:
    path.mkdir()
    env = {"GIT_CONFIG_GLOBAL": "/dev/null", "HOME": str(path)}

    def run(*args: str) -> None:
        subprocess.run(["git", *args], cwd=path, check=True, capture_output=True, env=env)

    run("init", "-q", "-b", "main")
    run("config", "user.email", "t@example.com")
    run("config", "user.name", "T")
    run("remote", "add", "origin", "git@github.com:acme/widget.git")
    (path / "a.txt").write_text("a")
    run("add", "a.txt")
    run("commit", "-q", "-m", "first")
    (path / "b.txt").write_text("b")
    return path


def test_collect_git_snapshot_and_throttle(tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "widget")
    state: dict[str, Any] = {}
    snap = cc.collect_git(state, str(repo), "session_start", None, now=1000.0)
    assert snap is not None
    assert Path(snap["root"]) == repo.resolve()
    assert snap["repo"] == "acme/widget"
    assert snap["branch"] == "main"
    assert snap["changed_files"] == [{"path": "b.txt", "status": "?", "staged": False}]
    assert snap["commits"][0]["message"] == "first"
    # Within the TTL: nothing, even for a relevant event.
    assert cc.collect_git(state, str(repo), "post_tool_use", "Bash", now=1010.0) is None
    # After the TTL but unchanged: not re-sent until GIT_RESEND.
    assert cc.collect_git(state, str(repo), "post_tool_use", "Bash", now=1040.0) is None
    # Irrelevant tool after the TTL: not even looked at.
    (repo / "c.txt").write_text("c")
    assert cc.collect_git(state, str(repo), "post_tool_use", "Read", now=1080.0) is None
    changed = cc.collect_git(state, str(repo), "post_tool_use", "Write", now=1080.0)
    assert changed is not None and len(changed["changed_files"]) == 2


def test_collect_git_not_a_repo_backs_off(tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    state: dict[str, Any] = {}
    assert cc.collect_git(state, str(plain), "session_start", None, now=1.0) is None
    assert state["git"]["disabled_until"] > 1.0


def _write_lines(path: Path, recs: list[dict[str, Any]], mode: str = "w") -> None:
    with open(path, mode, encoding="utf-8") as fh:
        for r in recs:
            fh.write(json.dumps(r) + "\n")


def test_scan_titles_incremental(tmp_path: Path) -> None:
    t = tmp_path / "s.jsonl"
    _write_lines(t, [{"type": "user"}, {"type": "ai-title", "aiTitle": "Fix  login"}])
    state: dict[str, Any] = {}
    assert cc.scan_titles(state, str(t)) == (None, "Fix login")
    first_offset = state["titles"]["offset"]
    _write_lines(t, [{"type": "custom-title", "customTitle": "auth work"}], mode="a")
    assert cc.scan_titles(state, str(t)) == ("auth work", "Fix login")
    assert state["titles"]["offset"] > first_offset
    # A partial last line is left for the next run.
    with open(t, "a", encoding="utf-8") as fh:
        fh.write('{"type": "ai-title", "aiTitle": "half')
    before = state["titles"]["offset"]
    cc.scan_titles(state, str(t))
    assert state["titles"]["offset"] == before


def test_enrich_adds_host_titles_and_git(tmp_path: Path) -> None:
    repo = _git_repo(tmp_path / "widget")
    t = tmp_path / "s.jsonl"
    _write_lines(t, [{"type": "custom-title", "customTitle": "mine"}])
    payload: dict[str, Any] = {
        "event_type": "session_start",
        "data": {"project_dir": str(repo), "transcript_path": str(t)},
    }
    state: dict[str, Any] = {}
    cc.enrich(payload, state)
    data = payload["data"]
    assert data["host"] == cc.host_name()
    assert data["custom_title"] == "mine"
    assert data["client_git"]["repo"] == "acme/widget"


def test_enrich_local_mode_sends_only_host(tmp_path: Path) -> None:
    payload: dict[str, Any] = {
        "event_type": "session_start",
        "data": {"project_dir": str(tmp_path), "transcript_path": str(tmp_path / "x.jsonl")},
    }
    cc.enrich(payload, {"mode": "local"})
    assert set(payload["data"]) == {"project_dir", "transcript_path", "host"}


def test_absorb_response_mode() -> None:
    state: dict[str, Any] = {}
    cc.absorb_response(state, b'{"status": "accepted", "context": "local"}')
    assert state["mode"] == "local"
    cc.absorb_response(state, b"not json")
    cc.absorb_response(state, b'{"context": "bogus"}')
    assert state["mode"] == "local"
    cc.absorb_response(state, b'{"context": "push"}')
    assert state["mode"] == "push"


def test_state_roundtrip_and_prune(_state_dir: Path) -> None:
    cc.save_state("abc-123", {"mode": "push"})
    assert cc.load_state("abc-123") == {"mode": "push"}
    assert cc.load_state("../evil") == {}
    cc.prune_states(now=(_state_dir / "abc-123.json").stat().st_mtime + cc.STATE_MAX_AGE + 1)
    assert cc.load_state("abc-123") == {}
    cc.save_state("s", {})
    cc.drop_state("s")
    assert not (_state_dir / "s.json").exists()


def test_task_dirs_lookup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cc, "TASKS_DIR", tmp_path)
    state: dict[str, Any] = {"git": {"identity": {"root": "C:\\git\\widget"}}}
    assert cc.task_dirs("sid", "named", state) == [tmp_path / "named"]
    assert cc.task_dirs("sid", "../escape", state) == []
    assert cc.task_dirs("sid", None, state) == [tmp_path / "sid", tmp_path / "widget"]
    assert cc.task_dirs("sid", None, {}) == [tmp_path / "sid"]


def test_collect_tasks_only_on_change(tmp_path: Path) -> None:
    d = tmp_path / "sid"
    d.mkdir()
    (d / "1.json").write_text(json.dumps({"id": "1", "subject": "a", "status": "pending"}))
    state: dict[str, Any] = {}
    first = cc.collect_tasks(state, [d])
    assert first == [{"id": "1", "subject": "a", "status": "pending"}]
    assert cc.collect_tasks(state, [d]) is None  # unchanged
    (d / "2.json").write_text(json.dumps({"id": "2", "subject": "b"}))
    second = cc.collect_tasks(state, [d])
    assert second is not None and len(second) == 2
    for f in d.iterdir():
        f.unlink()
    assert cc.collect_tasks(state, [d]) == []  # list removed: sent once as empty
    assert cc.collect_tasks(state, [d]) is None
    # Nothing ever existed: nothing to send.
    assert cc.collect_tasks({}, [tmp_path / "missing"]) is None


def test_trim_line_caps_and_drops() -> None:
    big = "x" * (cc.SYNC_STR_CAP + 100)
    rec = {
        "type": "user",
        "message": {
            "content": [
                {"type": "tool_result", "content": big},
                {"type": "image", "source": {"type": "base64", "data": "AAAA"}},
            ]
        },
    }
    out = cc.trim_line(json.dumps(rec).encode())
    assert out is not None
    parsed = json.loads(out)
    content = parsed["message"]["content"]
    assert content[0]["content"].endswith("...[truncated]")
    assert content[1] == {"type": "image", "source": {"type": "omitted"}}
    assert cc.trim_line(b'{"type": "file-history-snapshot", "x": 1}') is None
    assert cc.trim_line(b"not json") is None


def _session_files(tmp_path: Path) -> tuple[Path, Path]:
    main = tmp_path / "projects" / "-home-u-w" / "sid.jsonl"
    sub = main.with_suffix("") / "subagents"
    sub.mkdir(parents=True)
    return main, sub


def test_collect_sync_incremental_with_subagents(tmp_path: Path) -> None:
    main, sub = _session_files(tmp_path)
    _write_lines(main, [{"type": "user", "n": 1}, {"type": "assistant", "n": 2}])
    _write_lines(sub / "agent-a1.jsonl", [{"type": "assistant", "n": 3}])
    (sub / "agent-a1.meta.json").write_text('{"toolUseId": "t1"}')
    state: dict[str, Any] = {}
    chunks = cc.collect_sync(state, str(main))
    by_path = {c["path"]: c for c in chunks}
    m = by_path[str(main)]
    assert [json.loads(t)["n"] for _, t in m["lines"]] == [1, 2]
    assert m["lines"][0][0] == 0 and m["end"] == main.stat().st_size
    assert len(by_path[str(sub / "agent-a1.jsonl")]["lines"]) == 1
    assert by_path[str(sub / "agent-a1.meta.json")]["content"] == '{"toolUseId": "t1"}'
    # Nothing new: nothing sent (meta unchanged too).
    assert cc.collect_sync(state, str(main)) == []
    # Appended line + a partial one still being written.
    size = main.stat().st_size
    _write_lines(main, [{"type": "user", "n": 4}], mode="a")
    with open(main, "a", encoding="utf-8") as fh:
        fh.write('{"type": "assistant", "n"')
    chunks = cc.collect_sync(state, str(main))
    assert len(chunks) == 1 and chunks[0]["lines"][0][0] == size
    assert [json.loads(t)["n"] for _, t in chunks[0]["lines"]] == [4]


def test_collect_sync_first_sync_starts_at_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cc, "SYNC_INITIAL_TAIL", 100)
    main, _ = _session_files(tmp_path)
    _write_lines(main, [{"type": "user", "pad": "p" * 60, "n": i} for i in range(10)])
    chunks = cc.collect_sync({}, str(main))
    ns = [json.loads(t)["n"] for _, t in chunks[0]["lines"]]
    assert ns and ns[-1] == 9 and ns[0] > 0


def test_collect_sync_send_budget_resumes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cc, "SYNC_MAX_SEND", 60)
    main, _ = _session_files(tmp_path)
    _write_lines(main, [{"type": "user", "n": i, "pad": "q" * 20} for i in range(5)])
    state: dict[str, Any] = {}
    seen: list[int] = []
    for _ in range(10):
        for c in cc.collect_sync(state, str(main)):
            seen += [json.loads(t)["n"] for _, t in c["lines"]]
    assert seen == [0, 1, 2, 3, 4]


def test_absorb_response_mirror_offsets() -> None:
    state: dict[str, Any] = {"sync": {"/p/a.jsonl": 500}}
    cc.absorb_response(state, b'{"context": "push", "mirror": {"/p/a.jsonl": 800, "/x": -1}}')
    assert state["sync"] == {"/p/a.jsonl": 800}


def test_first_sync_tail_starting_inside_a_long_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cc, "SYNC_INITIAL_TAIL", 1000)
    main, _ = _session_files(tmp_path)
    _write_lines(main, [{"type": "user", "pad": "z" * 5000, "n": 0}, {"type": "user", "n": 1}])
    chunks = cc.collect_sync({}, str(main))
    assert [json.loads(t)["n"] for _, t in chunks[0]["lines"]] == [1]
