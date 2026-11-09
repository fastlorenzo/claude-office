"""Standalone server entry point (``claude-office-server`` / ``python -m app``).

Used by the desktop app, which runs a frozen build of this module as a sidecar.
It passes the app object to uvicorn (not an ``"app.main:app"`` import string)
so it works inside a PyInstaller bundle, and with ``--exit-on-stdin-close`` it
shuts down when the parent process goes away (the parent holds the write end
of our stdin pipe; EOF means it exited or crashed), so no orphan server keeps
the port bound.
"""

import argparse
import os
import sys
import threading

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


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="claude-office-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--log-level", default="info")
    parser.add_argument(
        "--exit-on-stdin-close",
        action="store_true",
        help="Shut down when stdin reaches EOF (the parent process exited).",
    )
    args = parser.parse_args(argv)

    # Imported late so --help works without touching settings or the DB.
    from app.main import app

    config = uvicorn.Config(app, host=args.host, port=args.port, log_level=args.log_level)
    server = uvicorn.Server(config)
    if args.exit_on_stdin_close:
        threading.Thread(target=_watch_stdin, args=(server,), daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
