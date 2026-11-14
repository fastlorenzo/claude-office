"""Git status models for tracking repository state."""

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, cast

from pydantic import BaseModel, Field, field_validator

_CLIENT_LIST_CAP = 500

__all__ = [
    "FileStatus",
    "ChangedFile",
    "Commit",
    "GitStatus",
    "ClientGit",
]


class FileStatus(StrEnum):
    """Git file status codes."""

    MODIFIED = "M"
    ADDED = "A"
    DELETED = "D"
    RENAMED = "R"
    COPIED = "C"
    UNTRACKED = "?"
    IGNORED = "!"


class ChangedFile(BaseModel):
    """A file with changes in the working tree or index."""

    path: str
    status: FileStatus
    staged: bool = False


class Commit(BaseModel):
    """A git commit summary."""

    hash: str = Field(..., description="Short commit hash (7 chars)")
    message: str = Field(..., description="First line of commit message")
    author: str
    timestamp: datetime
    relative_time: str = Field(
        ..., description="Human-readable relative time (e.g., '2 hours ago')"
    )


def _default_changed_files() -> list[ChangedFile]:
    return []


def _default_commits() -> list[Commit]:
    return []


class GitStatus(BaseModel):
    """Current git repository status."""

    branch: str = Field(..., description="Current branch name")
    ahead: int = Field(0, description="Commits ahead of remote")
    behind: int = Field(0, description="Commits behind remote")
    changed_files: list[ChangedFile] = Field(default_factory=_default_changed_files)
    commits: list[Commit] = Field(default_factory=_default_commits, description="Last 10 commits")
    last_updated: datetime = Field(default_factory=lambda: datetime.now(UTC))
    repo_path: str = Field(..., description="Path to the repository")


class ClientGit(BaseModel):
    """Git facts reported by the hook from the machine Claude Code runs on.

    Lets a backend on another machine (or in a container) show a session's
    project, branch and status without seeing its checkout. Paths are the
    client's own (possibly Windows) paths: display only, never opened here.
    """

    root: Annotated[str, Field(max_length=1024)]  # working tree toplevel
    main_root: Annotated[str | None, Field(max_length=1024)] = None  # owning repo toplevel
    repo: Annotated[str | None, Field(max_length=256)] = None  # owner/name for GitHub
    default_branch: Annotated[str | None, Field(max_length=256)] = None
    branch: Annotated[str | None, Field(max_length=256)] = None
    ahead: int = 0
    behind: int = 0
    changed_files: list[ChangedFile] | None = None  # capped by _cap_lists
    commits: list[Commit] | None = None

    @field_validator("changed_files", "commits", mode="before")
    @classmethod
    def _cap_lists(cls, v: Any) -> Any:
        """Keep a misbehaving client from storing huge lists (no tuple types in TS)."""
        if isinstance(v, list):
            return cast(list[Any], v)[:_CLIENT_LIST_CAP]
        return v
