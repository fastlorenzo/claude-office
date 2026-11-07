"""Per-session telemetry derived from the Claude Code transcript JSONL.

Fallback for when the statusline tee (``hooks/install.sh --statusline``) is not
installed. Everything here is an ESTIMATE:

* model        last assistant ``message.model`` mapped to a display name.
* context      last (non-sidechain) assistant ``usage``: input + cache_read +
               cache_creation tokens.
* window       1M when the model id carries ``[1m]`` or the context already
               exceeds 200k (it cannot have fit in 200k), else 200k. The
               transcript does not record the window, so a 1M session below 200k
               shows too high a percentage; the statusline overrides it.
* cost         sum of per-message usage x ``PRICING`` (list prices, USD per
               million tokens, see below). Streaming writes the same assistant
               message several times; usage is de-duplicated by ``message.id``.
* lines        added/removed from Edit / Write / MultiEdit tool_use inputs.
* duration     first -> last transcript timestamp.

Files are tailed incrementally: a byte offset per transcript, only complete
lines are consumed, and only assistant lines are JSON-parsed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

from app.models.telemetry import SessionTelemetry

logger = logging.getLogger(__name__)

__all__ = [
    "PRICING",
    "TranscriptTail",
    "context_window_for",
    "display_model",
    "estimate_cost",
    "refresh_transcript_telemetry",
]

# Never read further back than this on the first read of a (huge) transcript.
INITIAL_MAX_BYTES = 128 * 1024 * 1024
_KEEP_DAYS = 3
_KEEP_BUCKETS = 60  # 5-min buckets (5 h)
_MAX_TRACKED_IDS = 20_000

# USD per million tokens: (input, output). Cache reads are 0.1x input, cache
# writes 1.25x (5 min TTL) or 2x (1 h TTL). Anthropic list prices; first match
# wins, so more specific patterns come first. Update when pricing changes.
PRICING: list[tuple[str, tuple[float, float]]] = [
    ("opus-4-1", (15.0, 75.0)),
    ("opus-4-0", (15.0, 75.0)),
    ("opus-4-2025", (15.0, 75.0)),
    ("claude-3-opus", (15.0, 75.0)),
    ("opus", (5.0, 25.0)),  # Opus 4.5 and newer
    ("sonnet", (3.0, 15.0)),
    ("haiku-4", (1.0, 5.0)),
    ("haiku", (0.8, 4.0)),  # 3.5 and older
]
_DEFAULT_PRICE = (3.0, 15.0)  # unknown model: Sonnet tier

_MODEL_RE = re.compile(r"claude-(opus|sonnet|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?![\d])")
_OLD_MODEL_RE = re.compile(r"claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)")


def display_model(model_id: str | None) -> str | None:
    """ "claude-opus-5-5" -> "Opus 5.5"; unknown ids are returned without "claude-"."""
    if not model_id or model_id.startswith("<"):
        return None
    mid = model_id.lower().replace("[1m]", "")
    m = _MODEL_RE.search(mid)
    if m:
        fam, major, minor = m.group(1), m.group(2), m.group(3)
        return f"{fam.capitalize()} {major}.{minor}" if minor else f"{fam.capitalize()} {major}"
    m = _OLD_MODEL_RE.search(mid)
    if m:
        ver = f"{m.group(1)}.{m.group(2)}" if m.group(2) else m.group(1)
        return f"{m.group(3).capitalize()} {ver}"
    return model_id.removeprefix("claude-")


def price_for(model_id: str | None) -> tuple[float, float]:
    mid = (model_id or "").lower()
    for pat, price in PRICING:
        if pat in mid:
            return price
    return _DEFAULT_PRICE


def estimate_cost(model_id: str | None, usage: dict[str, Any]) -> float:
    """Estimated USD for one assistant message's ``usage`` block."""
    p_in, p_out = price_for(model_id)

    def n(key: str) -> float:
        v = usage.get(key)
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0

    created = n("cache_creation_input_tokens")
    detail = usage.get("cache_creation")
    write_cost = created * 1.25
    if isinstance(detail, dict):
        d = cast(dict[str, Any], detail)
        h1, m5 = d.get("ephemeral_1h_input_tokens"), d.get("ephemeral_5m_input_tokens")
        if isinstance(h1, (int, float)) and isinstance(m5, (int, float)):
            write_cost = float(m5) * 1.25 + float(h1) * 2.0
    total = (
        n("input_tokens") * p_in
        + n("cache_read_input_tokens") * p_in * 0.1
        + write_cost * p_in
        + n("output_tokens") * p_out
    )
    return total / 1_000_000


def context_window_for(model_id: str | None, tokens: int | None) -> int:
    if model_id and "[1m]" in model_id.lower():
        return 1_000_000
    if tokens is not None and tokens > 200_000:
        return 1_000_000
    return 200_000


def _parse_ts(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _day(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).strftime("%Y-%m-%d")  # local day


def _nlines(text: Any) -> int:
    if not isinstance(text, str) or not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def _edit_lines(name: str, inp: dict[str, Any]) -> tuple[int, int]:
    if name == "Write":
        return _nlines(inp.get("content")), 0
    if name == "Edit":
        return _nlines(inp.get("new_string")), _nlines(inp.get("old_string"))
    if name == "MultiEdit":
        added = removed = 0
        edits = inp.get("edits")
        if isinstance(edits, list):
            for e in cast(list[Any], edits):
                if isinstance(e, dict):
                    ed = cast(dict[str, Any], e)
                    added += _nlines(ed.get("new_string"))
                    removed += _nlines(ed.get("old_string"))
        return added, removed
    return 0, 0


@dataclass(frozen=True)
class TailSnapshot:
    """Immutable view published after each update (read lock-free by the event loop)."""

    telemetry: SessionTelemetry | None
    cost_by_bucket: dict[int, float]
    cost_by_day: dict[str, float]
    added_by_day: dict[str, int]
    removed_by_day: dict[str, int]


_EMPTY_SNAPSHOT = TailSnapshot(None, {}, {}, {}, {})


@dataclass
class TranscriptTail:
    """Incremental accumulator for one transcript file."""

    path: str
    offset: int = 0
    model_id: str | None = None
    context_tokens: int | None = None
    first_ts: float | None = None
    last_ts: float | None = None
    cost: float = 0.0
    added: int = 0
    removed: int = 0
    # message id -> (cost, 5-min bucket, local day); replaced when a message repeats
    _msgs: dict[str, tuple[float, int, str]] = field(
        default_factory=lambda: cast(dict[str, tuple[float, int, str]], {})
    )
    _tools: dict[str, tuple[int, int, str]] = field(
        default_factory=lambda: cast(dict[str, tuple[int, int, str]], {})
    )
    cost_by_bucket: dict[int, float] = field(default_factory=lambda: cast(dict[int, float], {}))
    cost_by_day: dict[str, float] = field(default_factory=lambda: cast(dict[str, float], {}))
    added_by_day: dict[str, int] = field(default_factory=lambda: cast(dict[str, int], {}))
    removed_by_day: dict[str, int] = field(default_factory=lambda: cast(dict[str, int], {}))
    updated_at: float = 0.0
    snapshot: TailSnapshot = _EMPTY_SNAPSHOT

    def update(self, now: float) -> bool:
        """Consume newly appended complete lines. True when anything changed."""
        try:
            size = os.stat(self.path).st_size
        except OSError:
            return False
        if size < self.offset:  # truncated / rotated: start over
            self._reset()
        if size == self.offset:
            return False
        start = self.offset
        if start == 0 and size > INITIAL_MAX_BYTES:
            start = size - INITIAL_MAX_BYTES
        changed = False
        try:
            with open(self.path, "rb") as fh:
                fh.seek(start)
                pos = start
                if start != self.offset:
                    fh.readline()  # drop the cut first line
                    pos = fh.tell()
                for line in fh:
                    if not line.endswith(b"\n"):
                        break  # partially written: pick it up next time
                    pos += len(line)
                    if self._line(line):
                        changed = True
                self.offset = pos
        except OSError:
            return changed
        if changed:
            self.updated_at = now
            self._prune()
            self.snapshot = TailSnapshot(
                telemetry=self.telemetry(now),
                cost_by_bucket=dict(self.cost_by_bucket),
                cost_by_day=dict(self.cost_by_day),
                added_by_day=dict(self.added_by_day),
                removed_by_day=dict(self.removed_by_day),
            )
        return changed

    def _reset(self) -> None:
        fresh = TranscriptTail(self.path)
        snap = self.snapshot
        self.__dict__.update(fresh.__dict__)
        self.snapshot = snap

    def _line(self, line: bytes) -> bool:
        has_ts = b'"timestamp"' in line
        is_assistant = b'"assistant"' in line
        if not has_ts:
            return False
        if not is_assistant and self.first_ts is not None:
            return False
        try:
            parsed: object = json.loads(line)
        except ValueError:
            return False
        if not isinstance(parsed, dict):
            return False
        rec = cast(dict[str, Any], parsed)
        ts = _parse_ts(rec.get("timestamp"))
        if ts is not None:
            if self.first_ts is None:
                self.first_ts = ts
            if self.last_ts is None or ts > self.last_ts:
                self.last_ts = ts
        if rec.get("type") != "assistant":
            return ts is not None
        msg = rec.get("message")
        if not isinstance(msg, dict):
            return True
        m = cast(dict[str, Any], msg)
        model = m.get("model")
        usage = m.get("usage")
        when = ts if ts is not None else (self.last_ts or 0.0)
        if isinstance(model, str) and not model.startswith("<") and isinstance(usage, dict):
            self._usage(m.get("id"), model, cast(dict[str, Any], usage), when)
            if rec.get("isSidechain") is not True:
                u = cast(dict[str, Any], usage)
                ctx = sum(
                    int(u.get(k) or 0)
                    for k in (
                        "input_tokens",
                        "cache_read_input_tokens",
                        "cache_creation_input_tokens",
                    )
                    if isinstance(u.get(k), (int, float))
                )
                self.context_tokens = ctx
                self.model_id = model
        content = m.get("content")
        if isinstance(content, list):
            for block in cast(list[Any], content):
                if isinstance(block, dict):
                    self._tool(cast(dict[str, Any], block), when)
        return True

    def _usage(self, msg_id: Any, model: str, usage: dict[str, Any], when: float) -> None:
        cost = estimate_cost(model, usage)
        key = msg_id if isinstance(msg_id, str) else f"anon{len(self._msgs)}"
        bucket, day = int(when // 300), _day(when)
        old = self._msgs.get(key)
        if old is not None:
            self.cost -= old[0]
            self.cost_by_bucket[old[1]] = self.cost_by_bucket.get(old[1], 0.0) - old[0]
            self.cost_by_day[old[2]] = self.cost_by_day.get(old[2], 0.0) - old[0]
        self._msgs[key] = (cost, bucket, day)
        self.cost += cost
        self.cost_by_bucket[bucket] = self.cost_by_bucket.get(bucket, 0.0) + cost
        self.cost_by_day[day] = self.cost_by_day.get(day, 0.0) + cost
        if len(self._msgs) > _MAX_TRACKED_IDS:
            self._msgs.pop(next(iter(self._msgs)))

    def _tool(self, block: dict[str, Any], when: float) -> None:
        if block.get("type") != "tool_use":
            return
        name, tid, inp = block.get("name"), block.get("id"), block.get("input")
        if not isinstance(name, str) or not isinstance(inp, dict) or not isinstance(tid, str):
            return
        if name not in ("Edit", "Write", "MultiEdit") or tid in self._tools:
            return
        added, removed = _edit_lines(name, cast(dict[str, Any], inp))
        day = _day(when)
        self._tools[tid] = (added, removed, day)
        self.added += added
        self.removed += removed
        self.added_by_day[day] = self.added_by_day.get(day, 0) + added
        self.removed_by_day[day] = self.removed_by_day.get(day, 0) + removed
        if len(self._tools) > _MAX_TRACKED_IDS:
            self._tools.pop(next(iter(self._tools)))

    def _prune(self) -> None:
        if self.cost_by_bucket:
            newest = max(self.cost_by_bucket)
            for k in [k for k in self.cost_by_bucket if k < newest - _KEEP_BUCKETS]:
                del self.cost_by_bucket[k]
        for d in (self.cost_by_day, self.added_by_day, self.removed_by_day):
            for k in sorted(d)[:-_KEEP_DAYS]:
                del d[k]

    def telemetry(self, now: float) -> SessionTelemetry | None:
        """The estimated :class:`SessionTelemetry` (None before any usage was seen)."""
        if self.model_id is None and self.cost == 0.0:
            return None
        window = context_window_for(self.model_id, self.context_tokens)
        pct = (
            round(min(self.context_tokens / window * 100, 100.0), 1)
            if self.context_tokens is not None
            else None
        )
        dur = (
            int((self.last_ts - self.first_ts) * 1000)
            if self.first_ts is not None and self.last_ts is not None
            else None
        )
        return SessionTelemetry(
            model=display_model(self.model_id),
            context_used_pct=pct,
            context_tokens=self.context_tokens,
            context_window=window if self.context_tokens is not None else None,
            cost_usd=round(self.cost, 4),
            lines_added=self.added,
            lines_removed=self.removed,
            duration_ms=dur,
            source="transcript",
            updated_at=datetime.fromtimestamp(self.updated_at or now, UTC).isoformat(),
        )


async def refresh_transcript_telemetry(session_id: str, transcript_path: str | None) -> bool:
    """Tail the session transcript into the telemetry store (never raises)."""
    if not transcript_path:
        return False
    from app.config import get_settings
    from app.core.path_utils import is_safe_transcript_path
    from app.core.telemetry import get_telemetry_store

    try:
        path = Path(get_settings().translate_path(transcript_path)).expanduser()
        if not is_safe_transcript_path(path):
            return False
        store = get_telemetry_store()
        return await asyncio.to_thread(store.refresh_transcript, session_id, str(path))
    except Exception:
        logger.debug("Transcript telemetry refresh failed", exc_info=True)
        return False
