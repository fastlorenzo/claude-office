"""find_session_root fallbacks: DB, session registry, transcript."""

# pyright: reportPrivateUsage=false

import json
import sqlite3
from pathlib import Path

import pytest

from app.config import get_settings
from app.core import session_liveness as sl
from app.core import session_root as sr


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "home"
    (home / ".claude" / "sessions").mkdir(parents=True)
    (home / ".claude" / "projects" / "slug").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    settings = get_settings()
    monkeypatch.setattr(settings, "CLAUDE_SESSIONS_DIR", str(home / ".claude" / "sessions"))
    monkeypatch.setattr(settings, "DATABASE_URL", "sqlite+aiosqlite:///:memory:")
    sr.clear_root_cache()
    sl._cache.clear()
    return home


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    (repo / "sub").mkdir()
    return repo


def test_registry_fallback(env: Path, tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    (env / ".claude" / "sessions" / "1.json").write_text(
        json.dumps({"pid": 1, "sessionId": "sid-a", "cwd": str(repo / "sub")})
    )
    assert sr.find_session_root("sid-a") == str(repo.resolve())


def test_transcript_fallback(env: Path, tmp_path: Path) -> None:
    repo = _repo(tmp_path)
    t = env / ".claude" / "projects" / "slug" / "sid-b.jsonl"
    t.write_text("not json\n" + json.dumps({"type": "user", "cwd": str(repo)}) + "\n")
    assert sr.find_session_root("sid-b") == str(repo.resolve())


def test_db_fallback(env: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    repo = _repo(tmp_path)
    db = tmp_path / "v.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE sessions (id TEXT, project_root TEXT)")
    con.execute("INSERT INTO sessions VALUES ('sid-c', ?)", (str(repo),))
    con.commit()
    con.close()
    monkeypatch.setattr(get_settings(), "DATABASE_URL", f"sqlite+aiosqlite:///{db}")
    assert sr.find_session_root("sid-c") == str(repo.resolve())


def test_unknown_is_none_and_cached(env: Path) -> None:
    assert sr.find_session_root("nope") is None
    assert "nope" in sr._cache


def test_non_git_cwd_ignored(env: Path, tmp_path: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    (env / ".claude" / "sessions" / "2.json").write_text(
        json.dumps({"pid": 2, "sessionId": "sid-d", "cwd": str(plain)})
    )
    assert sr.find_session_root("sid-d") is None
