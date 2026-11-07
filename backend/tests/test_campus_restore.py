"""Campus snapshot restores DB-active sessions that are not in memory."""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select

from app.config import get_settings
from app.core.event_processor import EventProcessor
from app.db.database import AsyncSessionLocal
from app.db.models import EventRecord, SessionRecord

PREFIX = "campus-restore-"


async def _wipe() -> None:
    async with AsyncSessionLocal() as db:
        await db.execute(delete(EventRecord).where(EventRecord.session_id.like(f"{PREFIX}%")))
        await db.execute(delete(SessionRecord).where(SessionRecord.id.like(f"{PREFIX}%")))
        await db.commit()


async def _seed(sid: str, status: str, age: timedelta) -> None:
    ts = datetime.now(UTC) - age
    async with AsyncSessionLocal() as db:
        db.add(SessionRecord(id=sid, project_name="p", status=status, updated_at=ts))
        db.add(
            EventRecord(
                session_id=sid,
                timestamp=ts,
                event_type="session_start",
                data={"project_name": "p", "working_dir": "/tmp/p"},
            )
        )
        await db.commit()
    # onupdate would not fire on insert, but be explicit about the age.
    async with AsyncSessionLocal() as db:
        rec = await db.get(SessionRecord, sid)
        assert rec is not None
        rec.updated_at = ts
        await db.commit()


async def _ignore_foreign_sessions(ep: EventProcessor) -> None:
    """The test DB is shared; skip sessions seeded by other test modules."""
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(SessionRecord.id))
        ep._campus_restore_attempted.update(  # pyright: ignore[reportPrivateUsage]
            sid for sid in result.scalars().all() if not sid.startswith(PREFIX)
        )


@pytest.mark.asyncio
async def test_snapshot_includes_recent_active_db_sessions_only() -> None:
    await _wipe()
    try:
        await _seed(f"{PREFIX}recent", "active", timedelta(minutes=5))
        await _seed(f"{PREFIX}old", "active", timedelta(days=3))
        await _seed(f"{PREFIX}done", "completed", timedelta(minutes=5))

        ep = EventProcessor()
        await _ignore_foreign_sessions(ep)
        campus = await ep.build_campus_snapshot()
        ids = {s.session_id for s in campus.sessions}
        assert f"{PREFIX}recent" in ids
        assert f"{PREFIX}old" not in ids
        assert f"{PREFIX}done" not in ids
    finally:
        await _wipe()


@pytest.mark.asyncio
async def test_restore_happens_once_and_never_replaces_live_state() -> None:
    await _wipe()
    try:
        sid = f"{PREFIX}once"
        await _seed(sid, "active", timedelta(minutes=1))
        ep = EventProcessor()
        await _ignore_foreign_sessions(ep)
        calls = 0
        orig = ep._build_restored_state_machine  # pyright: ignore[reportPrivateUsage]

        async def counting(session_id: str):  # type: ignore[no-untyped-def]
            nonlocal calls
            calls += 1
            return await orig(session_id)

        ep._build_restored_state_machine = counting  # type: ignore[method-assign]  # pyright: ignore[reportPrivateUsage]

        assert await ep.restore_active_sessions_for_campus(force=True) >= 1
        first = ep.sessions[sid]
        # Evicted (or removed) sessions are not replayed again by later scans.
        await ep.remove_session(sid)
        await ep.restore_active_sessions_for_campus(force=True)
        assert sid not in ep.sessions
        assert calls == 1

        # A machine that went live meanwhile is never overwritten.
        ep2 = EventProcessor()
        live = first
        ep2.sessions[sid] = live
        await ep2.restore_active_sessions_for_campus(force=True)
        assert ep2.sessions[sid] is live
    finally:
        await _wipe()


@pytest.mark.asyncio
async def test_scan_is_throttled_and_bounded() -> None:
    await _wipe()
    try:
        settings = get_settings()
        for i in range(3):
            await _seed(f"{PREFIX}n{i}", "active", timedelta(minutes=i + 1))
        ep = EventProcessor()
        await _ignore_foreign_sessions(ep)
        original = settings.CAMPUS_RESTORE_MAX_PER_SCAN
        settings.CAMPUS_RESTORE_MAX_PER_SCAN = 2
        try:
            await ep.restore_active_sessions_for_campus(force=True)
            mine = [s for s in ep.sessions if s.startswith(PREFIX)]
            assert len(mine) == 2  # newest first, capped
            # Throttled: a non-forced scan right after does nothing.
            assert await ep.restore_active_sessions_for_campus() == 0
            assert len([s for s in ep.sessions if s.startswith(PREFIX)]) == 2
        finally:
            settings.CAMPUS_RESTORE_MAX_PER_SCAN = original
    finally:
        await _wipe()
