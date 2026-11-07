"""Refs, project naming, summary precedence, and the campus payload."""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from app.core import session_summary as ss
from app.core.handlers.conversation_handler import _refresh_summary
from app.core.state_machine import StateMachine
from app.core.summary_service import SummaryService
from app.models.campus import build_campus_session


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"session_name": "cont-839"}, ["CONT-839"]),
        ({"branch": "feat/CONT-839-sso-login-admin"}, ["CONT-839"]),
        ({"branch": "feat/cont-839-sso"}, ["CONT-839"]),
        ({"session_name": "cont-839", "branch": "feat/CONT-839-x"}, ["CONT-839"]),
        ({"objective": "Fix ABC-12 and DEF-7, see utf-8 notes"}, ["ABC-12", "DEF-7"]),
        ({"objective": "handle utf-8 and sha-256"}, []),
        ({"branch": "fix/sha-256-hash"}, []),
        ({"prompts": ["review https://github.com/o/r/pull/412 please"]}, ["#412"]),
        ({"prompts": ["merge PR #9 and PR 9"]}, ["#9"]),
        ({"prompts": ["lowercase abc-12 in prose is ignored"]}, []),
        ({"prompts": ["A-1 B22-3 CC-4 DD-5 EE-6"]}, ["B22-3", "CC-4", "DD-5"]),
        ({}, []),
    ],
)
def test_extract_refs(kwargs: dict[str, object], expected: list[str]) -> None:
    assert ss.extract_refs(**kwargs) == expected  # type: ignore[arg-type]


def test_extract_refs_caps_at_three_in_source_order() -> None:
    refs = ss.extract_refs(
        session_name="aa-1", branch="bb-2", objective="CC-3 DD-4", prompts=["EE-5 PR #6"]
    )
    assert refs == ["AA-1", "BB-2", "CC-3"]


@pytest.mark.parametrize(
    ("branch", "expected"),
    [
        ("feat/sso-login-admin", "SSO login admin"),
        ("feat/CONT-839-sso-login-admin", "SSO login admin"),
        ("fix/parallel_subagent_tracking", "Parallel subagent tracking"),
        ("main", None),
        ("feat/CONT-839", None),
        (None, None),
    ],
)
def test_humanize_branch(branch: str | None, expected: str | None) -> None:
    assert ss.humanize_branch(branch) == expected


def test_summary_precedence() -> None:
    f = ss.resolve_summary
    assert (
        f(
            ai_summary="Add SSO login to admin",
            ai_title="T title here",
            objective="o o o o",
            branch="feat/x-y",
        )
        == "Add SSO login to admin"
    )
    assert f(ai_summary=None, ai_title="Refactor billing webhooks", objective="x", branch=None) == (
        "Refactor billing webhooks"
    )
    assert f(
        ai_summary=None, ai_title=None, objective="CONT-839: Add export button", branch=None
    ) == ("Add export button")
    # Ticket-only / follow-up objectives fall through to the branch.
    for junk in ("CONT-839", "[CONT-839]", "are we done?", "continue", None):
        assert f(
            ai_summary=None, ai_title=None, objective=junk, branch="feat/CONT-1-sso-login"
        ) == ("SSO login")
    assert f(ai_summary=None, ai_title=None, objective="CONT-839", branch="main") is None


def test_summary_is_capped_at_70() -> None:
    out = ss.clean_summary("Add " + "very " * 40 + "long feature")
    assert out is not None
    assert len(out) <= 70


def test_project_name_plain_repo_and_fallback(tmp_path: Path) -> None:
    repo = tmp_path / "continuum"
    (repo / ".git").mkdir(parents=True)
    (repo / "apps" / "web").mkdir(parents=True)
    assert ss.project_name_for_root(str(repo / "apps" / "web"), now=0.0) == "continuum"
    plain = tmp_path / "scratch"
    plain.mkdir()
    assert ss.project_name_for_root(str(plain), now=0.0) == "scratch"
    assert ss.project_name_for_root(None) is None


def test_project_name_worktree_uses_main_repo(tmp_path: Path) -> None:
    main = tmp_path / "continuum"
    (main / ".git" / "worktrees" / "wt1").mkdir(parents=True)
    wt = tmp_path / "feat-sso"
    wt.mkdir()
    (wt / ".git").write_text(f"gitdir: {main}/.git/worktrees/wt1\n")
    assert ss.project_name_for_root(str(wt), now=0.0) == "continuum"


@pytest.mark.asyncio
async def test_ai_summary_refreshes_only_when_objective_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    svc = SummaryService.__new__(SummaryService)
    mock = AsyncMock(return_value="Add SSO login to the admin dashboard")
    monkeypatch.setattr(svc, "summarize_session", mock, raising=False)
    monkeypatch.setattr("app.core.handlers.conversation_handler.get_summary_service", lambda: svc)
    monkeypatch.setattr("app.core.handlers.conversation_handler.broadcast_state", AsyncMock())
    sm = StateMachine()
    sm.first_prompts = ["build sso login for the admin dashboard"]
    sm.objective_prompt_count = 1
    await _refresh_summary(sm, "s", 1, "Build SSO login")
    await _refresh_summary(sm, "s", 1, "Build SSO login")
    assert mock.await_count == 1
    assert sm.summary_ai == "Add SSO login to the admin dashboard"
    await _refresh_summary(sm, "s", 1, "Add audit log")
    assert mock.await_count == 2


@pytest.mark.asyncio
async def test_summarize_session_cleans_ai_output(monkeypatch: pytest.MonkeyPatch) -> None:
    svc = SummaryService.__new__(SummaryService)
    svc.enabled = True
    monkeypatch.setattr(
        svc,
        "_call_with_retry",
        AsyncMock(return_value='"CONT-839: Add SSO login to admin."\nextra'),
    )
    out = await svc.summarize_session(["add sso login to the admin dashboard"], "Add SSO")
    assert out == "Add SSO login to admin"
    svc.enabled = False
    assert await svc.summarize_session(["add sso login"], None) is None


def test_campus_payload_has_identity_fields(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    repo = tmp_path / "continuum"
    (repo / ".git").mkdir(parents=True)
    monkeypatch.setattr(
        "app.services.git_service.git_service.get_session_root", lambda sid: str(repo)
    )
    monkeypatch.setattr(
        "app.services.git_branch.get_branch", lambda root: "feat/CONT-839-sso-login"
    )
    sm = StateMachine()
    sm.custom_title = "cont-839"
    sm.objective = "are we done?"
    sm.turn_active = True
    cs = build_campus_session("s1", sm)
    wire = cs.model_dump(by_alias=True)
    assert wire["project"] == "continuum"
    assert wire["refs"] == ["CONT-839"]
    assert wire["summary"] == "SSO login"
    assert wire["phase"]["kind"] == "planning"
    assert set(wire["phase"]) == {"kind", "label", "detail", "since"}
    assert wire["objective"] == "are we done?"  # untouched fallback
