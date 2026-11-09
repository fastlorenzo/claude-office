"""``python -m claude_office_hooks`` and the frozen-binary entry point.

Mirrors the guard in ``main.py``'s ``__main__`` block: as a Claude Code hook
this must never surface a traceback or a non-zero exit. ``SystemExit`` passes
through so the management subcommands (install/uninstall/status) and
``--version``/``--help`` keep their exit codes.
"""

import sys

from claude_office_hooks.debug_logger import log_error

try:
    from claude_office_hooks.main import main

    main()
except SystemExit:
    raise
except Exception as exc:
    log_error(exc, "Error in frozen entry point")
sys.exit(0)
