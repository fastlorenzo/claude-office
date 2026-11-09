#!/bin/bash
# Developer uninstall: restore statusLine, remove the hook entries, delete the
# config + log (`claude-office-hook uninstall`), then drop the uv tool.
set -e

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Uninstalling hooks..."
uv run --project "$HOOKS_DIR" python -m claude_office_hooks uninstall

# uv tool uninstall takes the package name (claude-office-hooks, plural); the
# console-script command is the singular claude-office-hook.
echo "Removing claude-office-hooks tool..."
uv tool uninstall claude-office-hooks 2>/dev/null || true

echo "Done! Hooks removed from configuration."
