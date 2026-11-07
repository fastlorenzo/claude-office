"""Campus liveness (pid registry + staleness) and AI summary backfill."""

# pyright: reportPrivateUsage=false

import asyncio
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from app.config import get_settings
from app.core import session_liveness as sl
from app.core.event_processor import EventProcessor
from app.core.state_machine import OfficePhase, StateMachine
from app.core.summary_backfill import SummaryBackfill
from app.models.campus import build_campus, build_campus_session


def _write(d: Path, pid: int, sid: str, proc_start: str | None = None) -> None:
    data: dict[str, object] = {"pid": pid, "sessionId": sid}
    if proc_start is not None:
        data["procStart"] = proc_start
    (d / f"{pid}.json").write_text(json.dumps(data))


def test_registry_alive_dead_and_resume(tmp_path: Path) -> None:
    me = os.getpid()
    _write(tmp_path, me, "alive-sid", sl._proc_start(me))
    _write(tmp_path, 4_000_000, "dead-sid")  # no such pid
    _write(tmp_path, 4_000_001, "resumed-sid")  # old dead pid
    pp = os.getppid()
    _write(tmp_path, pp, "resumed-sid", sl._proc_start(pp))  # --resume: same id, live pid
    (tmp_path / "junk.json").write_text("{nope")
    reg = sl.load_registry(tmp_path, now=1000.0)
    assert reg is not None
    old = datetime.now(UTC) - timedelta(hours=1)
    assert sl.session_alive("alive-sid", reg, old) is True
    assert sl.session_alive("dead-sid", reg, old) is False
    assert sl.session_alive("resumed-sid", reg, old) is True
    # unknown id (e.g. after /clear), but brand new: give the registry time
    assert sl.session_alive("nope", reg, datetime.now(UTC)) is None
    assert sl.session_alive("nope", reg, old) is False


def test_pid_reuse_detected_by_proc_start(tmp_path: Path) -> None:
    me = os.getpid()
    assert sl.pid_alive(me, sl._proc_start(me))
    assert not sl.pid_alive(me, "1")  # same pid, different start time


def test_no_registry_is_unknown(tmp_path: Path) -> None:
    assert sl.load_registry(tmp_path / "missing", now=5000.0) is None
    assert sl.session_alive("x", None, datetime.now(UTC) - timedelta(days=1)) is None


def test_last_activity_uses_transcript_mtime(tmp_path: Path) -> None:
    t = tmp_path / "t.jsonl"
    t.write_text("{}")
    ev = datetime.now(UTC) - timedelta(hours=2)
    assert sl.last_activity(ev, str(t)) > ev + timedelta(hours=1)
    assert sl.last_activity(ev, str(tmp_path / "none")) == ev
    assert sl.is_stale(ev, 1200)
    assert not sl.is_stale(datetime.now(UTC), 1200)


def test_stale_unknown_session_is_idle_bucket() -> None:
    sm = StateMachine()
    sm.last_event_at = datetime.now(UTC) - timedelta(hours=3)
    cs = build_campus_session("s", sm)
    assert cs.alive is None
    assert cs.bucket == "done"
    assert cs.last_event_at == sm.last_event_at
    dumped = cs.model_dump(by_alias=True)
    assert "alive" in dumped and "lastEventAt" in dumped


@pytest.mark.asyncio
async def test_sweep_ends_then_hides_dead_session(tmp_path: Path) -> None:
    s = get_settings()
    me = os.getpid()
    _write(tmp_path, me, "live", sl._proc_start(me))
    _write(tmp_path, 4_000_000, "gone")
    ep = EventProcessor()
    live, gone, ghost = StateMachine(), StateMachine(), StateMachine()
    old = datetime.now(UTC) - timedelta(hours=1)
    for sm in (live, gone, ghost):
        sm.last_event_at = old
    gone.alive = True  # was seen alive by this process: plays "ended" first
    ep.sessions.update({"live": live, "gone": gone, "ghost": ghost})
    with (
        patch.object(s, "CLAUDE_SESSIONS_DIR", str(tmp_path)),
        patch.object(s, "CAMPUS_DEAD_GRACE_SECONDS", 60),
        patch("app.core.event_processor.broadcast_campus_state", new=AsyncMock()) as bc,
        patch.object(EventProcessor, "_mark_session_completed", new=AsyncMock()),
    ):
        sl._cache.clear()
        assert await ep.sweep_campus_liveness()
        assert live.alive is True and not live.campus_hidden
        assert gone.alive is False and gone.phase == OfficePhase.ENDED
        assert not gone.campus_hidden  # grace
        assert ghost.campus_hidden  # never seen alive: dropped at once
        assert [x.session_id for x in build_campus(ep.sessions).sessions] == ["gone", "live"]
        bc.assert_awaited()
        gone.dead_since = datetime.now(UTC) - timedelta(seconds=61)
        assert await ep.sweep_campus_liveness()
        assert gone.campus_hidden
        assert [x.session_id for x in build_campus(ep.sessions).sessions] == ["live"]
        # a new event revives it
        assert not await ep.sweep_campus_liveness()


@pytest.mark.asyncio
async def test_backfill_once_per_objective_and_failures_cached() -> None:
    sm = StateMachine()
    sm.alive = True
    sm.first_prompts = ["Add SSO login to the admin dashboard"]
    sm.objective = "Add SSO login"
    svc = AsyncMock()
    svc.enabled = True
    svc.summarize_session = AsyncMock(return_value=None)  # failure
    bf = SummaryBackfill(per_minute=6)
    with patch("app.core.summary_backfill.get_summary_service", return_value=svc):
        assert bf.schedule(sm)
        await asyncio.gather(*bf._tasks)
        assert not bf.schedule(sm)  # failure cached for this objective
        assert svc.summarize_session.await_count == 1
        sm.objective = "Something else entirely"
        done = AsyncMock()
        svc.summarize_session = AsyncMock(return_value="Add SSO login to admin")
        assert bf.schedule(sm, done)
        await asyncio.gather(*bf._tasks)
        assert sm.summary_ai == "Add SSO login to admin"
        assert done.await_count == 1
        assert not bf.schedule(sm)  # already has one


@pytest.mark.asyncio
async def test_backfill_rate_limit_and_concurrency() -> None:
    svc = AsyncMock()
    svc.enabled = True
    running = 0
    peak = 0

    async def slow(*_a: object, **_k: object) -> str:
        nonlocal running, peak
        running += 1
        peak = max(peak, running)
        await asyncio.sleep(0.01)
        running -= 1
        return "Build the thing now"

    svc.summarize_session = slow
    bf = SummaryBackfill(per_minute=2)
    machines: list[StateMachine] = []
    for i in range(3):
        sm = StateMachine()
        sm.objective = f"Objective number {i}"
        machines.append(sm)
    with patch("app.core.summary_backfill.get_summary_service", return_value=svc):
        for sm in machines:
            assert bf.schedule(sm)
        await asyncio.sleep(0.2)
        assert peak == 1
        assert sum(1 for m in machines if m.summary_ai) == 2  # third waits for the window
        await bf.shutdown()
