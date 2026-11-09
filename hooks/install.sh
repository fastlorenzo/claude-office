#!/bin/bash
# Developer install: put claude-office-hook on PATH (uv tool) and register it in
# Claude Code's settings. The logic lives in `claude-office-hook install`
# (claude_office_hooks/manage.py), shared with the desktop app.
set -e

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v uv &> /dev/null; then
    echo "Error: 'uv' is not installed. Please install it first."
    exit 1
fi

ARGS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --strip-prefixes)
            ARGS+=(--strip-prefixes "$2")
            shift 2
            ;;
        --force|--statusline)
            ARGS+=("$1")
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--strip-prefixes 'prefix1,prefix2'] [--force] [--statusline]"
            echo "  --strip-prefixes  Comma-separated path prefixes to strip from project names"
            echo "  --force           Reset managed keys (prefixes/debug) to defaults, discarding user edits;"
            echo "                    the API key and any user-added keys are still preserved."
            echo "  --statusline      Also wrap statusLine.command so status line telemetry (model, cost,"
            echo "                    rate limits) reaches the office; uninstall.sh restores the original"
            exit 1
            ;;
    esac
done

echo "Installing claude-office-hook tool from: $HOOKS_DIR"
(cd "$HOOKS_DIR" && uv tool install --force --reinstall -p 3.14 .)

if ! command -v claude-office-hook &> /dev/null; then
    echo "Warning: 'claude-office-hook' not found in PATH. You may need to add ~/.local/bin to your PATH."
fi

# Register the bare command name (on PATH via uv tool) for cross-platform use.
uv run --project "$HOOKS_DIR" python -m claude_office_hooks install \
    --hook-cmd claude-office-hook "${ARGS[@]}"

echo ""
echo "Configuration file: $HOME/.claude/claude-office-config.env"
echo "Edit this file to customize strip prefixes, then restart Claude Code."
