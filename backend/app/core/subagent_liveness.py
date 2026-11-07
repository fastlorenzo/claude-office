"""How many subagents are *running* right now (as opposed to spawned in total).

SubagentStart/SubagentStop alone miss reality: a background agent hands back a
report (Stop) yet may be resumed with SendMessage (no new Start) and keep
working; a Stop can also be lost. The agent's own transcript
(``<session>/subagents/agent-<native id>.jsonl``) is the ground truth for
activity, so liveness combines lifecycle events with transcript mtimes.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Collection, Mapping
from pathlib import Path

from app.models.agents import Agent, AgentState

__all__ = ["count_running_subagents", "scan_agent_mtimes"]

logger = logging.getLogger(__name__)

# Tracked agent with no transcript write for this long is presumed lost (its Stop
# never arrived). Generous: a long tool call or deep thinking is silent for minutes.
TRACKED_STALE_S = 30 * 60
# Agents we only know from their transcript (resumed, or started before the backend):
# running while their file keeps changing.
UNTRACKED_LIVE_S = 3 * 60
# A Stop can arrive slightly before the agent's final transcript flush.
STOP_SLACK_S = 15.0
_SCAN_CACHE_S = 3.0

_INACTIVE = frozenset(
    {AgentState.COMPLETED, AgentState.LEAVING, AgentState.REPORTING_DONE, AgentState.IN_ELEVATOR}
)
_scan_cache: dict[str, tuple[float, dict[str, float]]] = {}


def scan_agent_mtimes(transcript_path: str | None, now: float | None = None) -> dict[str, float]:
    """``native agent id -> transcript mtime`` for the session's subagent directory."""
    if not transcript_path or not transcript_path.endswith(".jsonl"):
        return {}
    ts = time.time() if now is None else now
    directory = transcript_path[: -len(".jsonl")] + "/subagents"
    hit = _scan_cache.get(directory)
    if hit is not None and ts - hit[0] < _SCAN_CACHE_S:
        return hit[1]
    out: dict[str, float] = {}
    try:
        with os.scandir(Path(directory)) as it:
            for e in it:
                if e.name.startswith("agent-") and e.name.endswith(".jsonl"):
                    try:
                        out[e.name[len("agent-") : -len(".jsonl")]] = e.stat().st_mtime
                    except OSError:
                        continue
    except OSError:
        pass
    if len(_scan_cache) > 256:
        _scan_cache.clear()
    _scan_cache[directory] = (ts, out)
    return out


def count_running_subagents(
    agents: Mapping[str, Agent],
    handin_queue: Collection[str],
    stopped_native: Mapping[str, float],
    mtimes: Mapping[str, float],
    now: float,
) -> int:
    """Count subagents that are running at *now*.

    * Tracked agents (in the office, not leaving / handed in) count, unless their
      transcript has been silent past ``TRACKED_STALE_S`` (lost Stop).
    * Agents the office does not hold (resumed via SendMessage, or Stop seen but
      still writing) count when their transcript changed after the last Stop and
      within ``UNTRACKED_LIVE_S``.
    """
    running = 0
    tracked_native: set[str] = set()
    for aid, agent in agents.items():
        if agent.native_id:
            tracked_native.add(agent.native_id)
        if agent.state in _INACTIVE or aid in handin_queue:
            continue
        nid = agent.native_id
        if nid:
            mt = mtimes.get(nid)
            stop = stopped_native.get(nid)
            if stop is not None and (mt is None or mt <= stop + STOP_SLACK_S):
                continue  # stopped and quiet since
            if mt is not None and now - mt > TRACKED_STALE_S:
                continue
        running += 1
    for nid, mt in mtimes.items():
        if nid in tracked_native:
            continue
        stop = stopped_native.get(nid)
        if stop is not None and mt <= stop + STOP_SLACK_S:
            continue
        if now - mt <= UNTRACKED_LIVE_S:
            running += 1
    return running
