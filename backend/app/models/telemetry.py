"""Live Claude Code telemetry models (status line tee) for the control room."""

from __future__ import annotations

from typing import cast

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from app.core.session_phase import PhaseKind
from app.models.overview import OverviewBucket

__all__ = [
    "CampusStats",
    "RateLimitWindow",
    "RoomStatus",
    "SessionActivityStats",
    "SessionTelemetry",
]

RoomStatus = OverviewBucket | str  # "needs_you" | "working" | "done" | "ended"

_CFG = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class SessionTelemetry(BaseModel):
    model_config = _CFG

    model: str | None = None
    effort: str | None = None
    context_used_pct: float | None = None
    context_tokens: int | None = None
    context_window: int | None = None
    cost_usd: float | None = None
    lines_added: int | None = None
    lines_removed: int | None = None
    duration_ms: int | None = None
    cache_warm: bool | None = None
    cache_expires_at: str | None = None
    repo: str | None = None
    output_style: str | None = None
    updated_at: str


class RateLimitWindow(BaseModel):
    model_config = _CFG

    used_pct: float
    resets_at: str | None = None
    projected_pct: float | None = None


class SessionActivityStats(BaseModel):
    model_config = _CFG

    events_per_min: list[int] = Field(default_factory=lambda: cast(list[int], []))
    tool_mix: dict[PhaseKind, int] = Field(default_factory=lambda: cast(dict[PhaseKind, int], {}))
    tool_calls: int = 0
    subagents_spawned: int = 0
    test_runs: int = 0
    test_failures: int = 0
    errors: int = 0


class CampusStats(BaseModel):
    model_config = _CFG

    five_hour: RateLimitWindow | None = None
    seven_day: RateLimitWindow | None = None
    cost_today_usd: float | None = None
    burn_usd_per_hour: float | None = None
    sessions_by_status: dict[str, int] = Field(default_factory=lambda: cast(dict[str, int], {}))
    active_subagents: int = 0
    events_per_min: list[int] = Field(default_factory=lambda: cast(list[int], []))
    cost_series: list[float] = Field(default_factory=lambda: cast(list[float], []))
    lines_added_today: int | None = None
    lines_removed_today: int | None = None
    updated_at: str
