"""Demo files: recorded or hand-written event streams played back as a simulation.

Format (JSON Lines, UTF-8, ``.jsonl``)::

    {"claude_office_demo": 1, "name": "Checkout refactor", "max_gap": 3}
    {"t": 0, "event_type": "session_start", "data": {"project_name": "Acme"}}
    {"t": 1.5, "event_type": "user_prompt_submit", "data": {"prompt": "Add Apple Pay"}}
    {"delay": 0.8, "event_type": "pre_tool_use", "data": {"tool_name": "Read", ...}}

- The header line is optional. ``speed`` and ``max_gap`` in it are playback
  defaults (the CLI flags / upload query parameters override them).
- Each event needs ``event_type`` (a hook event type, see ``EventType``) and may
  carry ``data`` (the hook payload, as the simulation scenarios send it).
- Timing: ``t`` is seconds since the start, ``delay`` seconds after the previous
  event; with neither, the event follows the previous one after 0.5 s.
- ``session_id`` is optional. Playback renames the file's sessions to
  ``<base>``, ``<base>_2``, ... (default base ``demo_session``) so a demo never
  writes into a real session, and replaying it again reuses the same room.
- Blank lines and lines starting with ``#`` are ignored.

An exported session (``GET /api/v1/sessions/{id}/export``) is a valid demo
file. Export drops transcript paths (they would not exist on another machine)
and empty fields, but keeps prompts, commands and file paths: review a real
session's export before sharing it.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, cast

from pydantic import ValidationError

from app.models.events import EventAdapter, EventType

DEMO_FORMAT = 1
HEADER_KEY = "claude_office_demo"
MAX_DEMO_BYTES = 20 * 1024 * 1024
MAX_DEMO_EVENTS = 50_000
DEFAULT_GAP = 0.5
# Real sessions idle for minutes while Claude thinks or the user reads; an
# exported demo compresses those pauses by default.
EXPORT_MAX_GAP = 3.0
DEFAULT_SESSION_BASE = "demo_session"
# Machine-specific fields an export leaves out.
STRIP_KEYS = frozenset({"transcript_path", "agent_transcript_path", "wsl_distro"})

_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_EVENT_TYPES = frozenset(e.value for e in EventType)


class DemoFileError(ValueError):
    """The demo file is malformed (the message names the line)."""


@dataclass
class DemoEvent:
    """One event of a demo, ``t`` seconds after the first."""

    t: float
    event_type: str
    session_id: str
    data: dict[str, Any] = field(default_factory=dict[str, Any])


@dataclass
class Demo:
    """A parsed demo file."""

    events: list[DemoEvent]
    name: str = ""
    speed: float | None = None
    max_gap: float | None = None


def _number(value: Any, what: str, line: int, *, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise DemoFileError(f"line {line}: {what} must be a number")
    number = float(value)
    if not math.isfinite(number) or number < minimum:
        raise DemoFileError(f"line {line}: {what} must be >= {minimum:g}")
    return number


def parse_demo(text: str) -> Demo:
    """Parse and validate a demo file.

    Raises:
        DemoFileError: on the first malformed line, or when there is no event.
    """
    if len(text.encode("utf-8", errors="replace")) > MAX_DEMO_BYTES:
        raise DemoFileError(f"demo file is larger than {MAX_DEMO_BYTES // (1024 * 1024)} MB")
    demo = Demo(events=[])
    clock = 0.0
    for number, raw in enumerate(text.lstrip("﻿").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            obj: Any = json.loads(line)
        except json.JSONDecodeError as exc:
            raise DemoFileError(f"line {number}: not valid JSON ({exc.msg})") from None
        if not isinstance(obj, dict):
            raise DemoFileError(f"line {number}: expected a JSON object")
        entry = cast(dict[str, Any], obj)
        if HEADER_KEY in entry:
            _apply_header(demo, entry, number)
            continue
        clock = _event_time(entry, clock, number, first=not demo.events)
        demo.events.append(_parse_event(entry, clock, number))
        if len(demo.events) > MAX_DEMO_EVENTS:
            raise DemoFileError(f"demo file has more than {MAX_DEMO_EVENTS} events")
    if not demo.events:
        raise DemoFileError("demo file contains no events")
    return demo


def _apply_header(demo: Demo, entry: dict[str, Any], line: int) -> None:
    version = entry[HEADER_KEY]
    if not isinstance(version, int) or isinstance(version, bool) or version > DEMO_FORMAT:
        raise DemoFileError(f"line {line}: unsupported demo format {version!r}")
    name = entry.get("name")
    if isinstance(name, str):
        demo.name = name[:200]
    if entry.get("speed") is not None:
        demo.speed = _number(entry["speed"], "speed", line, minimum=0.01)
    if entry.get("max_gap") is not None:
        demo.max_gap = _number(entry["max_gap"], "max_gap", line)


def _event_time(entry: dict[str, Any], clock: float, line: int, *, first: bool) -> float:
    if entry.get("t") is not None:
        t = _number(entry["t"], "t", line)
        if t < clock:
            raise DemoFileError(f"line {line}: t={t:g} is before the previous event ({clock:g})")
        return t
    if entry.get("delay") is not None:
        return clock + _number(entry["delay"], "delay", line)
    return clock if first else clock + DEFAULT_GAP


def _parse_event(entry: dict[str, Any], t: float, line: int) -> DemoEvent:
    event_type = entry.get("event_type")
    if not isinstance(event_type, str) or event_type not in _EVENT_TYPES:
        raise DemoFileError(f"line {line}: unknown event_type {event_type!r}")
    session_id = entry.get("session_id", DEFAULT_SESSION_BASE)
    if not isinstance(session_id, str) or not _SESSION_ID_RE.match(session_id):
        raise DemoFileError(f"line {line}: invalid session_id {session_id!r}")
    raw_data = entry.get("data", {})
    if not isinstance(raw_data, dict):
        raise DemoFileError(f"line {line}: data must be a JSON object")
    data = cast(dict[str, Any], raw_data)
    try:
        EventAdapter.validate_python(
            {
                "event_type": event_type,
                "session_id": session_id,
                "timestamp": "2026-01-01T00:00:00Z",
                "data": data,
            }
        )
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(str(p) for p in first.get("loc", ()))
        detail = f"{where}: {first['msg']}"
        raise DemoFileError(f"line {line}: invalid {event_type} data ({detail})") from None
    return DemoEvent(t=t, event_type=event_type, session_id=session_id, data=data)


def rename_sessions(events: list[DemoEvent], base: str = DEFAULT_SESSION_BASE) -> list[str]:
    """Rename the demo's sessions to ``base``, ``base_2``, ... in order of appearance.

    Returns the new session ids. Raises ``DemoFileError`` for an unusable base.
    """
    if not _SESSION_ID_RE.match(base) or len(base) > 120:
        raise DemoFileError(f"invalid session id {base!r}")
    mapping: dict[str, str] = {}
    for event in events:
        if event.session_id not in mapping:
            n = len(mapping) + 1
            mapping[event.session_id] = base if n == 1 else f"{base}_{n}"
        event.session_id = mapping[event.session_id]
    return list(mapping.values())


def playback_gaps(
    events: list[DemoEvent], speed: float = 1.0, max_gap: float | None = None
) -> list[float]:
    """Seconds to wait before each event (first is 0), capped then sped up."""
    gaps: list[float] = []
    previous = events[0].t if events else 0.0
    for event in events:
        gap = event.t - previous
        previous = event.t
        if max_gap is not None:
            gap = min(gap, max_gap)
        gaps.append(gap / speed)
    return gaps


def play(
    demo: Demo,
    send: Callable[[DemoEvent], None],
    *,
    speed: float | None = None,
    max_gap: float | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Send the demo's events with their timing. Arguments override the header."""
    effective_speed = speed if speed is not None else (demo.speed or 1.0)
    effective_gap = max_gap if max_gap is not None else demo.max_gap
    for gap, event in zip(
        playback_gaps(demo.events, effective_speed, effective_gap), demo.events, strict=True
    ):
        if gap > 0:
            sleep(gap)
        send(event)


def _clean(value: Any) -> Any:
    """Drop ``None`` values recursively (stored payloads carry every field)."""
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in cast(dict[str, Any], value).items() if v is not None}
    if isinstance(value, list):
        return [_clean(v) for v in cast(list[Any], value)]
    return value


def _naive_utc(timestamp: datetime) -> datetime:
    """SQLite hands back naive datetimes; normalize aware ones to match."""
    if timestamp.tzinfo is None:
        return timestamp
    return timestamp.astimezone(UTC).replace(tzinfo=None)


def export_lines(
    records: Iterable[tuple[datetime, str, dict[str, Any] | None]],
    *,
    name: str = "",
    source_session: str = "",
) -> Iterator[str]:
    """Serialize stored ``(timestamp, event_type, data)`` rows as a demo file."""
    header: dict[str, Any] = {HEADER_KEY: DEMO_FORMAT, "name": name, "max_gap": EXPORT_MAX_GAP}
    if source_session:
        header["source_session"] = source_session
    yield json.dumps(header, ensure_ascii=False) + "\n"
    start: datetime | None = None
    last = 0.0
    stopped: set[str] = set()
    for timestamp, event_type, data in records:
        if event_type not in _EVENT_TYPES:
            continue
        agent_id = (data or {}).get("agent_id")
        if event_type == "subagent_stop" and isinstance(agent_id, str):
            stopped.add(agent_id)
        elif event_type == "cleanup" and agent_id in stopped:
            # The backend persists a CLEANUP after each SUBAGENT_STOP and
            # would make it again on playback.
            continue
        timestamp = _naive_utc(timestamp)
        if start is None:
            start = timestamp
        # Rows are ordered by timestamp, but keep t monotonic regardless.
        last = max(last, round((timestamp - start).total_seconds(), 3))
        payload = {k: v for k, v in (_clean(data or {})).items() if k not in STRIP_KEYS}
        line = {"t": last, "event_type": event_type, "data": payload}
        yield json.dumps(line, ensure_ascii=False, default=str) + "\n"
