"""Self-installing hooks (desktop packaging, Phase 2).

Covers absolute-path registration (spaces, Windows paths), the config-file
rules ported from install.sh, ``status`` JSON, the CLI routed through the
hook binary, and the WSL distro tag on event payloads.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from claude_office_hooks import manage
from claude_office_hooks.event_mapper import map_event


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("claude-office-hook", "claude-office-hook"),
        (
            "/opt/claude-office/hook/claude-office-hook",
            "/opt/claude-office/hook/claude-office-hook",
        ),
        (
            r"C:\Users\Jane Doe\AppData\Local\claude-office\hook\claude-office-hook.exe",
            '"C:/Users/Jane Doe/AppData/Local/claude-office/hook/claude-office-hook.exe"',
        ),
        ("/home/o'neil/x y/claude-office-hook", '"/home/o\'neil/x y/claude-office-hook"'),
        ("/srv/$HOME x/claude-office-hook", "'/srv/$HOME x/claude-office-hook'"),
    ],
)
def test_format_hook_cmd(raw: str, expected: str) -> None:
    assert manage.format_hook_cmd(raw) == expected


def test_is_wrapped_matches_quoted_absolute_paths() -> None:
    assert manage.is_wrapped("claude-office-hook statusline -- sh -c x")
    assert manage.is_wrapped('"C:/A B/claude-office-hook.exe" statusline -- sh -c x')
    assert manage.is_wrapped("'/x y/claude-office-hook' statusline -- sh -c x")
    assert not manage.is_wrapped("my-statusline.sh")


class TestWriteConfig:
    def test_fresh_install_generates_key_and_url(self, tmp_path: Path) -> None:
        cfg = tmp_path / "c.env"
        values = manage.write_config(cfg, api_url="http://127.0.0.1:8123/api/v1/events")
        assert len(values["CLAUDE_OFFICE_API_KEY"]) > 20
        text = cfg.read_text()
        assert 'CLAUDE_OFFICE_API_URL="http://127.0.0.1:8123/api/v1/events"' in text
        if os.name != "nt":
            assert cfg.stat().st_mode & 0o777 == 0o600

    def test_existing_key_is_never_replaced(self, tmp_path: Path) -> None:
        cfg = tmp_path / "c.env"
        cfg.write_text('CLAUDE_OFFICE_API_KEY="original"\n')
        values = manage.write_config(cfg, api_key="desktop-key", force=True)
        assert values["CLAUDE_OFFICE_API_KEY"] == "original"

    def test_explicit_key_used_when_none_exists(self, tmp_path: Path) -> None:
        values = manage.write_config(tmp_path / "c.env", api_key="desktop-key")
        assert values["CLAUDE_OFFICE_API_KEY"] == "desktop-key"

    def test_preserves_user_edits_and_extra_keys(self, tmp_path: Path) -> None:
        cfg = tmp_path / "c.env"
        cfg.write_text(
            'CLAUDE_OFFICE_STRIP_PREFIXES="-mine-"\nCLAUDE_OFFICE_DEBUG=1\n'
            'CLAUDE_OFFICE_API_URL="http://localhost:9000/api/v1/events"\nMY_KEY=keep\n'
        )
        values = manage.write_config(cfg)
        assert values["CLAUDE_OFFICE_STRIP_PREFIXES"] == "-mine-"
        assert values["CLAUDE_OFFICE_DEBUG"] == "1"
        assert values["CLAUDE_OFFICE_API_URL"] == "http://localhost:9000/api/v1/events"
        assert "MY_KEY=keep" in cfg.read_text()

    def test_force_resets_managed_keys_and_empty_url_removes(self, tmp_path: Path) -> None:
        cfg = tmp_path / "c.env"
        cfg.write_text('CLAUDE_OFFICE_DEBUG=1\nCLAUDE_OFFICE_API_URL="http://localhost:9000/x"\n')
        values = manage.write_config(cfg, force=True, api_url="")
        assert values["CLAUDE_OFFICE_DEBUG"] == "0"
        assert "CLAUDE_OFFICE_API_URL" not in values
        assert "CLAUDE_OFFICE_API_URL" not in cfg.read_text()


def test_absolute_path_install_status_uninstall_round_trip(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    # A previous dev install (bare name) plus an unrelated user hook.
    settings = tmp_path / "settings.json"
    settings.write_text(
        json.dumps(
            {
                "hooks": {
                    "Stop": [
                        {"hooks": [{"type": "command", "command": "claude-office-hook stop"}]},
                        {"hooks": [{"type": "command", "command": "notify-send done"}]},
                    ]
                }
            }
        )
    )
    cmd = manage.format_hook_cmd(r"C:\Users\Jane Doe\claude-office\claude-office-hook.exe")
    manage.install_hooks(cmd)
    entry = json.loads(settings.read_text())["hooks"]["PreToolUse"][0]
    assert entry["hooks"][0]["command"] == f"{cmd} pre_tool_use"

    status = manage.get_status(tmp_path / "missing.env")
    assert status["missing_hooks"] == []
    assert cmd in status["hook_commands"]
    assert "claude-office-hook" in status["hook_commands"]  # the legacy entry is visible
    assert status["config_present"] is False

    manage.uninstall_hooks(cmd)
    hooks = json.loads(settings.read_text())["hooks"]
    assert hooks == {"Stop": [{"hooks": [{"type": "command", "command": "notify-send done"}]}]}


def _run_cli(home: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "HOME": str(home),
        "USERPROFILE": str(home),
        "CLAUDE_CONFIG_DIR": str(home / ".claude"),
    }
    return subprocess.run(
        [sys.executable, "-m", "claude_office_hooks", *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )


def test_cli_install_status_uninstall_through_hook_entry_point(tmp_path: Path) -> None:
    hook_path = str(tmp_path / "bin dir" / "claude-office-hook")
    proc = _run_cli(
        tmp_path,
        "install",
        "--hook-cmd",
        hook_path,
        "--api-key",
        "k1",
        "--api-url",
        "http://127.0.0.1:8123/api/v1/events",
        "--json",
    )
    assert proc.returncode == 0, proc.stderr
    status = json.loads(proc.stdout[proc.stdout.index("{") :])
    assert status["missing_hooks"] == []
    assert status["api_key_present"] is True
    assert status["api_url"] == "http://127.0.0.1:8123/api/v1/events"
    assert "k1" not in proc.stdout  # the key is never printed
    cfg = tmp_path / ".claude" / "claude-office-config.env"
    assert 'CLAUDE_OFFICE_API_KEY="k1"' in cfg.read_text()

    proc = _run_cli(tmp_path, "uninstall", "--json")
    assert proc.returncode == 0, proc.stderr
    status = json.loads(proc.stdout[proc.stdout.index("{") :])
    assert status["installed_hooks"] == []
    assert not cfg.exists()


def test_cli_bad_arguments_exit_nonzero(tmp_path: Path) -> None:
    assert _run_cli(tmp_path, "install", "--bogus").returncode != 0


def test_wsl_distro_tagged_on_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WSL_DISTRO_NAME", "Ubuntu-24.04")
    payload = map_event("pre_tool_use", {"tool_name": "Bash", "tool_input": {}}, "s1")
    assert payload is not None
    assert payload["data"]["wsl_distro"] == "Ubuntu-24.04"

    monkeypatch.delenv("WSL_DISTRO_NAME")
    payload = map_event("pre_tool_use", {"tool_name": "Bash", "tool_input": {}}, "s1")
    assert payload is not None
    assert "wsl_distro" not in payload["data"]
