"""Install/uninstall the Claude Office hooks in Claude Code's settings.json.

Exposed as ``claude-office-hook install|uninstall|status`` (used by the desktop
app with an absolute ``--hook-cmd``, and by install.sh/uninstall.sh).
"""

import argparse
import contextlib
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, cast

# Constants
HOOK_TYPES = [
    "SessionStart",
    "SessionEnd",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "UserPromptSubmit",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SubagentStart",
    "SubagentStop",
    "PreCompact",
]


def get_settings_path() -> Path:
    """Get the path to the Claude settings file."""
    # Priority: Env var -> ~/.claude/settings.json
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        return Path(os.environ["CLAUDE_CONFIG_DIR"]) / "settings.json"
    return Path.home() / ".claude" / "settings.json"


def load_settings(path: Path) -> dict[str, Any]:
    """Load settings from JSON file.

    A missing file returns ``{}`` (fresh install). A file that exists but
    fails to parse is a hard stop: returning ``{}`` here would cause the
    caller to write a near-empty dict back over the user's real config and
    silently wipe unrelated settings (permissions, env, model, statusline).
    """
    if not path.exists():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as e:
        raise SystemExit(
            f"ERROR: {path} exists but is not valid JSON ({e}).\n"
            "Refusing to continue: proceeding would overwrite your settings.\n"
            "Fix or move the file, then re-run install."
        ) from e


def save_settings(path: Path, settings: dict[str, Any]) -> None:
    """Save settings atomically, backing up the original once per run.

    Writes a temp file in the same directory then ``os.replace``s it into
    place, so a crash mid-write cannot leave a truncated ``settings.json``.
    The first mutation of an existing file is snapshotted to
    ``settings.json.bak``; the ``if not backup.exists()`` guard preserves
    the oldest known-good copy across repeated runs.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        backup = path.with_suffix(".json.bak")
        if not backup.exists():
            shutil.copy2(path, backup)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def create_hook_config(hook_cmd: str, hook_type: str) -> dict[str, Any]:
    """Create the hook configuration dictionary.

    Args:
        hook_cmd: Path to the claude-office-hook command
        hook_type: The hook type in PascalCase (e.g., "PreToolUse")
    """
    # Convert PascalCase to snake_case for the event type argument
    event_type = convert_camel_to_snake(hook_type)

    config = {
        "type": "command",
        "command": f"{hook_cmd} {event_type}",
        "timeout": 2,  # Seconds
    }

    # Wrap in the structure expected by Claude Code
    # Structure:
    # "HookName": [
    #   {
    #     "matcher": ".*" (optional),
    #     "hooks": [ { "type": "command", ... } ]
    #   }
    # ]

    hook_entry: dict[str, Any] = {"hooks": [config]}

    # Hooks that support matchers (match all with ".*")
    if hook_type in [
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "PermissionRequest",
        "Notification",
        "SubagentStart",
        "SubagentStop",
    ]:
        hook_entry["matcher"] = ".*"

    return hook_entry


def is_same_hook(entry1: dict[str, Any], entry2: dict[str, Any]) -> bool:
    """Check if two hook entries are effectively the same."""
    # Simple comparison of command path
    try:
        cmd1 = entry1.get("hooks", [])[0].get("command")
        cmd2 = entry2.get("hooks", [])[0].get("command")
        return cmd1 == cmd2
    except (IndexError, AttributeError):
        return False


def install_hooks(hook_cmd: str, dry_run: bool = False):
    """Install hooks into settings.

    Args:
        hook_cmd: Path to the claude-office-hook command
        dry_run: If True, don't actually save changes
    """
    settings_path = get_settings_path()
    print(f"Installing hooks to {settings_path}...")

    settings = load_settings(settings_path)
    hooks_config = settings.get("hooks", {})

    changes_made = False

    for hook_type in HOOK_TYPES:
        new_entry = create_hook_config(hook_cmd, hook_type)
        event_type = convert_camel_to_snake(hook_type)

        current_list = hooks_config.get(hook_type, [])

        # Re-point our own entries that use a different command (a previous
        # desktop version's path, or switching between the dev tool and the
        # desktop binary) instead of stacking a second hook next to them.
        kept: list[Any] = []
        for existing in current_list:
            cmd = _entry_command(existing)
            if cmd is not None and _is_our_command(cmd) and not is_same_hook(existing, new_entry):
                print(f"  [Replace] {hook_type}: {cmd}")
                changes_made = True
                continue
            kept.append(existing)
        current_list = kept
        hooks_config[hook_type] = current_list

        # Check for duplicates
        if any(is_same_hook(existing, new_entry) for existing in current_list):
            print(f"  [Skip] {hook_type}: Hook already exists.")
            continue

        print(f"  [Add]  {hook_type}: {hook_cmd} {event_type}")
        current_list.append(new_entry)
        hooks_config[hook_type] = current_list
        changes_made = True

    if changes_made:
        settings["hooks"] = hooks_config
        if not dry_run:
            save_settings(settings_path, settings)
            print("Settings saved.")
        else:
            print("Dry run: No changes saved.")
    else:
        print("No changes needed.")


def uninstall_hooks(_hook_cmd: str, dry_run: bool = False) -> None:
    """Remove hooks from settings.

    Args:
        _hook_cmd: Path to the claude-office-hook command (unused, hooks identified by pattern)
        dry_run: If True, don't actually save changes
    """
    del _hook_cmd  # Unused - hooks identified by pattern match
    settings_path = get_settings_path()
    print(f"Uninstalling hooks from {settings_path}...")

    settings = load_settings(settings_path)
    hooks_config = settings.get("hooks", {})

    changes_made = False

    for hook_type in list(hooks_config.keys()):
        current_list = hooks_config[hook_type]
        original_len = len(current_list)

        # Filter out hooks that use our command (both new direct and old .sh wrappers)
        new_list: list[Any] = []
        for entry in current_list:
            try:
                cmd = entry.get("hooks", [])[0].get("command", "")
                # Match both "claude-office-hook" (new) and "claude-office/hooks/*.sh" (old)
                if _is_our_command(cmd):
                    print(f"  [Remove] {hook_type}: {cmd}")
                    continue
            except (IndexError, AttributeError):
                pass
            new_list.append(entry)

        if len(new_list) < original_len:
            hooks_config[hook_type] = new_list
            changes_made = True

        # Clean up empty lists
        if not hooks_config[hook_type]:
            del hooks_config[hook_type]

    if changes_made:
        settings["hooks"] = hooks_config
        if not dry_run:
            save_settings(settings_path, settings)
            print("Settings saved.")
        else:
            print("Dry run: No changes saved.")
    else:
        print("No hooks found to remove.")


STATUSLINE_MARKER = "claude-office-hook statusline --"
_STATUSLINE_BACKUP_NAME = "claude-office-statusline-original.json"


def _statusline_backup_path() -> Path:
    return get_settings_path().parent / _STATUSLINE_BACKUP_NAME


# Matches the bare command and absolute/quoted desktop paths alike, e.g.
# ``"C:/Users/Jane Doe/.../claude-office-hook.exe" statusline --``.
_WRAPPED_RE = re.compile(r"claude-office-hook(?:\.exe)?[\"']? statusline --")


def is_wrapped(command: object) -> bool:
    return isinstance(command, str) and bool(_WRAPPED_RE.search(command))


def wrap_command(hook_cmd: str, original: str) -> str:
    return f"{hook_cmd} statusline -- sh -c {shlex.quote(original)}"


def _unwrap_command(command: str) -> str | None:
    """Recover the original command from a wrapped one (backup-less fallback)."""
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    for i in range(len(parts) - 3):
        if parts[i : i + 2] == ["statusline", "--"] and parts[i + 2 : i + 4] == ["sh", "-c"]:
            return parts[i + 4] if i + 4 < len(parts) else None
    return None


def _statusline_of(settings: dict[str, Any]) -> dict[str, Any] | None:
    """``settings["statusLine"]`` when it is a dict with a string command."""
    sl = settings.get("statusLine")
    if isinstance(sl, dict):
        typed = cast(dict[str, Any], sl)
        if isinstance(typed.get("command"), str):
            return typed
    return None


def wrap_statusline(hook_cmd: str, dry_run: bool = False) -> bool:
    """Wrap ``statusLine.command`` in the tee. Idempotent; returns True if changed."""
    settings_path = get_settings_path()
    settings = load_settings(settings_path)
    sl = _statusline_of(settings)
    if sl is None:
        print("  [Skip] statusLine: no command configured.")
        return False
    if is_wrapped(sl["command"]):
        if sl["command"].startswith(f"{hook_cmd} statusline --"):
            print("  [Skip] statusLine: already wrapped.")
            return False
        # Wrapped by another hook path (older desktop version / dev tool):
        # re-point the wrapper, keeping the original command and its backup.
        original = _unwrap_command(sl["command"])
        if original is None:
            print("  [Warn] statusLine: wrapped by another hook path; cannot re-point it.")
            return False
        new_sl: dict[str, Any] = {**sl, "command": wrap_command(hook_cmd, original)}
        settings["statusLine"] = new_sl
        print(f"  [Rewrap] statusLine: {new_sl['command']}")
        if not dry_run:
            save_settings(settings_path, settings)
        return True
    if not dry_run:
        backup = _statusline_backup_path()
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_text(json.dumps(sl, indent=2) + "\n", encoding="utf-8")
    new_sl: dict[str, Any] = dict(sl)
    new_sl["command"] = wrap_command(hook_cmd, sl["command"])
    settings["statusLine"] = new_sl
    print(f"  [Wrap] statusLine: {new_sl['command']}")
    if not dry_run:
        save_settings(settings_path, settings)
    return True


def unwrap_statusline(dry_run: bool = False) -> bool:
    """Restore the original ``statusLine`` exactly. Returns True if changed."""
    settings_path = get_settings_path()
    settings = load_settings(settings_path)
    sl = _statusline_of(settings)
    if sl is None or not is_wrapped(sl["command"]):
        print("  [Skip] statusLine: not wrapped.")
        return False
    backup = _statusline_backup_path()
    restored: dict[str, Any] | None = None
    if backup.exists():
        try:
            loaded: Any = json.loads(backup.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                restored = _statusline_of({"statusLine": cast(dict[str, Any], loaded)})
        except (OSError, ValueError):
            restored = None
    if restored is None:
        original = _unwrap_command(sl["command"])
        if original is None:
            print("  [Warn] statusLine: cannot recover the original command; left as is.")
            return False
        restored = {**sl, "command": original}
    settings["statusLine"] = restored
    print(f"  [Unwrap] statusLine: {restored['command']}")
    if not dry_run:
        save_settings(settings_path, settings)
        backup.unlink(missing_ok=True)
    return True


STATUSLINE_VERIFY_PAYLOAD = '{"session_id":"selftest"}'
STATUSLINE_VERIFY_TIMEOUT = 10  # Seconds


def _run_statusline_command(command: str, stdin_json: str) -> str:
    """Run a statusLine command through the shell (as Claude Code does); return stdout.

    Any failure (spawn error, timeout) yields an empty string so callers can
    treat it as "produced no output".
    """
    env = {**os.environ, "CLAUDE_OFFICE_STATUSLINE_DRY_RUN": "1"}  # never POST selftest data
    try:
        proc = subprocess.run(  # noqa: S602 - the user's own configured statusLine command
            command,
            shell=True,
            input=stdin_json,
            env=env,
            capture_output=True,
            text=True,
            timeout=STATUSLINE_VERIFY_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return proc.stdout


def verify_statusline() -> bool:
    """Run the wrapped statusLine command on a minimal payload.

    If it prints nothing, the wrap is broken (e.g. the hook tool predates the
    ``statusline`` subcommand), so the original command is restored and a
    warning is printed. Returns True when healthy or when nothing is wrapped.
    """
    settings_path = get_settings_path()
    settings = load_settings(settings_path)
    sl = _statusline_of(settings)
    if sl is None or not is_wrapped(sl["command"]):
        print("  [Skip] statusLine: not wrapped, nothing to verify.")
        return True
    out = _run_statusline_command(sl["command"], STATUSLINE_VERIFY_PAYLOAD)
    if out.strip():
        print("  [OK] statusLine: wrapped command produced output.")
        return True
    print("  [Warn] statusLine: wrapped command produced no output; restoring the original.")
    print("         Check that 'claude-office-hook' is on PATH and up to date, then re-run.")
    unwrap_statusline()
    return False


def convert_camel_to_snake(name: str) -> str:
    import re

    s1 = re.sub("(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub("([a-z0-9])([A-Z])", r"\1_\2", s1).lower()


# ---------------------------------------------------------------------------
# Hook command formatting (absolute paths from the desktop app)
# ---------------------------------------------------------------------------

BARE_HOOK_CMD = "claude-office-hook"
_SHELL_SAFE = re.compile(r"^[\w@%+=:,./-]+$")


def format_hook_cmd(hook_cmd: str) -> str:
    """Return ``hook_cmd`` as it should appear in a settings.json command string.

    The bare name (``uv tool install`` puts it on PATH) is kept as is. An
    absolute path (the desktop app's frozen binary) gets forward slashes,
    which both POSIX shells and Git Bash (Claude Code's shell on Windows)
    accept, and double quotes when it contains spaces (``C:/Users/Jane Doe``).
    Double quotes work in sh, bash and cmd alike; the rare path containing a
    shell metacharacter falls back to POSIX single quoting.
    """
    if hook_cmd == BARE_HOOK_CMD:
        return hook_cmd
    path = hook_cmd.replace("\\", "/")
    if _SHELL_SAFE.match(path):
        return path
    if not any(c in path for c in '"$`\\!'):
        return f'"{path}"'
    return shlex.quote(path)


def default_hook_cmd() -> str:
    """The command to register: this binary when frozen, else the PATH name."""
    if getattr(sys, "frozen", False):
        return sys.executable
    return BARE_HOOK_CMD


# ---------------------------------------------------------------------------
# Config env file (~/.claude/claude-office-config.env)
# ---------------------------------------------------------------------------

_MANAGED_KEYS = (
    "CLAUDE_OFFICE_STRIP_PREFIXES",
    "CLAUDE_OFFICE_DEBUG",
    "CLAUDE_OFFICE_API_KEY",
    "CLAUDE_OFFICE_API_URL",
    "CLAUDE_OFFICE_RELAY",
)


def _default_strip_prefixes() -> str:
    user = os.environ.get("USER") or os.environ.get("USERNAME") or ""
    return f"-Users-{user}-Repos-,-Users-{user}-" if user else ""


def _read_env_file(path: Path) -> tuple[dict[str, str], list[str]]:
    """Return (managed values, verbatim user-added lines) from the config file."""
    managed: dict[str, str] = {}
    extra: list[str] = []
    if not path.exists():
        return managed, extra
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        key, sep, value = stripped.partition("=")
        key = key.strip()
        if sep and key in _MANAGED_KEYS:
            managed[key] = value.strip().strip('"').strip("'")
        else:
            extra.append(line)
    return managed, extra


def write_config(
    path: Path,
    *,
    api_key: str | None = None,
    api_url: str | None = None,
    strip_prefixes: str | None = None,
    force: bool = False,
    replace_key: bool = False,
    relay: str | None = None,
) -> dict[str, str]:
    """Write the hook config file; returns the effective managed values.

    Mirrors the rules install.sh always had:
    * an existing API key is never replaced, not even by ``force`` or an
      explicit ``api_key`` (callers adopt the returned key instead), unless
      ``replace_key``: the desktop app runs the backend itself and must make
      every producer (e.g. each WSL distro) send the key it enforces;
    * strip prefixes / debug: explicit arg > existing value > default, and
      ``force`` resets them to defaults;
    * ``api_url`` / ``relay``: explicit arg > existing value; empty string
      removes it (``relay``: Windows hook used from WSL, see ``relay.py``);
    * user-added keys are preserved verbatim.
    """
    existing, extra = _read_env_file(path)
    kept = {} if force else existing

    if replace_key and api_key:
        key = api_key  # the caller IS the backend (desktop app): it owns the key
    else:
        key = existing.get("CLAUDE_OFFICE_API_KEY") or api_key or secrets.token_urlsafe(32)
    values = {
        "CLAUDE_OFFICE_STRIP_PREFIXES": (
            strip_prefixes
            if strip_prefixes is not None
            else kept.get("CLAUDE_OFFICE_STRIP_PREFIXES", _default_strip_prefixes())
        ),
        "CLAUDE_OFFICE_DEBUG": kept.get("CLAUDE_OFFICE_DEBUG", "0"),
        "CLAUDE_OFFICE_API_KEY": key,
    }
    url = api_url if api_url is not None else existing.get("CLAUDE_OFFICE_API_URL", "")
    if url:
        values["CLAUDE_OFFICE_API_URL"] = url

    lines = [
        "# Claude Office Hooks Configuration",
        "# Generated by claude-office-hook install",
        "",
        "# Prefixes to strip from project names in the session browser",
        "# Edit this and restart Claude Code to change",
        f'CLAUDE_OFFICE_STRIP_PREFIXES="{values["CLAUDE_OFFICE_STRIP_PREFIXES"]}"',
        "",
        "# Set to 1 to enable debug logging",
        f"CLAUDE_OFFICE_DEBUG={values['CLAUDE_OFFICE_DEBUG']}",
        "",
        "# API key for backend authentication",
        f'CLAUDE_OFFICE_API_KEY="{key}"',
    ]
    if url:
        lines += ["", "# Backend events endpoint (default http://localhost:8000/api/v1/events)"]
        lines.append(f'CLAUDE_OFFICE_API_URL="{url}"')
    relay_cmd = relay if relay is not None else existing.get("CLAUDE_OFFICE_RELAY", "")
    if relay_cmd:
        values["CLAUDE_OFFICE_RELAY"] = relay_cmd
        lines += [
            "",
            "# WSL: Windows hook that relays events when the app is not reachable on",
            "# localhost (NAT networking). Set by the Claude Office desktop app.",
            f'CLAUDE_OFFICE_RELAY="{relay_cmd}"',
        ]
    lines += extra

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".env.tmp")
    tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    with contextlib.suppress(OSError):
        path.chmod(0o600)  # holds a secret
    return values


# ---------------------------------------------------------------------------
# Status (machine-readable, for the desktop app)
# ---------------------------------------------------------------------------


def _is_our_command(cmd: str) -> bool:
    return BARE_HOOK_CMD in cmd or "claude-office/hooks/" in cmd


def _entry_command(entry: Any) -> str | None:
    """The first hook command of a settings entry, or None when malformed."""
    try:
        cmd: Any = cast(dict[str, Any], entry).get("hooks", [])[0].get("command", "")
    except (IndexError, AttributeError, TypeError):
        return None
    return cmd if isinstance(cmd, str) else None


def get_status(config_file: Path) -> dict[str, Any]:
    """Describe the current integration state. Never includes the API key."""
    settings_path = get_settings_path()
    settings = load_settings(settings_path)
    hooks_config = settings.get("hooks", {})
    installed: list[str] = []
    commands: set[str] = set()
    if isinstance(hooks_config, dict):
        for hook_type, entries in cast(dict[str, Any], hooks_config).items():
            for entry in cast(list[Any], entries) if isinstance(entries, list) else []:
                cmd = _entry_command(entry)
                if cmd is not None and _is_our_command(cmd):
                    installed.append(hook_type)
                    commands.add(cmd.rsplit(" ", 1)[0])
    values, _ = _read_env_file(config_file)
    sl = _statusline_of(settings)
    return {
        "settings_path": str(settings_path),
        "installed_hooks": sorted(set(installed)),
        "missing_hooks": [h for h in HOOK_TYPES if h not in installed],
        "hook_commands": sorted(commands),
        "config_file": str(config_file),
        "config_present": config_file.exists(),
        "api_key_present": bool(values.get("CLAUDE_OFFICE_API_KEY")),
        "api_url": values.get("CLAUDE_OFFICE_API_URL") or None,
        "relay": values.get("CLAUDE_OFFICE_RELAY") or None,
        "statusline_wrapped": sl is not None and is_wrapped(sl["command"]),
    }


# ---------------------------------------------------------------------------
# Statusline self-test (portable: no `echo` binary needed on Windows)
# ---------------------------------------------------------------------------


def statusline_selftest(hook_cmd: str) -> bool:
    """True when ``<hook> statusline -- <hook> --version`` relays the child's output."""
    exe = shutil.which(hook_cmd) or hook_cmd
    env = {**os.environ, "CLAUDE_OFFICE_STATUSLINE_DRY_RUN": "1"}
    try:
        proc = subprocess.run(  # noqa: S603 - our own binary
            [exe, "statusline", "--", exe, "--version"],
            input=b"{}",
            env=env,
            capture_output=True,
            timeout=STATUSLINE_VERIFY_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.stdout.decode(errors="replace").startswith(BARE_HOOK_CMD)


# ---------------------------------------------------------------------------
# CLI: claude-office-hook install | uninstall | status
# ---------------------------------------------------------------------------


def _print_json(obj: Any) -> None:
    sys.stdout.write(json.dumps(obj, indent=2) + "\n")


def cli(argv: list[str]) -> int:
    """Entry point for the management subcommands. Returns the exit code."""
    from claude_office_hooks.config import CONFIG_FILE
    from claude_office_hooks.debug_logger import DEBUG_LOG_PATH

    parser = argparse.ArgumentParser(prog="claude-office-hook")
    sub = parser.add_subparsers(dest="action", required=True)

    p_install = sub.add_parser("install", help="Register hooks in Claude Code settings")
    p_install.add_argument("--hook-cmd", help="Command/path to register (default: this binary)")
    p_install.add_argument("--api-url", help="Backend events URL ('' to reset to default)")
    p_install.add_argument("--api-key", help="Key to use only if none is configured yet")
    p_install.add_argument(
        "--replace-api-key",
        action="store_true",
        help="Overwrite an existing key with --api-key (the caller runs the backend)",
    )
    p_install.add_argument(
        "--relay",
        help="WSL: path of the Windows hook to relay through when localhost is refused "
        "('' to remove)",
    )
    p_install.add_argument("--strip-prefixes", help="Comma-separated project-name prefixes")
    p_install.add_argument("--statusline", action="store_true", help="Also wrap statusLine")
    p_install.add_argument("--force", action="store_true", help="Reset managed config keys")
    p_install.add_argument("--dry-run", action="store_true")
    p_install.add_argument("--json", action="store_true", help="Print status JSON when done")

    p_uninstall = sub.add_parser("uninstall", help="Remove hooks and restore statusLine")
    p_uninstall.add_argument("--keep-config", action="store_true", help="Keep config + log")
    p_uninstall.add_argument("--dry-run", action="store_true")
    p_uninstall.add_argument("--json", action="store_true", help="Print status JSON when done")

    sub.add_parser("status", help="Print the integration state as JSON")

    # Legacy actions used by older install.sh/uninstall.sh copies.
    for legacy in ("wrap-statusline", "unwrap-statusline", "verify-statusline"):
        p_legacy = sub.add_parser(legacy)
        p_legacy.add_argument("--hook-cmd", default=BARE_HOOK_CMD)
        p_legacy.add_argument("--dry-run", action="store_true")

    args = parser.parse_args(argv)

    if args.action == "status":
        _print_json(get_status(CONFIG_FILE))
        return 0

    if args.action == "install":
        raw_cmd = args.hook_cmd or default_hook_cmd()
        hook_cmd = format_hook_cmd(raw_cmd)
        if not args.dry_run:
            write_config(
                CONFIG_FILE,
                api_key=args.api_key,
                api_url=args.api_url,
                strip_prefixes=args.strip_prefixes,
                force=args.force,
                replace_key=args.replace_api_key,
                relay=args.relay,
            )
            print(f"Configuration saved to {CONFIG_FILE}")
        install_hooks(hook_cmd, args.dry_run)
        if args.statusline:
            if statusline_selftest(raw_cmd):
                wrap_statusline(hook_cmd, args.dry_run)
                if not args.dry_run:
                    verify_statusline()
            else:
                print("  [Warn] statusLine: self-test failed; statusLine left untouched.")
        if args.json:
            _print_json(get_status(CONFIG_FILE))
        else:
            print("Done. Restart Claude Code to apply the changes.")
        return 0

    if args.action == "uninstall":
        unwrap_statusline(args.dry_run)
        uninstall_hooks(BARE_HOOK_CMD, args.dry_run)
        if not args.keep_config and not args.dry_run:
            CONFIG_FILE.unlink(missing_ok=True)
            DEBUG_LOG_PATH.unlink(missing_ok=True)
        if args.json:
            _print_json(get_status(CONFIG_FILE))
        return 0

    hook_cmd = format_hook_cmd(args.hook_cmd)
    if args.action == "wrap-statusline":
        wrap_statusline(hook_cmd, args.dry_run)
    elif args.action == "unwrap-statusline":
        unwrap_statusline(args.dry_run)
    else:
        verify_statusline()
    return 0


def main() -> None:
    sys.exit(cli(sys.argv[1:]))


if __name__ == "__main__":
    main()
