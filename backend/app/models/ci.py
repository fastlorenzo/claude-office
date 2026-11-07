"""Projects (one team room per repo) and CI/CD models for the ``/ws/campus`` feed."""

from __future__ import annotations

from typing import Literal, cast

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

__all__ = [
    "CampusProject",
    "CheckRun",
    "CheckState",
    "CheckSummary",
    "PipelineRun",
    "PullRequestInfo",
]

_CFG = ConfigDict(alias_generator=to_camel, populate_by_name=True)

CheckState = Literal["none", "queued", "running", "success", "failure", "cancelled"]


class CheckRun(BaseModel):
    model_config = _CFG

    name: str
    state: CheckState
    started_at: str | None = None
    duration_s: float | None = None
    url: str | None = None


class CheckSummary(BaseModel):
    model_config = _CFG

    state: CheckState = "none"  # failure > running > queued > cancelled/success > none
    total: int = 0
    passed: int = 0
    failed: int = 0
    pending: int = 0
    runs: list[CheckRun] = Field(default_factory=lambda: cast(list[CheckRun], []))  # <= 12


class PullRequestInfo(BaseModel):
    model_config = _CFG

    number: int
    title: str
    branch: str
    author: str | None = None
    url: str | None = None
    draft: bool = False
    state: Literal["open", "merged", "closed"]
    review_decision: Literal["approved", "changes_requested", "review_required"] | None = None
    mergeable: Literal["mergeable", "conflicting", "unknown"] | None = None
    checks: CheckSummary = Field(default_factory=CheckSummary)
    session_id: str | None = None
    updated_at: str


class PipelineRun(BaseModel):
    model_config = _CFG

    id: str
    workflow: str
    kind: Literal["ci", "deploy", "release", "other"] = "other"
    branch: str | None = None
    state: CheckState = "none"
    started_at: str | None = None
    duration_s: float | None = None
    url: str | None = None


class CampusProject(BaseModel):
    model_config = _CFG

    id: str  # "owner/name" when the origin remote is GitHub, else the repo root path
    name: str
    repo: str | None = None
    default_branch: str | None = None
    session_ids: list[str] = Field(default_factory=lambda: cast(list[str], []))
    pull_requests: list[PullRequestInfo] = Field(
        default_factory=lambda: cast(list[PullRequestInfo], [])
    )
    pipelines: list[PipelineRun] = Field(default_factory=lambda: cast(list[PipelineRun], []))
    ci_available: bool = False
    updated_at: str
