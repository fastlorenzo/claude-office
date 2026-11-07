"""Telemetry store: status line reports + activity counters -> control-room stats.

In-memory with a small JSON file for what must survive a restart (today's cost
and series, rate-limit samples, per-session cost baselines, building event
buckets). Cost accounting works on per-session *deltas* so restarts, resumed
sessions (counter resets) and sessions that predate the backend do not inflate
"today".
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from app.config import get_settings
from app.core.session_phase import PhaseKind, classify_tool
from app.core.transcript_telemetry import TailSnapshot, TranscriptTail
from app.models.events import AnyEvent, EventType
from app.models.telemetry import (
    CampusStats,
    RateLimitWindow,
    SessionActivityStats,
    SessionTelemetry,
)

logger = logging.getLogger(__name__)

__all__ = ["TelemetryStore", "get_telemetry_store", "reset_telemetry_store"]

SESSION_BUCKETS = 30  # 1-min buckets per session
BUILDING_BUCKETS = 60  # 1-min buckets building-wide
COST_BUCKETS = 36  # 5-min buckets (3 h)
SAMPLE_WINDOW_S = 90 * 60
BURN_LOOKBACK_S = 60 * 60
MIN_BURN_SPAN_S = 5 * 60
WINDOW_LEN_S = {"five_hour": 5 * 3600, "seven_day": 7 * 24 * 3600}
_SAVE_MIN_INTERVAL_S = 20.0
_SESSION_CAP = 512


def _num(v: Any) -> float | None:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _int(v: Any) -> int | None:
    n = _num(v)
    return int(n) if n is not None else None


def _dig(d: Any, *path: str) -> Any:
    for k in path:
        if not isinstance(d, dict):
            return None
        d = cast(dict[str, Any], d).get(k)
    return d


def _iso_epoch(v: Any) -> str | None:
    n = _num(v)
    if n is None or n <= 0:
        return None
    if n > 1e12:  # milliseconds
        n /= 1000
    return datetime.fromtimestamp(n, UTC).isoformat()


def _epoch(v: Any) -> float | None:
    n = _num(v)
    if n is None or n <= 0:
        return None
    return n / 1000 if n > 1e12 else n


@dataclass
class _SessionAct:
    minutes: dict[int, int] = field(default_factory=lambda: cast(dict[int, int], {}))
    tool_mix: dict[str, int] = field(default_factory=lambda: cast(dict[str, int], {}))
    tool_calls: int = 0
    subagents: int = 0
    test_runs: int = 0
    test_failures: int = 0
    errors: int = 0


@dataclass
class _Baseline:
    cost: float = 0.0
    added: int = 0
    removed: int = 0


class TelemetryStore:
    def __init__(self, path: str | None = None) -> None:
        self._path = Path(path) if path else None
        self.sessions: dict[str, SessionTelemetry] = {}
        # Fallback: per-transcript accumulators (estimates) when no status line reports.
        self._tails: dict[str, TranscriptTail] = {}
        self._tail_lock = threading.Lock()
        self._act: dict[str, _SessionAct] = {}
        self._building: dict[int, int] = {}
        self._base: dict[str, _Baseline] = {}
        self._cost5: dict[int, float] = {}  # epoch//300 -> usd
        self._day = ""
        self._cost_today = 0.0
        self._added_today = 0
        self._removed_today = 0
        self._limits: dict[str, tuple[float, float | None]] = {}  # name -> (pct, resets_epoch)
        self._samples: dict[str, deque[tuple[float, float]]] = {
            "five_hour": deque(),
            "seven_day": deque(),
        }
        self._last_save = 0.0
        self._dirty = False
        self._load()

    # -- persistence -------------------------------------------------------

    def _load(self) -> None:
        if self._path is None:
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(raw, dict):
            return
        d = cast(dict[str, Any], raw)
        try:
            self._day = str(d.get("day", ""))
            self._cost_today = float(d.get("costToday", 0.0))
            self._added_today = int(d.get("addedToday", 0))
            self._removed_today = int(d.get("removedToday", 0))
            self._cost5 = {int(k): float(v) for k, v in d.get("cost5", {}).items()}
            self._building = {int(k): int(v) for k, v in d.get("building", {}).items()}
            self._base = {
                str(k): _Baseline(float(v[0]), int(v[1]), int(v[2]))
                for k, v in d.get("base", {}).items()
            }
            for name, rows in d.get("samples", {}).items():
                if name in self._samples:
                    self._samples[name] = deque((float(t), float(p)) for t, p in rows)
            for name, row in d.get("limits", {}).items():
                self._limits[name] = (float(row[0]), None if row[1] is None else float(row[1]))
        except (TypeError, ValueError, KeyError, IndexError):
            logger.warning("Ignoring unreadable telemetry state file")

    def save(self, force: bool = False) -> None:
        """Persist rollups (throttled; never raises)."""
        if self._path is None or not self._dirty:
            return
        now = time.monotonic()
        if not force and now - self._last_save < _SAVE_MIN_INTERVAL_S:
            return
        self._last_save = now
        data = {
            "day": self._day,
            "costToday": self._cost_today,
            "addedToday": self._added_today,
            "removedToday": self._removed_today,
            "cost5": {str(k): v for k, v in self._cost5.items()},
            "building": {str(k): v for k, v in self._building.items()},
            "base": {k: [b.cost, b.added, b.removed] for k, b in self._base.items()},
            "samples": {k: list(v) for k, v in self._samples.items()},
            "limits": {k: list(v) for k, v in self._limits.items()},
        }
        try:
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(data), encoding="utf-8")
            os.replace(tmp, self._path)
            self._dirty = False
        except OSError:
            logger.debug("Telemetry state save failed", exc_info=True)

    # -- ingest ------------------------------------------------------------

    def _roll_day(self, now: float) -> None:
        day = datetime.fromtimestamp(now).strftime("%Y-%m-%d")  # local day
        if day != self._day:
            self._day = day
            self._cost_today = 0.0
            self._added_today = 0
            self._removed_today = 0

    def ingest_statusline(self, payload: dict[str, Any], now: float | None = None) -> str | None:
        """Record one status line JSON. Returns the session id (None if unusable)."""
        ts = time.time() if now is None else now
        sid = payload.get("session_id")
        if not isinstance(sid, str) or not sid:
            sid = None
        self._roll_day(ts)

        cost = _num(_dig(payload, "cost", "total_cost_usd"))
        added = _int(_dig(payload, "cost", "total_lines_added"))
        removed = _int(_dig(payload, "cost", "total_lines_removed"))
        dur = _int(_dig(payload, "cost", "total_duration_ms"))

        warm: Any = _dig(payload, "prompt_cache", "warm")
        if sid is not None:
            tel = SessionTelemetry(
                model=_str(_dig(payload, "model", "display_name")),
                effort=_str(_dig(payload, "effort", "level")),
                context_used_pct=_num(_dig(payload, "context_window", "used_percentage")),
                context_tokens=_int(_dig(payload, "context_window", "total_input_tokens")),
                context_window=_int(_dig(payload, "context_window", "context_window_size")),
                cost_usd=cost,
                lines_added=added,
                lines_removed=removed,
                duration_ms=dur,
                cache_warm=warm if isinstance(warm, bool) else None,
                cache_expires_at=_iso_epoch(_dig(payload, "prompt_cache", "expires_at")),
                repo=_repo(payload),
                output_style=_str(_dig(payload, "output_style", "name")),
                source="statusline",
                updated_at=datetime.fromtimestamp(ts, UTC).isoformat(),
            )
            if len(self.sessions) >= _SESSION_CAP and sid not in self.sessions:
                self.sessions.pop(next(iter(self.sessions)))
            self.sessions[sid] = tel
            self._account_cost(sid, cost, added, removed, dur, ts)

        for name in ("five_hour", "seven_day"):
            pct = _num(_dig(payload, "rate_limits", name, "used_percentage"))
            if pct is None:
                continue
            resets = _epoch(_dig(payload, "rate_limits", name, "resets_at"))
            self._limits[name] = (pct, resets)
            dq = self._samples[name]
            if dq and pct < dq[-1][1] - 0.5:  # window reset: older samples are another window
                dq.clear()
            dq.append((ts, pct))
            while dq and ts - dq[0][0] > SAMPLE_WINDOW_S:
                dq.popleft()
        self._dirty = True
        self.save()
        return sid

    def _account_cost(
        self,
        sid: str,
        cost: float | None,
        added: int | None,
        removed: int | None,
        dur: int | None,
        ts: float,
    ) -> None:
        base = self._base.get(sid)
        # First sighting: only a fresh session's spend is "today"; a long-running one
        # (or one from before the backend knew it) just sets the baseline.
        fresh = dur is not None and dur < 120_000
        d_cost = _delta(cost, base.cost if base else None, fresh)
        d_add = _delta(added, base.added if base else None, fresh)
        d_rem = _delta(removed, base.removed if base else None, fresh)
        if base is None:
            base = self._base[sid] = _Baseline()
        if cost is not None:
            base.cost = cost
        if added is not None:
            base.added = added
        if removed is not None:
            base.removed = removed
        if len(self._base) > _SESSION_CAP:
            self._base.pop(next(iter(self._base)))
        self._cost_today += d_cost
        self._added_today += int(d_add)
        self._removed_today += int(d_rem)
        if d_cost > 0:
            b = int(ts // 300)
            self._cost5[b] = self._cost5.get(b, 0.0) + d_cost
            for k in [k for k in self._cost5 if k < b - COST_BUCKETS - 12]:
                del self._cost5[k]

    def record_event(self, session_id: str, event: AnyEvent, now: float | None = None) -> None:
        """Count one hook event into the session and building activity buckets."""
        ts = time.time() if now is None else now
        minute = int(ts // 60)
        act = self._act.get(session_id)
        if act is None:
            if len(self._act) >= _SESSION_CAP:
                self._act.pop(next(iter(self._act)))
            act = self._act[session_id] = _SessionAct()
        act.minutes[minute] = act.minutes.get(minute, 0) + 1
        for k in [k for k in act.minutes if k <= minute - SESSION_BUCKETS]:
            del act.minutes[k]
        self._building[minute] = self._building.get(minute, 0) + 1
        for k in [k for k in self._building if k <= minute - BUILDING_BUCKETS]:
            del self._building[k]
        self._dirty = True

        et = event.event_type
        data = event.data
        tool = getattr(data, "tool_name", None)
        tool_input = getattr(data, "tool_input", None)
        if et == EventType.PRE_TOOL_USE:
            kind = classify_tool(tool, tool_input).kind
            act.tool_calls += 1
            act.tool_mix[kind] = act.tool_mix.get(kind, 0) + 1
            if kind == "testing":
                act.test_runs += 1
        elif et == EventType.POST_TOOL_USE:
            if getattr(data, "success", None) is False:
                act.errors += 1
                if classify_tool(tool, tool_input).kind == "testing":
                    act.test_failures += 1
        elif et == EventType.ERROR:
            act.errors += 1
        elif et == EventType.SUBAGENT_START:
            act.subagents += 1

    # -- views -------------------------------------------------------------

    def refresh_transcript(self, session_id: str, path: str, now: float | None = None) -> bool:
        """Tail *path* for this session's estimated telemetry (blocking file IO)."""
        ts = time.time() if now is None else now
        with self._tail_lock:
            tail = self._tails.get(session_id)
            if tail is None or tail.path != path:
                if len(self._tails) >= _SESSION_CAP and session_id not in self._tails:
                    self._tails.pop(next(iter(self._tails)))
                tail = self._tails[session_id] = TranscriptTail(path)
            return tail.update(ts)

    def session_telemetry(self, session_id: str) -> SessionTelemetry | None:
        """Status line data when present (it wins when fresher), else the transcript estimate."""
        live = self.sessions.get(session_id)
        tail = self._tails.get(session_id)
        est = tail.snapshot.telemetry if tail is not None else None
        if live is None:
            return est
        if est is None or live.updated_at >= est.updated_at:
            if est is None:
                return live
            # Fill gaps (e.g. an older Claude Code without a context block) from the estimate.
            patch = {
                k: v
                for k, v in est.model_dump(exclude={"source", "updated_at"}).items()
                if getattr(live, k) is None and v is not None
            }
            return live.model_copy(update=patch) if patch else live
        return est

    def _estimated_sessions(self) -> list[TailSnapshot]:
        """Transcript snapshots for sessions the status line does not cover."""
        return [t.snapshot for sid, t in list(self._tails.items()) if sid not in self.sessions]

    def session_activity(self, session_id: str, now: float | None = None) -> SessionActivityStats:
        ts = time.time() if now is None else now
        minute = int(ts // 60)
        act = self._act.get(session_id) or _SessionAct()
        return SessionActivityStats(
            events_per_min=[
                act.minutes.get(m, 0) for m in range(minute - SESSION_BUCKETS + 1, minute + 1)
            ],
            tool_mix=cast(dict[PhaseKind, int], dict(act.tool_mix)),
            tool_calls=act.tool_calls,
            subagents_spawned=act.subagents,
            test_runs=act.test_runs,
            test_failures=act.test_failures,
            errors=act.errors,
        )

    def _projected(self, name: str, now: float) -> float | None:
        lim = self._limits.get(name)
        if lim is None:
            return None
        pct, resets = lim
        if resets is None or resets <= now:
            return None
        left = resets - now
        dq = self._samples[name]
        rate: float | None = None
        if dq:
            cutoff = now - BURN_LOOKBACK_S
            first = next((s for s in dq if s[0] >= cutoff), dq[0])
            span = dq[-1][0] - first[0]
            if span >= MIN_BURN_SPAN_S:
                rate = max(0.0, (dq[-1][1] - first[1]) / span)
        if rate is None:  # fall back to the pace over the whole window
            total = WINDOW_LEN_S[name]
            gone = total - left
            if gone >= total / 10:
                rate = pct / gone
        if rate is None:
            return None
        return round(min(max(pct + rate * left, pct), 999.0), 1)

    def _window(self, name: str, now: float) -> RateLimitWindow | None:
        lim = self._limits.get(name)
        if lim is None:
            return None
        resets = lim[1]
        if resets is not None and resets <= now:
            return None  # that window is over; wait for a fresh report
        return RateLimitWindow(
            used_pct=lim[0],
            resets_at=_iso_epoch(resets),
            projected_pct=self._projected(name, now),
        )

    def stats(
        self,
        sessions_by_status: dict[str, int],
        active_subagents: int,
        now: float | None = None,
    ) -> CampusStats:
        ts = time.time() if now is None else now
        self._roll_day(ts)
        minute = int(ts // 60)
        b5 = int(ts // 300)
        est = self._estimated_sessions()
        today = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
        cost5 = dict(self._cost5)
        for snap in est:
            for k, v in snap.cost_by_bucket.items():
                cost5[k] = cost5.get(k, 0.0) + v
        series = [
            round(max(cost5.get(k, 0.0), 0.0), 4) for k in range(b5 - COST_BUCKETS + 1, b5 + 1)
        ]
        last_hour = sum(max(cost5.get(k, 0.0), 0.0) for k in range(b5 - 11, b5 + 1))
        cost_today = self._cost_today + sum(x.cost_by_day.get(today, 0.0) for x in est)
        added_today = self._added_today + sum(x.added_by_day.get(today, 0) for x in est)
        removed_today = self._removed_today + sum(x.removed_by_day.get(today, 0) for x in est)
        return CampusStats(
            five_hour=self._window("five_hour", ts),
            seven_day=self._window("seven_day", ts),
            cost_today_usd=round(cost_today, 4),
            burn_usd_per_hour=round(last_hour, 4),
            sessions_by_status=sessions_by_status,
            active_subagents=active_subagents,
            events_per_min=[
                self._building.get(m, 0) for m in range(minute - BUILDING_BUCKETS + 1, minute + 1)
            ],
            cost_series=series,
            lines_added_today=added_today,
            lines_removed_today=removed_today,
            updated_at=datetime.fromtimestamp(ts, UTC).isoformat(),
        )


def _delta(new: float | None, old: float | None, fresh: bool) -> float:
    """Increase of a per-session counter; resets (resume/restart) count from zero."""
    if new is None:
        return 0.0
    if old is None:
        return new if fresh else 0.0
    return new - old if new >= old else new


def _str(v: Any) -> str | None:
    return v if isinstance(v, str) and v else None


def _repo(payload: dict[str, Any]) -> str | None:
    owner = _dig(payload, "workspace", "repo", "owner")
    name = _dig(payload, "workspace", "repo", "name")
    if isinstance(owner, str) and isinstance(name, str) and owner and name:
        return f"{owner}/{name}"
    return None


_store: TelemetryStore | None = None


def get_telemetry_store() -> TelemetryStore:
    global _store
    if _store is None:
        _store = TelemetryStore(get_settings().TELEMETRY_STATE_PATH)
    return _store


def reset_telemetry_store(store: TelemetryStore | None = None) -> None:
    """Swap the process-wide store (tests)."""
    global _store
    _store = store
