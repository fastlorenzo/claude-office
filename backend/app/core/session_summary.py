"""Human-readable session identity: ticket refs, project name, plain-language summary.

All pure helpers (plus a cached filesystem lookup for the project name) used by
the campus builder. The AI part lives in ``SummaryService.summarize_session``;
here we only resolve the precedence and clean text.
"""

from __future__ import annotations

import re
import time
from pathlib import Path

__all__ = [
    "SESSION_SUMMARY_MAX_CHARS",
    "clean_summary",
    "extract_refs",
    "meaningful_words",
    "humanize_branch",
    "project_name_for_root",
    "resolve_summary",
    "strip_refs",
]

SESSION_SUMMARY_MAX_CHARS = 70
MAX_REFS = 3

_JIRA_ANY_CASE = re.compile(r"(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]+-\d+)(?![A-Za-z0-9])")
_JIRA_UPPER = re.compile(r"(?<![A-Za-z0-9])([A-Z][A-Z0-9]+-\d+)(?![A-Za-z0-9])")
_PR_URL = re.compile(r"github\.com/[\w.\-]+/[\w.\-]+/pull/(\d+)", re.IGNORECASE)
_PR_TEXT = re.compile(r"\b(?:PR|pull request)\s*#?(\d+)\b", re.IGNORECASE)
# Look-alikes that are not tickets.
_NOT_TICKET_PREFIXES = frozenset(
    {"UTF", "SHA", "ISO", "MD", "RFC", "X", "GPT", "CVE", "ES", "UTC", "HTTP", "TLS", "SSL"}
)

_STRIP_RE = re.compile(r"(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]+-\d+(?![A-Za-z0-9])")
_FOLLOW_UP_START = frozenset(
    {
        "also", "and", "then", "but", "why", "how", "what", "where", "when", "is", "are",
        "does", "do", "did", "can", "could", "should", "it", "that", "this", "ok", "okay",
        "yes", "no", "actually", "wait", "thanks", "now", "continue",
    }
)  # fmt: skip
_BRANCH_PREFIX = re.compile(
    r"^(?:feat|feature|fix|bugfix|hotfix|chore|refactor|docs|doc|test|tests|perf|build|ci|"
    r"style|wip|task|story|user|dev)[/_-]",
    re.IGNORECASE,
)
_GENERIC_BRANCHES = frozenset({"main", "master", "develop", "dev", "trunk", "head", "staging"})
_ACRONYMS = frozenset(
    {"sso", "api", "ui", "ux", "ci", "cd", "db", "url", "jwt", "oauth", "sql", "css", "html",
     "csv", "pdf", "cli", "sdk", "ssr", "i18n", "ai", "llm", "3d", "2d", "gpu", "ws", "http"}
)  # fmt: skip


def _is_ticket(token: str) -> bool:
    prefix = token.rsplit("-", 1)[0].upper()
    return prefix not in _NOT_TICKET_PREFIXES and len(prefix) >= 2


def extract_refs(
    *,
    session_name: str | None = None,
    branch: str | None = None,
    objective: str | None = None,
    prompts: list[str] | None = None,
) -> list[str]:
    """Ticket / PR references (max 3, de-duplicated, in source order).

    Session name and branch are matched case-insensitively ("cont-839" ->
    "CONT-839"); free text (objective, prompts) only matches uppercase ids to
    avoid "utf-8"-style false positives. GitHub PR URLs and "PR 123" become
    "#123".
    """
    refs: list[str] = []

    def add(ref: str) -> None:
        if ref not in refs and len(refs) < MAX_REFS:
            refs.append(ref)

    for text in (session_name, branch):
        for m in _JIRA_ANY_CASE.finditer(text or ""):
            if _is_ticket(m.group(1)):
                add(m.group(1).upper())
    for text in (objective, *(prompts or [])):
        flat = text or ""
        for m in _JIRA_UPPER.finditer(flat):
            if _is_ticket(m.group(1)):
                add(m.group(1))
        for pm in _PR_URL.finditer(flat):
            add(f"#{pm.group(1)}")
        for pm in _PR_TEXT.finditer(flat):
            add(f"#{pm.group(1)}")
    return refs


def strip_refs(text: str) -> str:
    """Remove ticket ids and tidy leftover punctuation ("[CONT-839]: Add x" -> "Add x")."""
    out = _STRIP_RE.sub(" ", text)
    out = re.sub(r"\(\s*\)|\[\s*\]", " ", out)
    out = " ".join(out.split())
    return out.strip(" \t,;:-–—.[]()/")


def _cap_first(text: str) -> str:
    return text[:1].upper() + text[1:] if text else text


def _fit(text: str, limit: int = SESSION_SUMMARY_MAX_CHARS) -> str:
    flat = " ".join(text.split())
    if len(flat) <= limit:
        return flat
    cut = flat[: limit - 1]
    if flat[limit - 1] != " " and " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.rstrip(" ,;:-.") + "…"


# Connectors / verbs that carry no meaning once ticket ids are gone ("CONT-1 and CONT-2").
_STOP_WORDS = frozenset(
    {
        "and", "or", "the", "to", "for", "with", "fix", "fixes", "fixed", "wip", "of", "in",
        "on", "at", "by", "from", "into", "a", "an", "pr", "prs", "ticket", "tickets",
        "issue", "issues", "task", "tasks", "work", "working", "implement", "do", "please",
        "per", "via", "vs", "also", "plus",
    }
)  # fmt: skip


def meaningful_words(text: str) -> list[str]:
    """Words of >= 3 letters that are not connectors/stop words."""
    return [
        w for w in re.findall(r"[^\W\d_]+", text) if len(w) >= 3 and w.lower() not in _STOP_WORDS
    ]


def _meaningful(text: str) -> bool:
    words = re.findall(r"[A-Za-z0-9]+", text)
    if len(words) < 2 or sum(len(w) for w in words) < 8:
        return False
    if len(meaningful_words(text)) < 2:
        return False
    if text.rstrip().endswith("?"):
        return False
    return words[0].lower() not in _FOLLOW_UP_START


def clean_summary(text: str | None) -> str | None:
    """Strip ticket ids, enforce <=70 chars; None when nothing meaningful remains."""
    if not text:
        return None
    stripped = strip_refs(text.strip().strip("\"'`"))
    if not _meaningful(stripped):
        return None
    return _fit(_cap_first(stripped.rstrip(".")))


def humanize_branch(branch: str | None) -> str | None:
    """ "feat/CONT-839-sso-login-admin" -> "SSO login admin"; None for main/master/..."""
    if not branch or branch.strip().lower() in _GENERIC_BRANCHES:
        return None
    name = _BRANCH_PREFIX.sub("", branch.strip())
    name = strip_refs(name.replace("/", " "))
    words = [w for w in re.split(r"[-_\s]+", name) if w]
    if not words:
        return None
    words = [w.upper() if w.lower() in _ACRONYMS else w for w in words]
    text = _cap_first(" ".join(words))
    if sum(len(w) for w in words) < 3:
        return None
    return _fit(text)


def resolve_summary(
    *,
    ai_summary: str | None,
    ai_title: str | None,
    objective: str | None,
    branch: str | None,
) -> str | None:
    """AI summary > Claude's aiTitle > objective (ticket ids stripped) > branch > None."""
    for candidate in (ai_summary, ai_title, objective):
        if cleaned := clean_summary(candidate):
            return cleaned
    return humanize_branch(branch)


# ---------------------------------------------------------------------------
# Project name
# ---------------------------------------------------------------------------

_PROJECT_TTL_SECONDS = 300.0
_project_cache: dict[str, tuple[float, str | None]] = {}


def _repo_name(root: str) -> str | None:
    """Basename of the git toplevel above *root* (main repo name for worktrees)."""
    try:
        start = Path(root).resolve()
        for d in (start, *start.parents):
            git = d / ".git"
            if git.is_dir():
                return d.name
            if git.is_file():
                text = git.read_text(encoding="utf-8", errors="replace")[:1024]
                if text.startswith("gitdir:"):
                    gd = Path(text[len("gitdir:") :].strip())
                    if not gd.is_absolute():
                        gd = d / gd
                    parts = gd.parts
                    if "worktrees" in parts:  # <repo>/.git/worktrees/<name>
                        idx = len(parts) - 1 - parts[::-1].index("worktrees")
                        if idx >= 2 and parts[idx - 1] == ".git":
                            return Path(*parts[: idx - 1]).name or None
                return d.name
    except OSError:
        return None
    return None


def project_name_for_root(root: str | None, now: float | None = None) -> str | None:
    """Repo (git toplevel) basename for *root*, else the root's own basename; cached."""
    if not root:
        return None
    ts = time.monotonic() if now is None else now
    hit = _project_cache.get(root)
    if hit is not None and ts - hit[0] < _PROJECT_TTL_SECONDS:
        return hit[1]
    name = _repo_name(root) or Path(root).name or None
    _project_cache[root] = (ts, name)
    if len(_project_cache) > 256:
        _project_cache.pop(next(iter(_project_cache)))
    return name
