"""Status line telemetry: ingestion, cost deltas, projection, activity, persistence, API."""

# pyright: reportPrivateUsage=false

import json
import time
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.state_machine import StateMachine
from app.core.telemetry import TelemetryStore, get_telemetry_store, reset_telemetry_store
from app.main import app
from app.models.campus import build_campus
from app.models.events import EventType, ToolEvent, ToolEventData

T0 = 1_800_000_000.0


def _payload(
    sid: str = "s1", cost: float = 1.0, dur: int = 1000, pct: float | None = None, **kw: Any
) -> dict[str, Any]:
    p: dict[str, Any] = {
        "session_id": sid,
        "model": {"display_name": "Opus 5.5"},
        "effort": {"level": "high"},
        "context_window": {
            "used_percentage": 19,
            "context_window_size": 1_000_000,
            "total_input_tokens": 191_000,
        },
        "cost": {
            "total_cost_usd": cost,
            "total_lines_added": kw.get("added", 10),
            "total_lines_removed": kw.get("removed", 2),
            "total_duration_ms": dur,
        },
        "prompt_cache": {"warm": False, "expires_at": T0 + 300},
        "workspace": {"repo": {"owner": "o", "name": "r"}},
    }
    if pct is not None:
        p["rate_limits"] = {
            "five_hour": {"used_percentage": pct, "resets_at": kw.get("resets", T0 + 3 * 3600)},
            "seven_day": {"used_percentage": 10, "resets_at": T0 + 3 * 86400},
        }
    return p


def test_session_fields_mapped() -> None:
    st = TelemetryStore(None)
    st.ingest_statusline(_payload(pct=20), now=T0)
    t = st.session_telemetry("s1")
    assert t is not None
    assert (t.model, t.effort, t.context_used_pct, t.context_tokens) == (
        "Opus 5.5",
        "high",
        19,
        191000,
    )
    assert t.cache_warm is False and t.repo == "o/r" and t.cost_usd == 1.0
    assert t.cache_expires_at is not None
    dumped = t.model_dump(by_alias=True)
    assert "contextUsedPct" in dumped and "updatedAt" in dumped


def test_cost_deltas_resume_and_old_sessions() -> None:
    st = TelemetryStore(None)
    st.ingest_statusline(_payload("old", cost=50.0, dur=3_600_000), now=T0)  # baseline only
    st.ingest_statusline(_payload("old", cost=51.5, dur=3_700_000), now=T0 + 60)
    st.ingest_statusline(_payload("new", cost=0.2, dur=5_000), now=T0 + 61)  # fresh: counts
    st.ingest_statusline(_payload("new", cost=0.5, dur=65_000), now=T0 + 120)
    st.ingest_statusline(_payload("new", cost=0.1, dur=1_000), now=T0 + 180)  # resumed: reset
    s = st.stats({}, 0, now=T0 + 200)
    assert s.cost_today_usd == pytest.approx(1.5 + 0.5 + 0.1)
    assert sum(s.cost_series) == pytest.approx(2.1)
    assert len(s.cost_series) == 36
    assert s.burn_usd_per_hour == pytest.approx(2.1)


def test_day_rollover_resets_today() -> None:
    st = TelemetryStore(None)
    st.ingest_statusline(_payload("a", cost=1.0, dur=1000), now=T0)
    assert st.stats({}, 0, now=T0 + 10).cost_today_usd == pytest.approx(1.0)
    assert st.stats({}, 0, now=T0 + 2 * 86400).cost_today_usd == 0.0


def test_projection_from_recent_burn_and_fallbacks() -> None:
    st = TelemetryStore(None)
    resets = T0 + 3600 + 3600  # 2h left
    st.ingest_statusline(_payload(pct=10, resets=resets), now=T0)
    # one sample only, 3h elapsed of 5h -> pace fallback: 10% over 3h -> +6.67 over 2h
    w = st.stats({}, 0, now=T0 + 10).five_hour
    assert w is not None and w.projected_pct == pytest.approx(10 + 10 / 10800 * 7190, abs=0.5)
    st.ingest_statusline(_payload(pct=20, resets=resets), now=T0 + 1800)  # +10% in 30 min
    w = st.stats({}, 0, now=T0 + 1800).five_hour
    assert w is not None and w.used_pct == 20
    # burn 10%/1800s over remaining 5400s -> +30
    assert w.projected_pct == pytest.approx(50.0, abs=0.5)
    # window reset clears history
    st.ingest_statusline(_payload(pct=1, resets=resets + 18000), now=T0 + 1900)
    assert len(st._samples["five_hour"]) == 1
    # expired window is dropped
    assert st.stats({}, 0, now=resets + 18010).five_hour is None


def test_activity_counters() -> None:
    st = TelemetryStore(None)

    def ev(t: EventType, tool: str, cmd: str | None = None, ok: bool | None = None) -> ToolEvent:
        return ToolEvent(
            event_type=t,  # pyright: ignore[reportArgumentType]
            session_id="s1",
            data=ToolEventData(
                tool_name=tool, tool_input={"command": cmd} if cmd else None, success=ok
            ),
        )

    st.record_event("s1", ev(EventType.PRE_TOOL_USE, "Edit"), now=T0)
    st.record_event("s1", ev(EventType.PRE_TOOL_USE, "Bash", "pytest -q"), now=T0)
    st.record_event("s1", ev(EventType.POST_TOOL_USE, "Bash", "pytest -q", ok=False), now=T0 + 61)
    a = st.session_activity("s1", now=T0 + 61)
    assert a.tool_calls == 2 and a.tool_mix == {"coding": 1, "testing": 1}
    assert (a.test_runs, a.test_failures, a.errors) == (1, 1, 1)
    assert len(a.events_per_min) == 30 and a.events_per_min[-1] == 1 and a.events_per_min[-2] == 2
    b = st.stats({}, 0, now=T0 + 61)
    assert len(b.events_per_min) == 60 and sum(b.events_per_min) == 3


def test_persistence_roundtrip(tmp_path: Path) -> None:
    path = str(tmp_path / "t.json")
    st = TelemetryStore(path)
    now = time.time()
    st.ingest_statusline(_payload("a", cost=2.0, dur=1000, pct=30), now=now)
    st.save(force=True)
    st2 = TelemetryStore(path)
    s = st2.stats({}, 0, now=now + 1)
    assert s.cost_today_usd == pytest.approx(2.0)
    assert sum(s.cost_series) == pytest.approx(2.0)
    assert s.five_hour is not None and s.five_hour.used_pct == 30
    # baseline survives: a continuing session adds only the delta
    st2.ingest_statusline(_payload("a", cost=2.5, dur=900_000), now=now + 2)
    assert st2.stats({}, 0, now=now + 3).cost_today_usd == pytest.approx(2.5)
    (tmp_path / "t.json").write_text("garbage")
    assert TelemetryStore(path).stats({}, 0).cost_today_usd == 0.0


def test_campus_carries_telemetry_activity_and_stats() -> None:
    st = get_telemetry_store()
    st.ingest_statusline(_payload("c1", pct=15))
    sm = StateMachine()
    camp = build_campus({"c1": sm})
    cs = camp.sessions[0]
    assert cs.telemetry is not None and cs.telemetry.model == "Opus 5.5"
    assert cs.activity is not None and len(cs.activity.events_per_min) == 30
    assert camp.stats is not None and camp.stats.sessions_by_status
    d = camp.model_dump(mode="json", by_alias=True)
    assert {
        "fiveHour",
        "sevenDay",
        "costTodayUsd",
        "burnUsdPerHour",
        "sessionsByStatus",
        "activeSubagents",
        "eventsPerMin",
        "costSeries",
        "updatedAt",
    } <= set(d["stats"])


def test_endpoint_stores_and_rate_limits_broadcast() -> None:
    reset_telemetry_store(TelemetryStore(None))
    with (
        TestClient(app) as client,
        patch("app.core.event_processor.EventProcessor._schedule_campus_broadcast") as sched,
    ):
        for _ in range(3):
            r = client.post("/api/v1/telemetry/statusline", json=_payload("api-1"))
            assert r.status_code == 200
        assert get_telemetry_store().session_telemetry("api-1") is not None
        assert sched.call_count == 1  # <= 1/s
        r = client.post("/api/v1/telemetry/statusline", json={"session_id": "bad id!", "cost": {}})
        assert r.status_code == 200
        assert get_telemetry_store().session_telemetry("bad id!") is None
    json.dumps({})
