"""WSL → Windows relay (desktop app on Windows, Claude Code inside WSL).

In WSL's default NAT networking, ``127.0.0.1`` inside the distro is not the
Windows loopback, so the hook's POST to the desktop app is refused. WSL can run
Windows executables directly (interop), so when the desktop app connects a
distro it writes ``CLAUDE_OFFICE_RELAY=/mnt/c/.../claude-office-hook.exe``
(the *Windows* hook) into the distro's config. On a refused connection the
Linux hook pipes the already-built payload to ``<relay> relay <kind>``; the
Windows hook POSTs it to the app on Windows' loopback with its own key.

Direct POST stays first: with mirrored networking it simply works and costs
nothing, and a refused loopback connection fails in about a millisecond.

Pure helpers (no stdout/stderr), importable from ``main`` after its output
suppression.
"""

from __future__ import annotations

import errno
import os
import subprocess
import urllib.error
from collections.abc import Callable
from typing import Any

RELAY_KEY = "CLAUDE_OFFICE_RELAY"
# Spawning a Windows process from WSL takes ~0.1-0.3 s; hooks time out at 2 s.
RELAY_TIMEOUT = 1.5
KINDS = ("events", "statusline")


def relay_command(config: dict[str, str]) -> str:
    """The relay executable from the environment or the config file ('' if none)."""
    return os.environ.get(RELAY_KEY) or config.get(RELAY_KEY, "")


def is_connection_refused(exc: BaseException) -> bool:
    """True for "nothing listening there" (the NAT case), not for HTTP errors."""
    if isinstance(exc, urllib.error.HTTPError):
        return False
    reason: Any = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, ConnectionRefusedError):
        return True
    return isinstance(reason, OSError) and reason.errno == errno.ECONNREFUSED


def relay(
    command: str,
    kind: str,
    body: bytes,
    run: Callable[..., Any] = subprocess.run,
) -> bool:
    """Hand *body* to ``<command> relay <kind>``; True when it reported success."""
    if not command or kind not in KINDS or not os.path.isfile(command):
        return False
    try:
        proc = run(
            [command, "relay", kind],
            input=body,
            capture_output=True,
            timeout=RELAY_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return getattr(proc, "returncode", 1) == 0
