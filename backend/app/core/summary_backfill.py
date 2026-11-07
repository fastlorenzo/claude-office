"""Rate-limited AI summary backfill for sessions that never got one.

``SummaryService.summarize_session`` normally runs when a live objective
changes; sessions restored from the DB or already running when the backend
started would stay without an AI summary. The campus sweep schedules those here:
one CLI call at a time, at most ``SUMMARY_BACKFILL_PER_MINUTE`` per minute
globally, once per session per objective (failures are cached by that key).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from collections.abc import Awaitable, Callable
from typing import TYPE_CHECKING

from app.config import get_settings
from app.core.summary_service import get_summary_service

if TYPE_CHECKING:
    from app.core.state_machine import StateMachine

logger = logging.getLogger(__name__)

__all__ = ["SummaryBackfill", "backfill_key"]


def backfill_key(sm: StateMachine) -> str | None:
    """What the summary would be derived from; None when there is nothing to go on."""
    obj = sm.effective_objective
    if obj:
        return obj
    return sm.first_prompts[0][:200] if sm.first_prompts else None


class SummaryBackfill:
    def __init__(self, per_minute: int | None = None) -> None:
        self._per_minute = per_minute
        self._sem = asyncio.Semaphore(1)
        self._starts: deque[float] = deque()
        self._tasks: set[asyncio.Task[None]] = set()
        self._pending: set[int] = set()

    def schedule(
        self,
        sm: StateMachine,
        on_done: Callable[[], Awaitable[None] | None] | None = None,
    ) -> bool:
        """Queue a summarization for *sm* if it needs one. Returns True if queued."""
        if sm.summary_ai or sm.campus_hidden or sm.alive is False:
            return False
        key = backfill_key(sm)
        if key is None or sm.summary_backfill_key == key or id(sm) in self._pending:
            return False
        if not get_summary_service().enabled:
            return False
        sm.summary_backfill_key = key  # once per objective, success or failure
        self._pending.add(id(sm))
        task = asyncio.create_task(self._run(sm, key, on_done))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return True

    async def _wait_slot(self) -> None:
        limit = self._per_minute or get_settings().SUMMARY_BACKFILL_PER_MINUTE
        while True:
            now = time.monotonic()
            while self._starts and now - self._starts[0] >= 60.0:
                self._starts.popleft()
            if len(self._starts) < max(1, limit):
                self._starts.append(now)
                return
            await asyncio.sleep(60.0 - (now - self._starts[0]) + 0.05)

    async def _run(
        self,
        sm: StateMachine,
        key: str,
        on_done: Callable[[], Awaitable[None] | None] | None,
    ) -> None:
        try:
            async with self._sem:
                await self._wait_slot()
                if sm.summary_ai or sm.campus_hidden:
                    return
                summary = await get_summary_service().summarize_session(sm.first_prompts, key)
            if summary and not sm.summary_ai:
                sm.summary_ai = summary
                sm.summary_ai_key = key
                if on_done is not None:
                    res = on_done()
                    if res is not None:
                        await res
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.debug("Summary backfill failed", exc_info=True)
        finally:
            self._pending.discard(id(sm))

    async def shutdown(self) -> None:
        for t in list(self._tasks):
            t.cancel()
        for t in list(self._tasks):
            with contextlib.suppress(BaseException):
                await t
