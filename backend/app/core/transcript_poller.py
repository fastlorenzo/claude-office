"""Poll subagent transcript files for tool use events in real-time."""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, cast

from app.config import get_settings
from app.core.base_poller import BasePoller
from app.core.path_utils import is_safe_transcript_path
from app.models.common import BubbleContent, BubbleType
from app.models.events import (
    AgentEvent,
    AgentEventData,
    AnyEvent,
    EventType,
    ToolEvent,
    ToolEventData,
)

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 1.0

# Hard upper bound: stop polling a transcript that has not grown for this
# long. A resume (native SubagentStart) restarts polling at the kept offset.
# Kept high: a quiet stretch (long thinking, a long build, background work)
# must not end polling while the agent still works.
INACTIVITY_TIMEOUT = timedelta(minutes=60)

# Completion (``source="transcript_end"`` stop): the transcript's last turn
# ended with a hand-back (a tool_result flagged ``toolEndsTurn``, e.g.
# SubagentHandback) and the file has been quiet this long ...
HANDBACK_QUIET = timedelta(seconds=5)
# ... or with a final assistant message (no tool_use) and the subagent's
# ``.meta.json`` says ``finished`` and the file has been quiet this long.
FINAL_QUIET = timedelta(minutes=10)

# At most this much transcript is read per poll tick (line-aligned), so a
# backfill of a large transcript never loads it whole.
MAX_READ_BYTES = 4 * 1024 * 1024

_FINAL_STOP_REASONS = ("end_turn", "stop_sequence")


def _zombie_timeout() -> timedelta:
    """Return the configured zombie-subagent timeout as a timedelta."""
    return timedelta(seconds=get_settings().ZOMBIE_SUBAGENT_TIMEOUT_SECONDS)


def _record_time(record: dict[str, Any]) -> datetime | None:
    """The transcript line's own timestamp (when the call really happened)."""
    raw = record.get("timestamp")
    if not isinstance(raw, str) or not raw:
        return None
    try:
        stamp = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return stamp if stamp.tzinfo else stamp.replace(tzinfo=UTC)


def _meta_finished(transcript: Path) -> bool:
    """Whether ``agent-<id>.meta.json`` next to *transcript* says ``finished``."""
    try:
        raw = json.loads(transcript.with_suffix(".meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return isinstance(raw, dict) and cast(dict[str, Any], raw).get("finished") is True


TurnEnd = str | None  # "handback" | "final" | None (mid-turn / unknown)


@dataclass
class PolledAgent:
    """Tracks state for a polled subagent transcript."""

    agent_id: str
    session_id: str
    transcript_path: Path
    file_position: int = 0
    last_activity: datetime = field(default_factory=lambda: datetime.now(UTC))
    active_tool_ids: set[str] = field(default_factory=lambda: set[str]())
    # Nested Task/Agent calls in flight: active (no zombie) but no post row.
    spawn_tool_ids: set[str] = field(default_factory=lambda: set[str]())
    last_thinking_hash: int = 0
    last_text_hash: int = 0
    # How the last turn in the file ended (see ``_track_turn``).
    turn_end: TurnEnd = None
    # Reading old content from the start: thinking/text bubbles are skipped.
    catching_up: bool = False
    # One-shot backfill of a finished agent: stop once the file is read.
    until_eof: bool = False
    zombie_reported: bool = False


class TranscriptPoller(BasePoller[PolledAgent]):
    """Polls subagent transcript files for tool use events.

    Registry key is ``agent_id`` (one poll task per subagent transcript);
    the owning session id lives on :class:`PolledAgent`.
    """

    def _get_poll_interval(self) -> float:
        # Read live so test patches to POLL_INTERVAL_SECONDS apply.
        return POLL_INTERVAL_SECONDS

    def __init__(self, event_callback: Any) -> None:
        """Initialize the poller with an event callback function."""
        super().__init__()
        self._event_callback = event_callback
        # Last read offset per agent, kept across stop/start: an async agent
        # stops at every turn end and resumes later (SubagentStart again).
        self._positions: dict[str, int] = {}
        # The last poll state per agent: a restart carries its in-flight tool
        # ids and turn end over (the posts of calls read before the stop).
        self._last_state: dict[str, PolledAgent] = {}
        # Deferred stops (see ``schedule_stop``), cancelled by a restart.
        self._pending_stops: dict[str, asyncio.Task[None]] = {}

    def schedule_stop(self, agent_id: str, delay: float = 3.0) -> None:
        """Stop polling *agent_id* after *delay* seconds.

        A SubagentStop arrives as soon as the agent's turn ends, usually
        before the poller has read the last tool results; polling a little
        longer drains that tail. A resume (``start_polling``) cancels it.
        """
        pending = self._pending_stops.pop(agent_id, None)
        if pending is not None:
            pending.cancel()

        async def _later() -> None:
            await asyncio.sleep(delay)
            self._pending_stops.pop(agent_id, None)
            await self.stop_polling(agent_id)

        self._pending_stops[agent_id] = asyncio.create_task(_later(), name=f"stop_{agent_id}")

    async def start_polling(
        self,
        agent_id: str,
        session_id: str,
        transcript_path: str,
        until_eof: bool = False,
    ) -> None:
        """Start (or keep) polling a subagent's transcript file.

        Resumes from the last offset read for this agent. A first start (the
        transcript discovered, linked or relinked, or a backend restart) reads
        it from the beginning: calls already tracked are deduplicated by
        ``tool_use_id`` downstream, and the ones missed are backfilled.

        *until_eof* makes it a one-shot backfill (a finished agent): polling
        ends once the file has been read. A plain start on an agent being
        backfilled turns it back into normal polling.
        """
        pending = self._pending_stops.pop(agent_id, None)
        if pending is not None:
            pending.cancel()
        if await self.is_polling(agent_id):
            if not until_eof:
                async with self._lock:
                    current = self._sessions.get(agent_id)
                    if current is not None:
                        current.until_eof = False
            return
        settings = get_settings()
        translated_path = settings.translate_path(transcript_path)
        # Validate and poll the TRANSLATED path: hooks report host-form paths,
        # and the container only accepts paths under its own roots (Docker).
        path = Path(translated_path).expanduser()

        if not is_safe_transcript_path(path):
            logger.warning(f"Rejected transcript path outside ~/.claude/: {translated_path}")
            return

        agent = PolledAgent(
            agent_id=agent_id,
            session_id=session_id,
            transcript_path=path,
            until_eof=until_eof,
        )
        known = self._positions.get(agent_id)
        previous = self._last_state.get(agent_id)
        if known is not None:
            agent.file_position = known
            if previous is not None:
                agent.active_tool_ids = set(previous.active_tool_ids)
                agent.spawn_tool_ids = set(previous.spawn_tool_ids)
                agent.turn_end = previous.turn_end
        else:
            agent.catching_up = True
        self._last_state[agent_id] = agent

        await self._register_polling(agent_id, agent, task_name=f"poll_{agent_id}")
        logger.info(f"Started polling agent {agent_id} at {transcript_path}")

    async def _check(self, key: str, state: PolledAgent) -> None:
        """Poll one iteration: read new content, then completion / zombie / timeout.

        Completion: the transcript's last turn ended (a hand-back, or a final
        message with ``.meta.json`` ``finished``), nothing is in flight and the
        file has been quiet long enough: emits one synthetic SUBAGENT_STOP
        (``source="transcript_end"``) and ends polling (the offset is kept, so
        a resume carries on from there).

        Zombie: no growth past the zombie threshold, nothing in flight and no
        clean turn end: emits one synthetic SUBAGENT_STOP (``source="zombie"``)
        but keeps polling. The guess is often wrong (long thinking, an async
        agent between turns), and its later calls must still be read.

        Hard inactivity timeout: ends polling.
        """
        events = await self._read_new_content(state)
        if events:
            state.zombie_reported = False
        for event in events:
            try:
                await self._event_callback(event)
            except Exception as e:
                logger.warning(f"Error processing polled event: {e}")

        if await self._check_completion(key, state):
            return

        if state.until_eof and not state.catching_up:
            # One-shot backfill done (catching_up clears at end of file).
            async with self._lock:
                if self._sessions.get(key) is state:
                    self._sessions.pop(key, None)
            return

        inactivity = datetime.now(UTC) - state.last_activity
        zombie_timeout = _zombie_timeout()
        in_flight = bool(state.active_tool_ids or state.spawn_tool_ids)

        # Zombie detection: emit a synthetic SubagentStop so the state machine
        # can clean up the orphaned agent. This covers cases where Claude Code
        # never sends SubagentStop itself (rate-limit, crash, user interrupt).
        # A tool call still in flight (a long build, a wait on a lock) is not
        # a dead agent, and a hand-back is a clean end (completion covers it).
        if (
            inactivity > zombie_timeout
            and not in_flight
            and not state.zombie_reported
            and state.turn_end != "handback"
        ):
            state.zombie_reported = True
            zombie_event = self._build_zombie_stop_event(state)
            logger.warning(
                f"Agent {key} appears to be a zombie "
                f"(no transcript activity for "
                f"{inactivity.total_seconds():.0f}s, "
                f"threshold {zombie_timeout.total_seconds():.0f}s) "
                f"— emitting synthetic SubagentStop on session {state.session_id}"
            )
            try:
                await self._event_callback(zombie_event)
            except Exception as e:
                logger.warning(f"Error dispatching synthetic SubagentStop: {e}")
            return

        # Hard fallback: do not poll a silent file forever.
        if inactivity > INACTIVITY_TIMEOUT:
            logger.debug(f"Agent {key} timed out due to inactivity")
            async with self._lock:
                if self._sessions.get(key) is state:
                    self._sessions.pop(key, None)

    async def _check_completion(self, key: str, state: PolledAgent) -> bool:
        """Emit the transcript-end stop and end polling once the agent is done."""
        if state.turn_end is None or state.active_tool_ids or state.spawn_tool_ids:
            return False
        path = state.transcript_path

        def _quiet_and_finished() -> tuple[timedelta, bool]:
            try:
                mtime = datetime.fromtimestamp(path.stat().st_mtime, UTC)
            except OSError:
                return timedelta(0), False
            quiet = datetime.now(UTC) - mtime
            finished = state.turn_end == "final" and quiet >= FINAL_QUIET and _meta_finished(path)
            return quiet, finished

        quiet, finished = await asyncio.to_thread(_quiet_and_finished)
        done = (state.turn_end == "handback" and quiet >= HANDBACK_QUIET) or finished
        if not done:
            return False
        logger.info(f"Agent {key} transcript ended ({state.turn_end}); ending its polling")
        try:
            await self._event_callback(self._build_end_stop_event(state))
        except Exception as e:
            logger.warning(f"Error dispatching transcript-end SubagentStop: {e}")
        async with self._lock:
            if self._sessions.get(key) is state:
                self._sessions.pop(key, None)
        return True

    def _build_end_stop_event(self, agent: PolledAgent) -> AgentEvent:
        """Synthetic SUBAGENT_STOP for a transcript that ended cleanly."""
        return AgentEvent(
            event_type=EventType.SUBAGENT_STOP,
            session_id=agent.session_id,
            timestamp=datetime.now(UTC),
            data=AgentEventData(
                agent_id=agent.agent_id,
                agent_transcript_path=str(agent.transcript_path),
                source="transcript_end",
            ),
        )

    def _build_zombie_stop_event(self, agent: PolledAgent) -> AgentEvent:
        """Build a synthetic SUBAGENT_STOP for an agent we believe has crashed."""
        return AgentEvent(
            event_type=EventType.SUBAGENT_STOP,
            session_id=agent.session_id,
            timestamp=datetime.now(UTC),
            data=AgentEventData(
                agent_id=agent.agent_id,
                agent_transcript_path=str(agent.transcript_path),
                # Persisted with the row, so a restore also marks the node zombie.
                source="zombie",
            ),
        )

    async def _read_new_content(self, agent: PolledAgent) -> list[AnyEvent]:
        """Read new content from the transcript file and extract events."""
        events: list[AnyEvent] = []

        if not agent.transcript_path.exists():
            return events

        if not is_safe_transcript_path(agent.transcript_path):
            logger.warning(f"Rejected transcript path outside ~/.claude/: {agent.transcript_path}")
            return events

        try:
            path = agent.transcript_path
            position = agent.file_position

            def _read_sync() -> tuple[str, int, bool] | None:
                current_size = path.stat().st_size
                if current_size <= position:
                    return None
                with open(path, "rb") as f:
                    f.seek(position)
                    raw = f.read(MAX_READ_BYTES)
                at_eof = position + len(raw) >= current_size
                if not at_eof:
                    # Line-aligned: the partial last line is read next tick.
                    cut = raw.rfind(b"\n")
                    if cut < 0:
                        return None
                    raw = raw[: cut + 1]
                return raw.decode("utf-8", errors="replace"), position + len(raw), at_eof

            result = await asyncio.to_thread(_read_sync)
            if result is None:
                agent.catching_up = False
                return events

            new_content, new_position, at_eof = result
            agent.file_position = new_position
            self._positions[agent.agent_id] = new_position

            if new_content.strip():
                agent.last_activity = datetime.now(UTC)
                events = self._parse_content(agent, new_content)
            if at_eof:
                agent.catching_up = False

        except OSError as e:
            logger.warning(f"Error reading transcript for {agent.agent_id}: {e}")

        return events

    def _parse_content(self, agent: PolledAgent, content: str) -> list[AnyEvent]:
        """Parse JSONL content and extract tool use, thinking, and text events."""
        events: list[AnyEvent] = []

        for line in content.split("\n"):
            line = line.strip()
            if not line:
                continue

            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            if not isinstance(record, dict):
                continue
            record = cast(dict[str, Any], record)
            record_type = record.get("type")
            stamp = _record_time(record)
            raw_message = record.get("message")
            message: dict[str, Any] = (
                cast(dict[str, Any], raw_message) if isinstance(raw_message, dict) else {}
            )
            raw_blocks = message.get("content")
            content_blocks: list[Any] = (
                cast(list[Any], raw_blocks) if isinstance(raw_blocks, list) else []
            )
            self._track_turn(agent, record, message, content_blocks)

            if record_type == "assistant" and message.get("role") == "assistant":
                for item in content_blocks:
                    if not isinstance(item, dict):
                        continue
                    block = cast(dict[str, Any], item)
                    block_type: str | None = block.get("type")

                    if block_type == "tool_use":
                        event = self._create_pre_tool_use_event(agent, block, stamp)
                        tool_id: str = block.get("id", "")
                        if event:
                            events.append(event)
                            agent.active_tool_ids.add(tool_id)
                        elif block.get("name") in ("Task", "Agent") and tool_id:
                            agent.spawn_tool_ids.add(tool_id)

                    elif agent.catching_up:
                        # Old thoughts are not news: no bubbles while catching up.
                        continue

                    elif block_type == "thinking":
                        thinking_text: str = block.get("thinking", "")
                        if thinking_text:
                            text_hash = hash(thinking_text[:200])
                            if text_hash != agent.last_thinking_hash:
                                agent.last_thinking_hash = text_hash
                                event = self._create_thinking_event(agent, thinking_text)
                                if event:
                                    events.append(event)

                    elif block_type == "text":
                        text_content: str = block.get("text", "")
                        if text_content:
                            text_hash = hash(text_content[:200])
                            if text_hash != agent.last_text_hash:
                                agent.last_text_hash = text_hash
                                event = self._create_text_event(agent, text_content)
                                if event:
                                    events.append(event)

            elif record_type == "user" and message.get("role") == "user":
                for item in content_blocks:
                    if not isinstance(item, dict):
                        continue
                    block = cast(dict[str, Any], item)
                    if block.get("type") == "tool_result":
                        tool_use_id: str = block.get("tool_use_id", "")
                        if tool_use_id in agent.active_tool_ids:
                            event = self._create_post_tool_use_event(agent, block, stamp)
                            if event:
                                events.append(event)
                            agent.active_tool_ids.discard(tool_use_id)
                        agent.spawn_tool_ids.discard(tool_use_id)

        return events

    @staticmethod
    def _track_turn(
        agent: PolledAgent,
        record: dict[str, Any],
        message: dict[str, Any],
        blocks: list[Any],
    ) -> None:
        """Note how the latest turn in the transcript ended.

        ``"handback"``: a tool_result flagged ``toolEndsTurn`` (the agent's
        report was delivered). ``"final"``: an assistant message without
        tool_use whose stop reason ends the turn. Any other assistant or user
        message means the agent is mid-turn. Bookkeeping records
        (api-request, attachments, system) leave it unchanged.
        """
        record_type = record.get("type")
        types = [cast(dict[str, Any], b).get("type") for b in blocks if isinstance(b, dict)]
        if record_type == "assistant" and message.get("role") == "assistant":
            final = "tool_use" not in types and message.get("stop_reason") in _FINAL_STOP_REASONS
            agent.turn_end = "final" if final else None
        elif record_type == "user" and message.get("role") == "user":
            ends = "tool_result" in types and record.get("toolEndsTurn") is True
            agent.turn_end = "handback" if ends else None

    def _create_pre_tool_use_event(
        self, agent: PolledAgent, block: dict[str, Any], stamp: datetime | None = None
    ) -> ToolEvent | None:
        """Create a pre_tool_use event from a tool_use block."""
        tool_name = block.get("name")
        if not tool_name:
            return None

        # Nested Task/Agent calls are spawns, not plain tool rows: the hook's
        # subagent_start for the child covers them (the tracker builds the
        # spawn call from it).
        if tool_name in ("Task", "Agent"):
            return None

        tool_input = block.get("input", {})
        tool_use_id = block.get("id", "")

        return ToolEvent(
            event_type=EventType.PRE_TOOL_USE,
            session_id=agent.session_id,
            timestamp=stamp or datetime.now(UTC),
            data=ToolEventData(
                agent_id=agent.agent_id,
                tool_name=tool_name,
                tool_input=tool_input,
                tool_use_id=tool_use_id,
            ),
        )

    def _create_post_tool_use_event(
        self, agent: PolledAgent, block: dict[str, Any], stamp: datetime | None = None
    ) -> ToolEvent | None:
        """Create a post_tool_use event from a tool_result block."""
        tool_use_id = block.get("tool_use_id", "")
        is_error = block.get("is_error", False)

        return ToolEvent(
            event_type=EventType.POST_TOOL_USE,
            session_id=agent.session_id,
            timestamp=stamp or datetime.now(UTC),
            data=ToolEventData(
                agent_id=agent.agent_id,
                tool_use_id=tool_use_id,
                success=not is_error,
            ),
        )

    def _create_thinking_event(self, agent: PolledAgent, thinking_text: str) -> AgentEvent:
        """Create an agent update event for thinking content."""
        max_length = 200
        display_text = thinking_text.replace("\n", " ").strip()
        if len(display_text) > max_length:
            display_text = display_text[: max_length - 3] + "..."

        return AgentEvent(
            event_type=EventType.AGENT_UPDATE,
            session_id=agent.session_id,
            timestamp=datetime.now(UTC),
            data=AgentEventData(
                agent_id=agent.agent_id,
                thinking=thinking_text,
                bubble_content=BubbleContent(
                    type=BubbleType.THOUGHT,
                    text=display_text,
                    icon="💭",
                ),
            ),
        )

    def _create_text_event(self, agent: PolledAgent, text_content: str) -> AgentEvent:
        """Create an agent update event for text response."""
        max_length = 200
        display_text = text_content.replace("\n", " ").strip()
        if len(display_text) > max_length:
            display_text = display_text[: max_length - 3] + "..."

        return AgentEvent(
            event_type=EventType.AGENT_UPDATE,
            session_id=agent.session_id,
            timestamp=datetime.now(UTC),
            data=AgentEventData(
                agent_id=agent.agent_id,
                summary=text_content,
                bubble_content=BubbleContent(
                    type=BubbleType.SPEECH,
                    text=display_text,
                    icon="💬",
                ),
            ),
        )


_transcript_poller: TranscriptPoller | None = None


def get_transcript_poller() -> TranscriptPoller | None:
    """Get the singleton transcript poller instance, or None if not initialized."""
    return _transcript_poller


def init_transcript_poller(event_callback: Any) -> TranscriptPoller:
    """Initialize the singleton transcript poller with an event callback."""
    global _transcript_poller
    _transcript_poller = TranscriptPoller(event_callback)
    return _transcript_poller
