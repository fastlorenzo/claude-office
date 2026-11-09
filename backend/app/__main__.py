"""Standalone server entry point (``claude-office-server`` / ``python -m app``).

Used by the desktop app, which runs a frozen build of this module as a sidecar.
It passes the app object to uvicorn (not an ``"app.main:app"`` import string)
so it works inside a PyInstaller bundle, and with ``--exit-on-stdin-close`` it
shuts down when the parent process goes away (the parent holds the write end
of our stdin pipe; EOF means it exited or crashed), so no orphan server keeps
the port bound.
"""

import argparse
import importlib
import os
import sys
import threading
from collections.abc import Callable
from typing import Any

import uvicorn

# Hard-exit deadline after a graceful shutdown request, in seconds.
_FORCE_EXIT_AFTER = 5.0


def _watch_stdin(server: uvicorn.Server) -> None:
    """Block until stdin hits EOF, then ask uvicorn to stop (force after a delay)."""
    try:
        while sys.stdin.buffer.read(4096):
            pass
    except (OSError, ValueError):
        pass
    server.should_exit = True
    timer = threading.Timer(_FORCE_EXIT_AFTER, lambda: os._exit(0))
    timer.daemon = True
    timer.start()


def simulate(argv: list[str]) -> int:
    """Run a simulation scenario (``scripts/scenarios``) against a backend.

    ``POST /api/v1/sessions/simulate`` starts this as a child process (with the
    server's own events URL and key in the environment), so it works in the
    frozen desktop backend, where neither ``uv`` nor ``scripts/`` exist on disk.
    """
    if not getattr(sys, "frozen", False):
        # Source checkout: scripts/ sits next to backend/.
        repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        if repo_root not in sys.path:
            sys.path.insert(0, repo_root)
    # scripts/ is outside the typed backend package (and bundled into the frozen
    # server via hiddenimports in packaging/server.spec): typed boundary here.
    scenarios: dict[str, Callable[[Any], None]] = importlib.import_module(
        "scripts.scenarios"
    ).SCENARIOS
    simulation_context: Callable[..., Any] = importlib.import_module(
        "scripts.scenarios._base"
    ).SimulationContext
    parser = argparse.ArgumentParser(prog="claude-office-server simulate")
    parser.add_argument("scenario", nargs="?", default="complex", choices=sorted(scenarios))
    parser.add_argument("--session", default="sim_session_123")
    args = parser.parse_args(argv)
    ctx = simulation_context(session_id=args.session, verbose=False)
    scenarios[args.scenario](ctx)
    failures: int = ctx.failures
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> None:
    raw = sys.argv[1:] if argv is None else argv
    if raw[:1] == ["simulate"]:
        sys.exit(simulate(raw[1:]))

    parser = argparse.ArgumentParser(prog="claude-office-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--log-level", default="info")
    parser.add_argument(
        "--exit-on-stdin-close",
        action="store_true",
        help="Shut down when stdin reaches EOF (the parent process exited).",
    )
    args = parser.parse_args(raw)

    # Imported late so --help works without touching settings or the DB.
    from app.main import app

    config = uvicorn.Config(app, host=args.host, port=args.port, log_level=args.log_level)
    server = uvicorn.Server(config)
    if args.exit_on_stdin_close:
        threading.Thread(target=_watch_stdin, args=(server,), daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
