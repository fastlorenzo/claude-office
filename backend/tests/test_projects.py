"""Project grouping: repo toplevel, worktrees -> main repo, GitHub remote parsing."""

from pathlib import Path

import pytest

from app.core.projects import clear_project_cache, parse_github_repo, resolve_project
from app.models.campus import (
    CampusSession,  # noqa: F401
    build_projects,
)


@pytest.fixture(autouse=True)
def _clear() -> None:
    clear_project_cache()


def _repo(path: Path, url: str | None = "https://github.com/acme/widgets.git") -> Path:
    (path / ".git").mkdir(parents=True)
    cfg = "[core]\n\tbare = false\n"
    if url:
        cfg += f'[remote "origin"]\n\turl = {url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    (path / ".git" / "config").write_text(cfg)
    (path / ".git" / "refs" / "remotes" / "origin").mkdir(parents=True)
    (path / ".git" / "refs" / "remotes" / "origin" / "HEAD").write_text(
        "ref: refs/remotes/origin/trunk\n"
    )
    return path


@pytest.mark.parametrize(
    ("url", "repo"),
    [
        ("https://github.com/o/n.git", "o/n"),
        ("https://user@github.com/o/n", "o/n"),
        ("git@github.com:o/n.git", "o/n"),
        ("ssh://git@github.com/o/n.git", "o/n"),
        ("https://gitlab.com/o/n.git", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_github(url: str | None, repo: str | None) -> None:
    assert parse_github_repo(url) == repo


def test_subdir_resolves_to_toplevel(tmp_path: Path) -> None:
    top = _repo(tmp_path / "widgets")
    (top / "src" / "deep").mkdir(parents=True)
    ref = resolve_project(str(top / "src" / "deep"))
    assert ref is not None
    assert (ref.id, ref.repo, ref.name, ref.default_branch) == (
        "acme/widgets",
        "acme/widgets",
        "widgets",
        "trunk",
    )


def test_worktree_maps_to_main_repo(tmp_path: Path) -> None:
    main = _repo(tmp_path / "widgets")
    wt_git = main / ".git" / "worktrees" / "feat"
    wt_git.mkdir(parents=True)
    wt = tmp_path / "widgets-wt" / "feat"
    wt.mkdir(parents=True)
    (wt / ".git").write_text(f"gitdir: {wt_git}\n")
    a, b = resolve_project(str(main)), resolve_project(str(wt))
    assert a is not None and b is not None
    assert a.id == b.id == "acme/widgets"
    assert b.root == str(main)


def test_non_github_remote_uses_path_id(tmp_path: Path) -> None:
    top = _repo(tmp_path / "local", url="https://gitlab.com/o/n.git")
    ref = resolve_project(str(top))
    assert ref is not None
    assert ref.id == str(top)
    assert ref.repo is None


def test_no_git_and_no_root(tmp_path: Path) -> None:
    assert resolve_project(None) is None
    plain = tmp_path / "plain"
    plain.mkdir()
    assert resolve_project(str(plain)) is None


def test_build_projects_groups_sessions(tmp_path: Path) -> None:
    from datetime import UTC, datetime

    from app.core.ci_poller import CiPoller, reset_ci_poller
    from app.models.agents import Boss, BossState, OfficeState
    from app.models.ci import PullRequestInfo

    top = _repo(tmp_path / "widgets")
    ref = resolve_project(str(top))
    assert ref is not None
    now = datetime.now(UTC)

    def cs(sid: str, branch: str, pid: str | None = ref.id, ended: bool = False) -> CampusSession:
        return CampusSession(
            session_id=sid,
            bucket="working",
            boss=Boss(state=BossState.IDLE),
            agents=[],
            office=OfficeState(),
            project_id=pid,
            git_branch=branch,
            ended=ended,
            last_updated=now,
        )

    poller = CiPoller()
    reset_ci_poller(poller)
    try:
        entry = poller.note_repo("acme/widgets", "trunk")
        entry.available = True
        entry.pull_requests = [
            PullRequestInfo(number=1, title="t", branch="feat-a", state="open", updated_at="x")
        ]
        projects = build_projects(
            [cs("a", "feat-a"), cs("b", "main"), cs("c", "x", ended=True), cs("d", "y", pid=None)],
            now,
        )
    finally:
        reset_ci_poller(None)
    assert len(projects) == 1
    p = projects[0]
    assert p.session_ids == ["a", "b"]
    assert p.ci_available
    assert p.pull_requests[0].session_id == "a"
