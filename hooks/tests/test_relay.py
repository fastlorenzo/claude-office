"""WSL → Windows relay (Claude Code in WSL with NAT networking, app on Windows)."""

import json
import os
import socket
import stat
import subprocess
import sys
import threading
import urllib.error
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import pytest

from claude_office_hooks import manage
from claude_office_hooks.relay import is_connection_refused, relay

HOOKS_ROOT = Path(__file__).parent.parent


def _closed_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _hook_env(home: Path, **extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_OFFICE_")}
    env.update({"HOME": str(home), "USERPROFILE": str(home), **extra})
    return env


def _fake_relay(tmp_path: Path) -> tuple[Path, Path]:
    """An executable that records its argv and stdin, like the Windows hook would."""
    out = tmp_path / "relayed.json"
    script = tmp_path / "fake-relay"
    script.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\n"
        f"open({str(out)!r}, 'w').write(json.dumps("
        "{'argv': sys.argv[1:], 'stdin': sys.stdin.read()}))\n"
    )
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    return script, out


class TestHelpers:
    def test_connection_refused_detection(self) -> None:
        assert is_connection_refused(urllib.error.URLError(ConnectionRefusedError()))
        assert is_connection_refused(ConnectionRefusedError())
        assert not is_connection_refused(urllib.error.URLError(TimeoutError()))
        assert not is_connection_refused(
            urllib.error.HTTPError("http://x", 401, "no", {}, None)  # type: ignore[arg-type]
        )

    def test_relay_requires_an_existing_executable(self, tmp_path: Path) -> None:
        calls: list[Any] = []
        assert not relay("", "events", b"{}", run=calls.append)
        assert not relay(str(tmp_path / "missing"), "events", b"{}", run=calls.append)
        assert not relay(sys.executable, "bogus-kind", b"{}", run=calls.append)
        assert calls == []

    def test_relay_reports_child_status(self) -> None:
        class _Proc:
            def __init__(self, code: int) -> None:
                self.returncode = code

        seen: list[list[str]] = []

        def run_ok(cmd: list[str], **_kw: Any) -> _Proc:
            seen.append(cmd)
            return _Proc(0)

        assert relay(sys.executable, "statusline", b"{}", run=run_ok)
        assert seen == [[sys.executable, "relay", "statusline"]]
        assert not relay(sys.executable, "events", b"{}", run=lambda *a, **k: _Proc(1))

        def boom(*_a: Any, **_k: Any) -> None:
            raise subprocess.TimeoutExpired("x", 1.5)

        assert not relay(sys.executable, "events", b"{}", run=boom)


def test_refused_post_is_relayed_with_the_wsl_tag(tmp_path: Path) -> None:
    script, out = _fake_relay(tmp_path)
    env = _hook_env(
        tmp_path,
        CLAUDE_OFFICE_API_URL=f"http://127.0.0.1:{_closed_port()}/api/v1/events",
        CLAUDE_OFFICE_RELAY=str(script),
        WSL_DISTRO_NAME="Ubuntu",
    )
    payload = json.dumps({"session_id": "s1", "tool_name": "Bash", "tool_input": {}})
    proc = subprocess.run(
        [sys.executable, "-m", "claude_office_hooks", "pre_tool_use"],
        input=payload,
        env=env,
        cwd=HOOKS_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    assert proc.returncode == 0 and proc.stdout == "" and proc.stderr == ""
    relayed = json.loads(out.read_text())
    assert relayed["argv"] == ["relay", "events"]
    event = json.loads(relayed["stdin"])
    assert event["event_type"] == "pre_tool_use"
    assert event["data"]["wsl_distro"] == "Ubuntu"


def test_relay_subcommand_posts_stdin_with_the_key(tmp_path: Path) -> None:
    received: list[tuple[str, str | None, bytes]] = []

    class _Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - http.server API
            body = self.rfile.read(int(self.headers["Content-Length"]))
            received.append((self.path, self.headers.get("X-API-Key"), body))
            self.send_response(200)
            self.end_headers()

        def log_message(self, *_args: Any) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f"http://127.0.0.1:{server.server_port}"
        env = _hook_env(
            tmp_path,
            CLAUDE_OFFICE_API_URL=f"{base}/api/v1/events",
            CLAUDE_OFFICE_API_KEY="win-key",
        )
        for kind, path in (
            ("events", "/api/v1/events"),
            ("statusline", "/api/v1/telemetry/statusline"),
        ):
            proc = subprocess.run(
                [sys.executable, "-m", "claude_office_hooks", "relay", kind],
                input=b'{"x": 1}',
                env=env,
                cwd=HOOKS_ROOT,
                capture_output=True,
                timeout=30,
                check=False,
            )
            assert proc.returncode == 0, proc.stderr
            assert received[-1] == (path, "win-key", b'{"x": 1}')
    finally:
        server.shutdown()


def test_relay_subcommand_fails_when_backend_is_down(tmp_path: Path) -> None:
    env = _hook_env(tmp_path, CLAUDE_OFFICE_API_URL=f"http://127.0.0.1:{_closed_port()}/x")
    proc = subprocess.run(
        [sys.executable, "-m", "claude_office_hooks", "relay", "events"],
        input=b"{}",
        env=env,
        cwd=HOOKS_ROOT,
        capture_output=True,
        timeout=30,
        check=False,
    )
    assert proc.returncode == 1 and proc.stdout == b""


def test_install_writes_and_removes_the_relay(tmp_path: Path) -> None:
    cfg = tmp_path / "c.env"
    win_hook = "/mnt/c/Users/Jane Doe/AppData/Local/claude-office/hook/1.0/claude-office-hook.exe"
    values = manage.write_config(cfg, relay=win_hook)
    assert values["CLAUDE_OFFICE_RELAY"] == win_hook
    assert f'CLAUDE_OFFICE_RELAY="{win_hook}"' in cfg.read_text()
    assert manage.write_config(cfg)["CLAUDE_OFFICE_RELAY"] == win_hook  # kept
    assert "CLAUDE_OFFICE_RELAY" not in manage.write_config(cfg, relay="")
    assert "CLAUDE_OFFICE_RELAY" not in cfg.read_text()


@pytest.mark.skipif(os.name == "nt", reason="POSIX executable bit")
def test_fake_relay_is_executable(tmp_path: Path) -> None:
    script, _ = _fake_relay(tmp_path)
    assert os.access(script, os.X_OK)
