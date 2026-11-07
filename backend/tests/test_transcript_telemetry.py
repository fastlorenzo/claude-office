"""Transcript-derived telemetry: parsing, incremental tail, cost, store merge."""

import json
from pathlib import Path
from typing import Any

import pytest

from app.core.telemetry import TelemetryStore
from app.core.transcript_telemetry import (
    TranscriptTail,
    context_window_for,
    display_model,
    estimate_cost,
)

TS = "2026-11-07T10:00:00.000Z"


def _asst(
    mid: str,
    model: str = "claude-opus-5-5",
    usage: dict[str, Any] | None = None,
    ts: str = TS,
    content: list[dict[str, Any]] | None = None,
    side: bool = False,
) -> str:
    return (
        json.dumps(
            {
                "type": "assistant",
                "timestamp": ts,
                "isSidechain": side,
                "message": {
                    "id": mid,
                    "model": model,
                    "usage": usage
                    or {
                        "input_tokens": 10,
                        "cache_read_input_tokens": 1000,
                        "cache_creation_input_tokens": 100,
                        "output_tokens": 50,
                    },
                    "content": content or [],
                },
            }
        )
        + "\n"
    )


class TestModelNames:
    @pytest.mark.parametrize(
        ("raw", "shown"),
        [
            ("claude-opus-5-5", "Opus 5.5"),
            ("claude-sonnet-4-5-20250929", "Sonnet 4.5"),
            ("claude-opus-4-20250514", "Opus 4"),
            ("claude-3-5-sonnet-20241022", "Sonnet 3.5"),
            ("claude-opus-5-5[1m]", "Opus 5.5"),
            ("weird-model", "weird-model"),
            ("<synthetic>", None),
            (None, None),
        ],
    )
    def test_display(self, raw: str | None, shown: str | None) -> None:
        assert display_model(raw) == shown

    def test_window(self) -> None:
        assert context_window_for("claude-opus-5-5", 150_000) == 200_000
        assert context_window_for("claude-opus-5-5", 250_000) == 1_000_000
        assert context_window_for("claude-opus-5-5[1m]", 10) == 1_000_000


class TestCost:
    def test_opus_new(self) -> None:
        usage = {
            "input_tokens": 1_000_000,
            "output_tokens": 1_000_000,
            "cache_read_input_tokens": 1_000_000,
            "cache_creation_input_tokens": 1_000_000,
        }
        # 5 + 25 + 0.5 + 6.25
        assert estimate_cost("claude-opus-5-5", usage) == pytest.approx(36.75)

    def test_cache_1h_write_and_unknown_fallback(self) -> None:
        usage = {
            "cache_creation_input_tokens": 1_000_000,
            "cache_creation": {
                "ephemeral_1h_input_tokens": 1_000_000,
                "ephemeral_5m_input_tokens": 0,
            },
        }
        assert estimate_cost("claude-opus-4-1", usage) == pytest.approx(30.0)  # 15 x 2
        assert estimate_cost("mystery", {"input_tokens": 1_000_000}) == pytest.approx(3.0)


class TestTail:
    def test_parse_dedup_and_context(self, tmp_path: Path) -> None:
        f = tmp_path / "s.jsonl"
        edit = {
            "type": "tool_use",
            "id": "t1",
            "name": "Edit",
            "input": {"old_string": "a\nb", "new_string": "x\ny\nz"},
        }
        write = {"type": "tool_use", "id": "t2", "name": "Write", "input": {"content": "1\n2\n"}}
        f.write_text(
            '{"type":"user","timestamp":"2026-11-07T09:59:00.000Z"}\n'
            + _asst("m1", content=[edit])
            + _asst("m1", content=[edit])  # streamed duplicate
            + _asst("m2", ts="2026-11-07T10:05:00.000Z", content=[write])
        )
        tail = TranscriptTail(str(f))
        assert tail.update(now=1.0)
        t = tail.telemetry(1.0)
        assert t is not None
        assert t.source == "transcript"
        assert t.model == "Opus 5.5"
        assert t.context_tokens == 1110
        assert t.context_window == 200_000
        assert t.context_used_pct == pytest.approx(0.6, abs=0.1)
        assert t.lines_added == 3 + 2
        assert t.lines_removed == 2
        one = estimate_cost("claude-opus-5-5", json.loads(_asst("m"))["message"]["usage"])
        assert t.cost_usd == pytest.approx(round(one * 2, 4))  # m1 once + m2
        assert t.duration_ms == 6 * 60 * 1000  # 09:59 -> 10:05

    def test_incremental_offset_and_partial_line(self, tmp_path: Path) -> None:
        f = tmp_path / "s.jsonl"
        f.write_text(_asst("m1"))
        tail = TranscriptTail(str(f))
        tail.update(1.0)
        first_offset = tail.offset
        assert first_offset == f.stat().st_size
        assert not tail.update(2.0)  # nothing new: no read
        partial = _asst("m2", usage={"input_tokens": 500_000})
        with open(f, "a") as fh:
            fh.write(partial[:-30])
        assert not tail.update(3.0)  # incomplete last line is left alone
        assert tail.offset == first_offset
        with open(f, "a") as fh:
            fh.write(partial[-30:])
        assert tail.update(4.0)
        t = tail.telemetry(4.0)
        assert t is not None
        assert t.context_tokens == 500_000
        assert t.context_window == 1_000_000  # > 200k

    def test_never_rereads_consumed_bytes(self, tmp_path: Path) -> None:
        f = tmp_path / "s.jsonl"
        f.write_text(_asst("m1"))
        tail = TranscriptTail(str(f))
        tail.update(1.0)
        reads: list[int] = []
        real_open = open

        def spy(path: Any, mode: str = "r", *a: Any, **k: Any) -> Any:
            fh = real_open(path, mode, *a, **k)
            if str(path) == str(f):
                real_seek = fh.seek
                fh.seek = lambda off, *x: (reads.append(off), real_seek(off, *x))[1]  # type: ignore[method-assign]
            return fh

        with open(f, "a") as fh:
            fh.write(_asst("m2"))
        import builtins

        orig = builtins.open
        builtins.open = spy  # type: ignore[assignment]
        try:
            tail.update(2.0)
        finally:
            builtins.open = orig
        assert reads == [tail.offset - len(_asst("m2"))]

    def test_truncation_resets(self, tmp_path: Path) -> None:
        f = tmp_path / "s.jsonl"
        f.write_text(_asst("m1") + _asst("m2"))
        tail = TranscriptTail(str(f))
        tail.update(1.0)
        f.write_text(_asst("m3", model="claude-sonnet-4-5"))
        assert tail.update(2.0)
        t = tail.telemetry(2.0)
        assert t is not None
        assert t.model == "Sonnet 4.5"

    def test_sidechain_does_not_set_context(self, tmp_path: Path) -> None:
        f = tmp_path / "s.jsonl"
        f.write_text(
            _asst("m1", usage={"input_tokens": 100})
            + _asst("m2", usage={"input_tokens": 99_999}, side=True)
        )
        tail = TranscriptTail(str(f))
        tail.update(1.0)
        assert tail.context_tokens == 100

    def test_missing_file(self, tmp_path: Path) -> None:
        assert not TranscriptTail(str(tmp_path / "nope.jsonl")).update(1.0)


class TestStoreMerge:
    def _tail_file(self, tmp_path: Path) -> str:
        f = tmp_path / "s.jsonl"
        f.write_text(_asst("m1", ts="2026-11-07T10:00:00.000Z"))
        return str(f)

    def test_transcript_fallback_and_stats(self, tmp_path: Path) -> None:
        store = TelemetryStore()
        path = self._tail_file(tmp_path)
        assert store.refresh_transcript("s1", path, now=1_800_000_000)
        tel = store.session_telemetry("s1")
        assert tel is not None
        assert tel.source == "transcript"
        assert tel.cost_usd is not None
        # today's cost uses the message's local day; use the tail's own day bucket
        day = next(iter(store._tails["s1"].snapshot.cost_by_day))  # type: ignore[reportPrivateUsage]
        assert store._tails["s1"].snapshot.cost_by_day[day] == pytest.approx(  # type: ignore[reportPrivateUsage]
            tel.cost_usd, abs=1e-3
        )

    def test_statusline_wins_when_fresher(self, tmp_path: Path) -> None:
        store = TelemetryStore()
        path = self._tail_file(tmp_path)
        store.refresh_transcript("s1", path, now=1000.0)
        store.ingest_statusline(
            {
                "session_id": "s1",
                "model": {"display_name": "Opus 5.5 (1M)"},
                "cost": {"total_cost_usd": 9.5},
            },
            now=2000.0,
        )
        tel = store.session_telemetry("s1")
        assert tel is not None
        assert tel.source == "statusline"
        assert tel.model == "Opus 5.5 (1M)"
        assert tel.cost_usd == 9.5
        assert tel.context_tokens == 1110  # gap filled from the transcript

    def test_stale_statusline_still_beats_newer_transcript(self, tmp_path: Path) -> None:
        store = TelemetryStore()
        store.ingest_statusline(
            {
                "session_id": "s1",
                "cost": {"total_cost_usd": 199.15, "total_lines_added": 31404},
                "context_window": {
                    "used_percentage": 17,
                    "context_window_size": 1_000_000,
                    "total_input_tokens": 168_000,
                },
            },
            now=1000.0,
        )
        store.refresh_transcript("s1", self._tail_file(tmp_path), now=5000.0)
        tel = store.session_telemetry("s1")
        assert tel is not None
        assert tel.source == "statusline"
        assert tel.cost_usd == 199.15
        assert tel.lines_added == 31404
        assert (tel.context_used_pct, tel.context_tokens, tel.context_window) == (
            17,
            168_000,
            1_000_000,
        )

    def test_subagent_transcript_never_feeds_main_session(self, tmp_path: Path) -> None:
        store = TelemetryStore()
        sub = tmp_path / "sess" / "subagents"
        sub.mkdir(parents=True)
        f = sub / "agent-a1.jsonl"
        f.write_text(Path(self._tail_file(tmp_path)).read_text())
        assert store.refresh_transcript("s1", str(f), now=1.0) is False
        assert store.session_telemetry("s1") is None

    def test_stats_exclude_statusline_sessions(self, tmp_path: Path) -> None:
        store = TelemetryStore()
        store.refresh_transcript("est", self._tail_file(tmp_path), now=1_800_000_000)
        snap = store._tails["est"].snapshot  # type: ignore[reportPrivateUsage]
        day = next(iter(snap.cost_by_day))
        ts = __import__("datetime").datetime.strptime(day, "%Y-%m-%d").replace(hour=12).timestamp()
        stats = store.stats({}, 0, now=ts)
        assert stats.cost_today_usd == pytest.approx(
            next(iter(snap.cost_by_day.values())), abs=1e-3
        )
        # once the status line reports for that session, it is no longer double counted
        store.ingest_statusline({"session_id": "est", "cost": {"total_cost_usd": 0.0}}, now=ts)
        assert store.stats({}, 0, now=ts).cost_today_usd == 0.0
