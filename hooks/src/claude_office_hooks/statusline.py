"""Status line tee: forward Claude Code's status line JSON to the backend.

``claude-office-hook statusline -- <original command...>`` reads stdin once,
POSTs the JSON to the backend fire-and-forget (never blocking or failing the
status line), then runs the original command with the same stdin and relays its
stdout unchanged. Exit code is the wrapped command's (0 with no command).

Pure helpers live here (no stdout suppression, unlike ``main``) so they can be
unit tested; ``main`` wires in the real transport.
"""

from __future__ import annotations

import subprocess
import sys
import threading
from collections.abc import Callable, Sequence

from claude_office_hooks.debug_logger import log_error

__all__ = ["POST_TIMEOUT", "telemetry_url", "run_statusline"]

POST_TIMEOUT = 0.15  # seconds: hard cap for the fire-and-forget POST


def telemetry_url(events_url: str) -> str:
    """Derive the telemetry endpoint from the configured events URL."""
    base = events_url.rstrip("/")
    if base.endswith("/events"):
        base = base[: -len("/events")]
    return f"{base}/telemetry/statusline"


def run_statusline(
    command: Sequence[str],
    stdin_data: bytes,
    post: Callable[[bytes], None],
    stdout_write: Callable[[bytes], None],
) -> int:
    """Tee *stdin_data* to *post* (best effort) and run *command* with it."""

    def _post() -> None:
        try:
            if stdin_data.strip():
                post(stdin_data)
        except Exception as exc:  # never disturb the status line
            log_error(exc, "statusline post failed")

    thread = threading.Thread(target=_post, daemon=True)
    thread.start()

    code = 0
    if command:
        try:
            proc = subprocess.run(  # noqa: S603 - the user's own configured command
                list(command),
                input=stdin_data,
                stdout=subprocess.PIPE,
                stderr=None,
                check=False,
            )
            stdout_write(proc.stdout)
            code = proc.returncode
        except Exception as exc:
            log_error(exc, "statusline wrapped command failed")
            code = 127
    thread.join(POST_TIMEOUT)
    return code


def read_stdin() -> bytes:
    stream = sys.__stdin__
    try:
        if stream is None or stream.closed or stream.isatty():
            return b""
        return bytes(stream.buffer.read())
    except Exception as exc:
        log_error(exc, "statusline stdin read failed")
        return b""
