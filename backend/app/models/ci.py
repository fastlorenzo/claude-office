"""Projects (one team room per repo) and CI/CD models for the ``/ws/campus`` feed."""

from __future__ import annotations

from typing import Literal, cast

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

__all__ = [
    "CampusProject",
    "CheckKind",
    "CheckRun",
    "CheckState",
    "CheckSummary",
    "LocalCommit",
    "LocalGitState",
    "LocalWorktree",
    "PipelineRun",
    "PrLabel",
    "PullRequestInfo",
    "ReleaseInfo",
]

_CFG = ConfigDict(alias_generator=to_camel, populate_by_name=True)

CheckState = Literal["none", "queued", "running", "success", "failure", "cancelled"]
CheckKind = Literal["test", "build", "lint", "security", "deploy", "release", "other"]


class CheckRun(BaseModel):
    model_config = _CFG

    name: str
    state: CheckState
    started_at: str | None = None
    duration_s: float | None = None
    url: str | None = None
    kind: CheckKind = "other"
    attempt: int | None = None  # >1 when the same check name ran more than once
    flaky: bool = False  # failed at least once, then passed on a re-run


class CheckSummary(BaseModel):
    model_config = _CFG

    state: CheckState = "none"  # failure > running > queued > cancelled/success > none
    total: int = 0
    passed: int = 0
    failed: int = 0
    pending: int = 0
    runs: list[CheckRun] = Field(default_factory=lambda: cast(list[CheckRun], []))  # <= 12


class PrLabel(BaseModel):
    model_config = _CFG

    name: str
    color: str | None = None  # "#rrggbb"


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
    base_branch: str | None = None
    additions: int | None = None
    deletions: int | None = None
    changed_files: int | None = None
    labels: list[PrLabel] = Field(default_factory=lambda: cast(list[PrLabel], []))
    bot: bool = False  # dependabot / renovate / github-actions author
    conflict: bool = False  # mergeable == CONFLICTING
    stale: bool = False  # open and not updated for more than CI_STALE_PR_DAYS
    flaky: bool = False  # any check on this PR is flaky
    created_at: str | None = None
    merged_at: str | None = None
    closed_at: str | None = None


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
    event: str | None = None
    head_sha: str | None = None
    attempt: int | None = None
    flaky: bool = False  # succeeded, but only on attempt > 1


class ReleaseInfo(BaseModel):
    model_config = _CFG

    tag: str
    name: str | None = None
    published_at: str | None = None
    prerelease: bool = False
    url: str | None = None


class LocalCommit(BaseModel):
    model_config = _CFG

    hash: str
    message: str
    at: str


class LocalWorktree(BaseModel):
    model_config = _CFG

    path: str
    branch: str | None = None
    session_id: str | None = None
    dirty_files: int = 0
    ahead: int = 0


class LocalGitState(BaseModel):
    model_config = _CFG

    branch: str | None = None
    ahead: int = 0
    behind: int = 0
    dirty_files: int = 0
    unpushed: int = 0  # commits on local branches that exist on no remote
    branches: list[str] = Field(default_factory=lambda: cast(list[str], []))  # checked-out
    last_commit: LocalCommit | None = None
    worktrees: list[LocalWorktree] = Field(default_factory=lambda: cast(list[LocalWorktree], []))


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
    main_health: CheckState = "none"  # newest CI run on the default branch
    releases: list[ReleaseInfo] = Field(default_factory=lambda: cast(list[ReleaseInfo], []))  # <= 5
    local_git: LocalGitState | None = None
    stale: bool = False  # last fetch failed, data is last-good
    ci_error: str | None = None
    fetched_at: str | None = None
    pinned: bool = False  # shown because of the pinned-repos setting
