"""Remote sessions: hook-reported host, git and titles (app.core.client_context)."""

# pyright: reportPrivateUsage=false

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.core import client_context as cc
from app.core.event_processor import EventProcessor
from app.db.database import AsyncSessionLocal
from app.db.models import EventRecord, SessionRecord
from app.main import app
from app.models.campus import build_campus_session
from app.models.events import EventAdapter, EventType, SessionEvent, SessionEventData
from app.models.git import ClientGit

REMOTE = "some-other-box"


@pytest.fixture(autouse=True)
def _no_wsl(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WSL_DISTRO_NAME", raising=False)


def _git(root: str = "/home/u/git/widget") -> ClientGit:
    return ClientGit.model_validate(
        {
            "root": root,
            "main_root": root,
            "repo": "acme/widget",
            "default_branch": "main",
            "branch": "feat/x",
            "ahead": 1,
            "changed_files": [{"path": "a.py", "status": "M", "staged": False}],
            "commits": [
                {
                    "hash": "abc1234",
                    "author": "Ann",
                    "timestamp": "2026-11-14T10:00:00+00:00",
                    "relative_time": "1 hour ago",
                    "message": "fix",
                }
            ],
        }
    )


def _start(sid: str, host: str | None, git: ClientGit | None = None) -> SessionEvent:
    return SessionEvent(
        event_type=EventType.SESSION_START,
        session_id=sid,
        data=SessionEventData(
            project_name="-home-u-git-widget",
            project_dir="/home/u/git/widget",
            host=host,
            client_git=git,
            custom_title="auth work",
            ai_title="Fix login",
        ),
    )


async def _wipe(sid: str) -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(delete(EventRecord).where(EventRecord.session_id == sid))
        await db.execute(delete(SessionRecord).where(SessionRecord.id == sid))
        await db.commit()


def test_is_local_client(monkeypatch: pytest.MonkeyPatch) -> None:
    me = cc.backend_host()
    assert cc.is_local_client(None)
    assert cc.is_local_client(me)
    assert cc.is_local_client(me.upper())
    assert not cc.is_local_client(REMOTE)
    # WSL shares the Windows host name: the distro must match too.
    assert not cc.is_local_client(me, "Ubuntu")
    monkeypatch.setenv("WSL_DISTRO_NAME", "Ubuntu")
    assert cc.is_local_client(me, "Ubuntu")
    assert not cc.is_local_client(me, None)


def test_helpers() -> None:
    assert cc.path_basename("C:\\Users\\u\\git\\widget\\") == "widget"
    assert cc.path_basename("/home/u/git/widget") == "widget"
    assert cc.path_basename(None) is None
    assert cc.host_label("pc", "Ubuntu") == "pc (WSL Ubuntu)"
    assert cc.host_label(None) is None
    status = cc.client_git_status(_git())
    assert status is not None
    assert (status.branch, status.ahead, status.repo_path) == ("feat/x", 1, "/home/u/git/widget")
    assert cc.client_git_status(None) is None


def test_client_git_caps_lists() -> None:
    files = [{"path": f"f{i}", "status": "M"} for i in range(800)]
    git = ClientGit.model_validate({"root": "/r", "changed_files": files})
    assert git.changed_files is not None and len(git.changed_files) == 500


def test_context_mode(tmp_path: Path) -> None:
    t = tmp_path / "s.jsonl"
    t.write_text("{}\n")
    me = cc.backend_host()

    def ev(host: str | None, path: str | None) -> SessionEvent:
        return SessionEvent(
            event_type=EventType.SESSION_START,
            session_id="cm",
            data=SessionEventData(host=host, transcript_path=path),
        )

    assert cc.context_mode(ev(REMOTE, str(t))) == "push"
    assert cc.context_mode(ev(me, str(tmp_path / "missing.jsonl"))) == "push"
    assert cc.context_mode(ev(me, str(t))) == "local"
    assert cc.context_mode(ev(None, None)) == "local"


def test_events_endpoint_returns_context_mode() -> None:
    client = TestClient(app)
    body = {
        "event_type": "notification",
        "session_id": "ctx-mode-1",
        "data": {"host": REMOTE, "message": "hi"},
    }
    resp = client.post("/api/v1/events", json=body)
    assert resp.status_code == 200
    assert resp.json()["context"] == "push"


def test_hook_payload_parses() -> None:
    ev = EventAdapter.validate_python(
        {
            "event_type": "session_start",
            "session_id": "p1",
            "data": {
                "host": REMOTE,
                "client_git": {"root": "C:\\git\\w", "branch": "main"},
                "custom_title": "x",
            },
        }
    )
    assert ev.data.client_git is not None and ev.data.client_git.branch == "main"


@pytest.mark.asyncio
async def test_remote_session_uses_client_report(tmp_path: Path) -> None:
    sid = "remote-ctx-1"
    await _wipe(sid)
    ep = EventProcessor()
    # The client's root exists here too (a same-named local checkout): it must
    # still not be treated as this session's repo.
    local_twin = tmp_path / "widget"
    (local_twin / ".git").mkdir(parents=True)
    try:
        await ep.process_event(_start(sid, REMOTE, _git(str(local_twin))))
        async with AsyncSessionLocal() as db:
            rec = (
                await db.execute(select(SessionRecord).where(SessionRecord.id == sid))
            ).scalar_one()
        assert rec.project_root == str(local_twin)
        assert rec.display_name == "widget"
        assert rec.host == REMOTE
        # Local-only consumers (git_service, beads, task dirs) get nothing.
        assert await ep.get_project_root(sid) is None

        sm = ep.sessions[sid]
        assert not sm.is_local
        assert sm.custom_title == "auth work"
        assert sm.ai_title == "Fix login"
        status = await ep.get_client_git_status(sid)
        assert status is not None and status.branch == "feat/x"

        cs = build_campus_session(sid, sm)
        assert cs.project == "widget"
        assert cs.project_id == "acme/widget"
        assert cs.git_branch == "feat/x"
        assert cs.host == REMOTE
        assert cs.session_name == "auth work"
    finally:
        await _wipe(sid)


@pytest.mark.asyncio
async def test_remote_session_without_git_has_no_root(tmp_path: Path) -> None:
    sid = "remote-ctx-2"
    await _wipe(sid)
    ep = EventProcessor()
    try:
        await ep.process_event(_start(sid, REMOTE))
        async with AsyncSessionLocal() as db:
            rec = (
                await db.execute(select(SessionRecord).where(SessionRecord.id == sid))
            ).scalar_one()
        assert rec.project_root is None
        assert await ep.get_client_git_status(sid) is None
    finally:
        await _wipe(sid)


@pytest.mark.asyncio
async def test_local_session_keeps_project_root() -> None:
    sid = "local-ctx-1"
    await _wipe(sid)
    ep = EventProcessor()
    try:
        await ep.process_event(_start(sid, cc.backend_host(), _git("/home/u/git/widget")))
        assert ep.sessions[sid].is_local
        assert await ep.get_project_root(sid) == "/home/u/git/widget"
        assert await ep.get_client_git_status(sid) is None  # git_service's job
    finally:
        await _wipe(sid)


@pytest.mark.asyncio
async def test_remote_task_files_become_todos() -> None:
    from app.models.events import ToolEvent, ToolEventData

    sid = "remote-tasks-1"
    await _wipe(sid)
    ep = EventProcessor()
    try:
        await ep.process_event(_start(sid, REMOTE))
        tasks = [
            {"id": "2", "subject": "second", "status": "in_progress"},
            {"id": "1", "subject": "first", "status": "completed"},
            {"id": "3", "status": "pending"},  # no subject: dropped
        ]
        await ep.process_event(
            ToolEvent(
                event_type=EventType.POST_TOOL_USE,
                session_id=sid,
                data=ToolEventData(tool_name="TaskUpdate", host=REMOTE, task_files=tasks),
            )
        )
        sm = ep.sessions[sid]
        assert [t.content for t in sm.todos] == ["first", "second"]
        # Not stored with the event row.
        async with AsyncSessionLocal() as db:
            rows = (
                (await db.execute(select(EventRecord).where(EventRecord.session_id == sid)))
                .scalars()
                .all()
            )
        assert rows and all("task_files" not in (r.data or {}) for r in rows)
    finally:
        await _wipe(sid)


@pytest.mark.asyncio
async def test_statusline_refreshes_remote_activity() -> None:
    from datetime import UTC, datetime, timedelta

    sid = "remote-hb-1"
    await _wipe(sid)
    ep = EventProcessor()
    try:
        await ep.process_event(_start(sid, REMOTE))
        sm = ep.sessions[sid]
        sm.last_event_at = datetime.now(UTC) - timedelta(hours=1)
        ep.note_client_activity(sid)
        assert (datetime.now(UTC) - sm.last_event_at).total_seconds() < 5
        ep.note_client_activity("unknown-sid")  # no-op
        ep.note_client_activity(None)
    finally:
        await _wipe(sid)
