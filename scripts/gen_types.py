#!/usr/bin/env python3
"""Generate TypeScript types from Pydantic backend models.

Usage:
    cd backend && uv run python ../scripts/gen_types.py

Outputs ../frontend/src/types/generated.ts via json-schema-to-typescript.
"""

import json
import subprocess
import sys
from pathlib import Path

# Must run from backend/ directory so imports resolve
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from app.models.agents import (  # noqa: E402  # type: ignore[import]
    Agent,
    Boss,
    OfficeState,
)
from app.models.campus import (  # noqa: E402  # type: ignore[import]
    CampusActivity,
    CampusSession,
    CampusState,
    SessionPhase,
)
from app.models.ci import (  # noqa: E402  # type: ignore[import]
    CampusProject,
    CheckRun,
    CheckSummary,
    LocalCommit,
    LocalGitState,
    LocalWorktree,
    PipelineRun,
    PrLabel,
    PullRequestInfo,
    ReleaseInfo,
)
from app.models.common import (  # noqa: E402  # type: ignore[import]
    BubbleContent,
    SpeechContent,
    TodoItem,
)
from app.models.console import (  # noqa: E402  # type: ignore[import]
    AgentNode,
    ConsoleHeader,
    ConsoleSnapshot,
    ToolCall,
    ToolCallDetail,
)
from app.models.events import (  # noqa: E402  # type: ignore[import]
    AgentEventData,
    BackgroundTaskEventData,
    Event,
    EventData,
    EventDataBase,
    LifecycleEventData,
    PromptEventData,
    SessionEventData,
    TaskEventData,
    ToolEventData,
)
from app.models.git import (  # noqa: E402  # type: ignore[import]
    ChangedFile,
    ClientGit,
    Commit,
    GitStatus,
)
from app.models.overview import OverviewEntry, OverviewState  # noqa: E402  # type: ignore[import]
from app.models.sessions import (  # noqa: E402  # type: ignore[import]
    AgentLifespan,
    BackgroundTask,
    FileEdit,
    GameState,
    NewsItem,
    Session,
    WhiteboardData,
)
from app.models.telemetry import (  # noqa: E402  # type: ignore[import]
    CampusStats,
    RateLimitWindow,
    SessionActivityStats,
    SessionTelemetry,
)
from pydantic.json_schema import models_json_schema  # noqa: E402

# All Pydantic BaseModel subclasses to generate types for
# (TypedDict classes like ConversationEntry and HistoryEntry are not BaseModel
# subclasses so they cannot be used with models_json_schema; they are handled
# manually in index.ts)
MODELS = [
    Agent,
    Boss,
    OfficeState,
    BubbleContent,
    SpeechContent,
    TodoItem,
    # Legacy event models (kept for compatibility; producers still emit the
    # flat wire format that the union below parses). The frontend consumes
    # ``Event`` / ``EventData`` / ``EventType`` from these — the family event
    # models (SessionEvent, ToolEvent, ...) are intentionally NOT emitted
    # because their ``event_type: Literal[...]`` fields collide with the
    # ``EventType`` StrEnum and would shrink the frontend's union.
    Event,
    EventData,
    # ARC-014 family payload classes (base + per-family). Emitted for
    # downstream type discovery; the wire format itself is unchanged.
    EventDataBase,
    SessionEventData,
    ToolEventData,
    PromptEventData,
    AgentEventData,
    LifecycleEventData,
    TaskEventData,
    BackgroundTaskEventData,
    AgentLifespan,
    BackgroundTask,
    FileEdit,
    NewsItem,
    WhiteboardData,
    Session,
    GameState,
    ChangedFile,
    Commit,
    GitStatus,
    ClientGit,
    OverviewEntry,
    OverviewState,
    CampusActivity,
    CampusSession,
    CampusState,
    SessionPhase,
    CampusStats,
    RateLimitWindow,
    SessionActivityStats,
    SessionTelemetry,
    CampusProject,
    CheckRun,
    CheckSummary,
    LocalCommit,
    LocalGitState,
    LocalWorktree,
    PipelineRun,
    PrLabel,
    PullRequestInfo,
    ReleaseInfo,
    # Session Console (docs/design/session-console.md, section 3.3).
    ToolCall,
    AgentNode,
    ConsoleHeader,
    ConsoleSnapshot,
    ToolCallDetail,
]

# Generate combined JSON schema with camelCase field names (by_alias=True)
_, full_schema = models_json_schema(
    [(m, "serialization") for m in MODELS],
    title="Claude Office Backend Types",
    by_alias=True,
)

# Write schema to temp file next to this script
schema_path = Path(__file__).parent / ".gen_types_schema.json"
schema_path.write_text(json.dumps(full_schema, indent=2), encoding="utf-8")

# Convert to TypeScript
output_path = Path(__file__).parent.parent / "frontend" / "src" / "types" / "generated.ts"
try:
    result = subprocess.run(
        [
            "bunx",
            "json2ts",
            "--input",
            str(schema_path),
            "--output",
            str(output_path),
            "--unreachableDefinitions",
        ],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(Path(__file__).parent.parent / "frontend"),
    )
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    # json2ts formats with its own bundled prettier defaults; re-format with the
    # frontend's config so `make fmt` (prettier --write .) never rewrites the file.
    subprocess.run(
        ["bunx", "prettier", "--write", str(output_path)],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(Path(__file__).parent.parent / "frontend"),
    )
except subprocess.CalledProcessError as e:
    print(f"Error generating types: {e.stderr}", file=sys.stderr)
    sys.exit(1)
finally:
    schema_path.unlink(missing_ok=True)

print(f"Generated: {output_path}")
