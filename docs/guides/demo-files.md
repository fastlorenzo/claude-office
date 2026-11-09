# Demo Files

Play your own event streams in the office, for demos, screenshots or talks,
without a live Claude Code session. A demo file is a recorded or hand-written
sequence of hook events. The desktop app and a source checkout both play them.

## Table of Contents

- [Quick Start](#quick-start)
- [Recording a Real Session](#recording-a-real-session)
- [File Format](#file-format)
- [Playback Options](#playback-options)
- [Command Line and API](#command-line-and-api)
- [Privacy](#privacy)

## Quick Start

1. Open **⋯ More → Play demo file…** in the header.
2. Pick a `.jsonl` file, for example
   [`scripts/demos/checkout-feature.jsonl`](../../scripts/demos/checkout-feature.jsonl).
3. The office switches to the demo's room (`demo_session`) and plays it.

A malformed file is rejected straight away, and the toast names the bad line.
Playing a demo stops any simulation that is already running. **⋯ More → Clear
DB** removes the demo sessions again.

## Recording a Real Session

Select the session, then **⋯ More → Export as demo**. You get a demo file that
replays that session's events with their original timing. Pauses longer than
3 s are shortened (`max_gap` in its first line, which you can edit).

To start a hand-written demo from a template, run **Simulate**, export the
simulated session, and edit the file.

## File Format

JSON Lines (one JSON object per line), UTF-8:

```jsonl
# Lines starting with # are comments; blank lines are ignored.
{"claude_office_demo": 1, "name": "Apple Pay checkout", "speed": 1, "max_gap": 3}
{"t": 0, "event_type": "session_start", "data": {"project_name": "acme-shop"}}
{"t": 1.5, "event_type": "user_prompt_submit", "data": {"prompt": "Add Apple Pay"}}
{"delay": 1, "event_type": "subagent_start", "data": {"agent_id": "pay_api", "task_description": "Build the payment API"}}
{"event_type": "stop"}
```

| Field | Where | Meaning |
|-------|-------|---------|
| `claude_office_demo` | header (optional) | Format version, `1` |
| `name` | header | Shown when the demo starts |
| `speed`, `max_gap` | header | Playback defaults (see below) |
| `event_type` | event, required | A hook event type: `session_start`, `user_prompt_submit`, `pre_tool_use`, `post_tool_use`, `permission_request`, `subagent_start`, `subagent_stop`, `task_created`, `task_completed`, `background_task_notification`, `context_compaction`, `stop`, `session_end`, ... |
| `data` | event | The event payload, as the hooks send it |
| `t` | event | Seconds since the start of the demo |
| `delay` | event | Seconds after the previous event |
| `session_id` | event | Groups events into rooms (default: one room) |

An event with neither `t` nor `delay` follows the previous one after 0.5 s.

**Rooms:** playback renames the file's sessions to `demo_session`,
`demo_session_2`, ... in the order they first appear. A demo therefore never
writes into one of your real sessions, and playing it again reuses the same
room. Give events different `session_id`s for a multi-room demo.

**Payloads:** the built-in scenarios in
[`scripts/scenarios/`](../../scripts/scenarios/) show every event type with
realistic `data` (`quick.py` is the shortest). Useful fields include
`agent_id` (`"main"` for the boss), `tool_name`, `tool_input`,
`task_description`, `speech_content`, and `input_tokens` / `output_tokens`,
which fill the context meter.

## Playback Options

- `speed`: playback speed factor (`2` = twice as fast).
- `max_gap`: no pause lasts longer than this many seconds, applied before `speed`.

The header sets the defaults. The command line and API override them.

## Command Line and API

```bash
# Desktop app's bundled server (or `uv run python -m app` from backend/)
claude-office-server simulate --file demo.jsonl [--speed 2] [--max-gap 3] [--session pitch]

# Any HTTP client: same validation as the menu item
curl -X POST "http://127.0.0.1:8000/api/v1/sessions/simulate/file?speed=2" \
  -H "X-API-Key: $KEY" --data-binary @demo.jsonl

# Export a session
curl -H "X-API-Key: $KEY" http://127.0.0.1:8000/api/v1/sessions/<id>/export -o demo.jsonl
```

The CLI reads the server URL and key from `CLAUDE_OFFICE_API_URL` and
`CLAUDE_OFFICE_API_KEY`. The desktop app keeps its key in
`~/.claude/claude-office-config.env` (`%USERPROFILE%\.claude\` on Windows).

Limits: 20 MB and 50,000 events per file. The backend accepts up to 1,000
events per minute per session, so a large export played at high `speed` can
drop events.

## Privacy

An export leaves out transcript paths and the WSL distro name, but it keeps
everything else the hooks reported: **prompts, shell commands, file paths and
task descriptions**. Read a real session's export before you share it, and
edit out anything private. It is plain text.
