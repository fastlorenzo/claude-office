"""Transcript mirror for remote sessions (app.core.transcript_mirror)."""

import json
import os
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.core import transcript_mirror as tm
from app.core.session_titles import refresh_session_titles
from app.core.state_machine import StateMachine
from app.core.transcript_lookup import resolve_safe_path
from app.main import app
from app.models.events import TranscriptChunk

CLIENT = "/home/u/.claude/projects/-home-u-w/sid-1.jsonl"
WIN_CLIENT = "C:\\Users\\u\\.claude\\projects\\C--Users-u-w\\sid-2.jsonl"


@pytest.fixture(autouse=True)
def _mirror_dir(tmp_path: Path) -> Iterator[Path]:
    settings = get_settings()
    old = settings.TRANSCRIPT_MIRROR_DIR
    settings.TRANSCRIPT_MIRROR_DIR = str(tmp_path / "mirror")
    try:
        yield tmp_path / "mirror"
    finally:
        settings.TRANSCRIPT_MIRROR_DIR = old


def _line(**rec: object) -> str:
    return json.dumps(rec)


def test_mirror_path_layout_and_rejections(_mirror_dir: Path) -> None:
    assert tm.mirror_path(CLIENT) == _mirror_dir / "projects" / "-home-u-w" / "sid-1.jsonl"
    assert tm.mirror_path(WIN_CLIENT) == (_mirror_dir / "projects" / "C--Users-u-w" / "sid-2.jsonl")
    sub = "/h/.claude/projects/p/sid/subagents/agent-a.meta.json"
    assert tm.mirror_path(sub) == _mirror_dir / "projects/p/sid/subagents/agent-a.meta.json"
    for bad in (
        None,
        "/etc/passwd",
        "/h/.claude/projects/p/../../etc/x.jsonl",
        "/h/.claude/projects/p/sid.txt",
        "/h/.claude/projects/sid.jsonl",  # no project dir
        "/h/.claude/projects/p/a b.jsonl",
        "/h/.claude/projects/p/a/b/c/d.jsonl",  # too deep
    ):
        assert tm.mirror_path(bad) is None, bad


def test_apply_chunks_dedupes_and_accepts_gaps(_mirror_dir: Path) -> None:
    a, b, c = _line(n=1), _line(n=2), _line(n=3)
    ends = tm.apply_chunks([TranscriptChunk(path=CLIENT, end=20, lines=[(0, a), (10, b)])])
    assert ends == {CLIENT: 20}
    # Overlapping resend (concurrent hooks): only the new line is appended.
    ends = tm.apply_chunks([TranscriptChunk(path=CLIENT, end=30, lines=[(10, b), (20, c)])])
    assert ends == {CLIENT: 30}
    target = tm.mirror_path(CLIENT)
    assert target is not None
    assert target.read_text().splitlines() == [a, b, c]
    # A stale chunk changes nothing and reports the real end.
    assert tm.apply_chunks([TranscriptChunk(path=CLIENT, end=20, lines=[(10, b)])]) == {CLIENT: 30}
    # A gap (hook started from the tail / backend lost data) is accepted.
    d = _line(n=4)
    assert tm.apply_chunks([TranscriptChunk(path=CLIENT, end=500, lines=[(400, d)])]) == {
        CLIENT: 500
    }
    assert target.read_text().splitlines()[-1] == d
    # Lines-free chunk (everything filtered client-side) still advances the end.
    assert tm.apply_chunks([TranscriptChunk(path=CLIENT, end=600, lines=[])]) == {CLIENT: 600}
    # Invalid paths are ignored.
    assert tm.apply_chunks([TranscriptChunk(path="/etc/x.jsonl", end=1, lines=[(0, a)])]) == {}


def test_apply_meta(_mirror_dir: Path) -> None:
    meta = "/h/.claude/projects/p/sid/subagents/agent-a.meta.json"
    assert tm.apply_chunks([TranscriptChunk(path=meta, content='{"x": 1}')]) == {}
    target = tm.mirror_path(meta)
    assert target is not None and target.read_text() == '{"x": 1}'


def test_translate_path_falls_back_to_mirror(_mirror_dir: Path) -> None:
    settings = get_settings()
    assert settings.translate_path(CLIENT) == CLIENT  # no copy yet
    tm.apply_chunks([TranscriptChunk(path=CLIENT, end=10, lines=[(0, _line(n=1))])])
    assert settings.translate_path(CLIENT) == str(tm.mirror_path(CLIENT))


def test_translate_path_prefers_existing_local_file(tmp_path: Path) -> None:
    local = tmp_path / "projects" / "p" / "sid-1.jsonl"
    local.parent.mkdir(parents=True)
    local.write_text("{}\n")
    tm.apply_chunks([TranscriptChunk(path=str(local), end=3, lines=[(0, "{}")])])
    assert get_settings().translate_path(str(local)) == str(local)


def test_mirror_is_an_allowed_transcript_root(_mirror_dir: Path) -> None:
    tm.apply_chunks([TranscriptChunk(path=CLIENT, end=10, lines=[(0, _line(n=1))])])
    real = resolve_safe_path(CLIENT)
    assert real == os.path.realpath(tm.mirror_path(CLIENT) or "")


@pytest.mark.asyncio
async def test_titles_read_through_mirror(_mirror_dir: Path) -> None:
    tm.apply_chunks(
        [
            TranscriptChunk(
                path=CLIENT,
                end=50,
                lines=[(0, _line(type="custom-title", customTitle="remote name"))],
            )
        ]
    )
    sm = StateMachine()
    assert await refresh_session_titles(sm, CLIENT)
    assert sm.custom_title == "remote name"


def test_events_endpoint_writes_mirror_and_reports_end(_mirror_dir: Path) -> None:
    client = TestClient(app)
    body = {
        "event_type": "notification",
        "session_id": "mirror-api-1",
        "data": {
            "host": "elsewhere",
            "transcript_path": CLIENT,
            "transcript_sync": [{"path": CLIENT, "end": 12, "lines": [[0, _line(n=1)]]}],
        },
    }
    resp = client.post("/api/v1/events", json=body)
    assert resp.status_code == 200
    assert resp.json()["mirror"] == {CLIENT: 12}
    target = tm.mirror_path(CLIENT)
    assert target is not None and target.read_text().strip() == _line(n=1)


def test_prune_mirror_removes_old_files(_mirror_dir: Path) -> None:
    tm.apply_chunks([TranscriptChunk(path=CLIENT, end=10, lines=[(0, _line(n=1))])])
    target = tm.mirror_path(CLIENT)
    assert target is not None
    old = time.time() - tm.MIRROR_MAX_AGE_SECONDS - 10
    for p in target.parent.iterdir():
        os.utime(p, (old, old))
    assert tm.prune_mirror() == 2  # the copy and its .end sidecar
    assert not target.parent.exists()
