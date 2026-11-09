"""Packaging-readiness behaviour the desktop app relies on.

* ``CLAUDE_OFFICE_DATA_DIR`` relocates the DB and telemetry state unless they
  were set explicitly.
* With an explicit API key, only the ``/api/v1`` surface is gated: the static
  frontend must load, since a browser cannot send ``X-API-Key`` on page loads.
* ``python -m app --exit-on-stdin-close`` stops when its parent closes stdin.
"""

import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings


class TestDataDir:
    def test_data_dir_relocates_db_and_telemetry(self, tmp_path: Path) -> None:
        s = Settings(CLAUDE_OFFICE_DATA_DIR=str(tmp_path / "state"))
        expected_db = f"sqlite+aiosqlite:///{tmp_path / 'state' / 'visualizer.db'}"
        expected_telemetry = str(tmp_path / "state" / "telemetry_state.json")
        assert expected_db == s.DATABASE_URL
        assert expected_telemetry == s.TELEMETRY_STATE_PATH
        assert (tmp_path / "state").is_dir()

    def test_explicit_paths_win_over_data_dir(self, tmp_path: Path) -> None:
        s = Settings(
            CLAUDE_OFFICE_DATA_DIR=str(tmp_path),
            DATABASE_URL="sqlite+aiosqlite:///elsewhere.db",
            TELEMETRY_STATE_PATH="/elsewhere/t.json",
        )
        assert s.DATABASE_URL == "sqlite+aiosqlite:///elsewhere.db"
        assert s.TELEMETRY_STATE_PATH == "/elsewhere/t.json"

    def test_no_data_dir_keeps_source_tree_defaults(self) -> None:
        s = Settings()
        assert s.DATABASE_URL.endswith("visualizer.db")
        assert not s.CLAUDE_OFFICE_DATA_DIR


class TestExplicitKeyServesFrontend:
    @pytest.fixture
    def explicit_key(self):
        settings = get_settings()
        original = settings.CLAUDE_OFFICE_API_KEY
        settings.CLAUDE_OFFICE_API_KEY = "desktop-key"
        try:
            yield "desktop-key"
        finally:
            settings.CLAUDE_OFFICE_API_KEY = original

    def test_non_api_path_is_not_gated(self, explicit_key: str) -> None:
        from app.main import app

        resp = TestClient(app).get("/some/frontend/route")
        assert resp.status_code != 401

    def test_api_path_still_requires_key(self, explicit_key: str) -> None:
        from app.main import app

        client = TestClient(app)
        settings = get_settings()
        assert client.get(f"{settings.API_V1_STR}/sessions").status_code == 401
        ok = client.get(f"{settings.API_V1_STR}/sessions", headers={"X-API-Key": explicit_key})
        assert ok.status_code == 200


def test_server_exits_when_stdin_closes(tmp_path: Path) -> None:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {
        "PATH": "/usr/bin:/bin",
        "CLAUDE_OFFICE_DATA_DIR": str(tmp_path),
        "CI_POLL_ENABLED": "0",
        "LOG_RICH_TRACEBACKS": "0",
    }
    proc = subprocess.Popen(
        [sys.executable, "-m", "app", "--port", str(port), "--exit-on-stdin-close"],
        cwd=Path(__file__).parent.parent,
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    try:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            with socket.socket() as probe:
                if probe.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.05)
        assert proc.stdin is not None
        proc.stdin.close()
        assert proc.wait(timeout=1.5) == 0
    finally:
        if proc.poll() is None:
            proc.kill()


class TestSimulationLaunch:
    """POST /sessions/simulate must work without uv or scripts/ on disk (desktop)."""

    def test_launches_own_interpreter_with_server_url_and_key(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from app.api.routes import sessions
        from app.main import app

        captured: dict[str, object] = {}

        class _FakeProc:
            def poll(self) -> int:
                return 0

        def fake_popen(cmd: list[str], **kwargs: object) -> _FakeProc:
            captured["cmd"] = cmd
            captured["env"] = kwargs["env"]
            return _FakeProc()

        monkeypatch.setattr(sessions.subprocess, "Popen", fake_popen)
        settings = get_settings()
        resp = TestClient(app, base_url="http://127.0.0.1:8765").post(
            f"{settings.API_V1_STR}/sessions/simulate",
            headers={"X-API-Key": settings.effective_api_key},
        )
        assert resp.status_code == 200
        assert captured["cmd"] == [sys.executable, "-m", "app", "simulate"]
        env = captured["env"]
        assert isinstance(env, dict)
        assert env["CLAUDE_OFFICE_API_URL"] == "http://127.0.0.1:8765/api/v1/events"
        assert env["CLAUDE_OFFICE_API_KEY"] == settings.effective_api_key

    def test_frozen_uses_server_executable(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from app.api.routes import sessions

        monkeypatch.setattr(sys, "frozen", True, raising=False)
        assert sessions.simulation_command() == [sys.executable, "simulate"]

    def test_simulate_subcommand_resolves_scenarios(self) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "app", "simulate", "--help"],
            cwd=Path(__file__).parent.parent,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        assert proc.returncode == 0, proc.stderr
        assert "quick" in proc.stdout and "complex" in proc.stdout
