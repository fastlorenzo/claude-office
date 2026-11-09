"""Statusline tee (run_statusline) and settings wrap/unwrap."""

import json
import sys
import time
from pathlib import Path

import pytest

from claude_office_hooks import manage as manage_hooks
from claude_office_hooks.statusline import run_statusline, telemetry_url

HOOK = "claude-office-hook"


def test_telemetry_url() -> None:
    assert (
        telemetry_url("http://localhost:8000/api/v1/events")
        == "http://localhost:8000/api/v1/telemetry/statusline"
    )


def test_tee_relays_stdout_exit_code_and_posts() -> None:
    posted: list[bytes] = []
    out: list[bytes] = []
    code = run_statusline(
        [
            sys.executable,
            "-c",
            "import sys; sys.stdout.write(sys.stdin.read().upper()); sys.exit(3)",
        ],
        b'{"a":"b"}',
        posted.append,
        out.append,
    )
    assert code == 3
    assert out == [b'{"A":"B"}']
    assert posted == [b'{"a":"b"}']


def test_post_failure_and_slow_post_never_block_or_fail() -> None:
    def boom(_d: bytes) -> None:
        raise OSError("down")

    out: list[bytes] = []
    assert run_statusline([sys.executable, "-c", "print('x')"], b"{}", boom, out.append) == 0
    assert out == [b"x\n"]

    def slow(_d: bytes) -> None:
        time.sleep(3)

    t = time.monotonic()
    run_statusline([sys.executable, "-c", "pass"], b"{}", slow, lambda _b: None)
    assert time.monotonic() - t < 1.5


def test_no_command_prints_nothing() -> None:
    out: list[bytes] = []
    assert run_statusline([], b"{}", lambda _d: None, out.append) == 0
    assert out == []


def _settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, sl: object) -> Path:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    p = tmp_path / "settings.json"
    p.write_text(json.dumps({"model": "opus", "statusLine": sl}), encoding="utf-8")
    return p


def test_wrap_unwrap_roundtrip_and_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    orig = {"type": "command", "command": "bash ~/.claude/s.sh --x 'a b' | cat", "padding": 1}
    p = _settings(tmp_path, monkeypatch, orig)
    assert manage_hooks.wrap_statusline(HOOK)
    wrapped = json.loads(p.read_text())["statusLine"]
    assert wrapped["command"].startswith(f"{HOOK} statusline -- sh -c ")
    assert wrapped["padding"] == 1
    assert not manage_hooks.wrap_statusline(HOOK)  # no double wrap
    assert json.loads(p.read_text())["statusLine"] == wrapped
    assert manage_hooks.unwrap_statusline()
    assert json.loads(p.read_text())["statusLine"] == orig
    assert json.loads(p.read_text())["model"] == "opus"
    assert not manage_hooks.unwrap_statusline()


def test_unwrap_without_backup_parses_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    orig = {"type": "command", "command": "echo 'hi there' && date"}
    p = _settings(tmp_path, monkeypatch, orig)
    manage_hooks.wrap_statusline(HOOK)
    (tmp_path / "claude-office-statusline-original.json").unlink()
    assert manage_hooks.unwrap_statusline()
    assert json.loads(p.read_text())["statusLine"]["command"] == orig["command"]


def test_wrap_without_statusline_is_noop(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    (tmp_path / "settings.json").write_text("{}", encoding="utf-8")
    assert not manage_hooks.wrap_statusline(HOOK)
    assert not manage_hooks.unwrap_statusline()


def _fake_hook(tmp_path: Path) -> str:
    """Stand-in for claude-office-hook: drops ``statusline --`` and runs the rest."""
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fake = bin_dir / "claude-office-hook"
    fake.write_text('#!/bin/sh\nshift 2\nexec "$@"\n', encoding="utf-8")
    fake.chmod(0o755)
    return str(fake)


def test_run_statusline_command_feeds_stdin_through_shell() -> None:
    assert manage_hooks._run_statusline_command("cat", '{"session_id":"selftest"}') == (
        '{"session_id":"selftest"}'
    )
    assert manage_hooks._run_statusline_command("exit 0", "{}") == ""


def test_verify_keeps_healthy_wrap(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    orig = {"type": "command", "command": "cat"}
    p = _settings(tmp_path, monkeypatch, orig)
    hook = _fake_hook(tmp_path)
    assert manage_hooks.wrap_statusline(hook)
    wrapped = json.loads(p.read_text())["statusLine"]

    assert manage_hooks.verify_statusline()
    assert json.loads(p.read_text())["statusLine"] == wrapped  # untouched


def test_verify_auto_unwraps_when_wrapped_command_is_silent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    orig = {"type": "command", "command": "true", "padding": 2}
    p = _settings(tmp_path, monkeypatch, orig)
    assert manage_hooks.wrap_statusline(_fake_hook(tmp_path))

    assert not manage_hooks.verify_statusline()
    assert json.loads(p.read_text())["statusLine"] == orig
    assert json.loads(p.read_text())["model"] == "opus"
    assert not (tmp_path / "claude-office-statusline-original.json").exists()


def test_verify_auto_unwraps_when_hook_binary_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    orig = {"type": "command", "command": "echo hi"}
    p = _settings(tmp_path, monkeypatch, orig)
    assert manage_hooks.wrap_statusline("/nonexistent/claude-office-hook")

    assert not manage_hooks.verify_statusline()
    assert json.loads(p.read_text())["statusLine"] == orig


def test_verify_is_noop_when_not_wrapped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    orig = {"type": "command", "command": "echo hi"}
    p = _settings(tmp_path, monkeypatch, orig)
    assert manage_hooks.verify_statusline()
    assert json.loads(p.read_text())["statusLine"] == orig


def test_dry_run_env_skips_post_but_still_relays_output(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CLAUDE_OFFICE_STATUSLINE_DRY_RUN", "1")
    posted: list[bytes] = []
    out: list[bytes] = []
    code = run_statusline(
        [sys.executable, "-c", "import sys; sys.stdout.write('ok:' + sys.stdin.read())"],
        b'{"session_id":"selftest"}',
        posted.append,
        out.append,
    )
    assert code == 0
    assert posted == []  # POST never called
    assert out == [b'ok:{"session_id":"selftest"}']


def test_verify_runner_sets_dry_run_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CLAUDE_OFFICE_STATUSLINE_DRY_RUN", raising=False)
    assert (
        manage_hooks._run_statusline_command("printenv CLAUDE_OFFICE_STATUSLINE_DRY_RUN", "{}")
        == "1\n"
    )
