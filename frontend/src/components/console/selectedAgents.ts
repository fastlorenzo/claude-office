"use client";

/**
 * Agent nodes for the selected session, for panels that predate the console
 * (conversation, agent panel): the console tree when the backend has it,
 * else nodes synthesized from the game state (boss + subagents).
 */

import { useMemo } from "react";
import { useConsoleStore } from "@/stores/consoleStore";
import { selectSessionId, useGameStore } from "@/stores/gameStore";
import type { AgentNode } from "@/utils/console/types";

interface GameAgentLite {
  id: string;
  name: string | null;
  color: string;
  state: string;
  task: string | null;
  bubble: string | null;
}

/** Stable string of the fields the nodes need (agents move every frame). */
function gameKey(s: ReturnType<typeof useGameStore.getState>): string {
  const list: GameAgentLite[] = [];
  for (const a of s.agents.values()) {
    list.push({
      id: a.id,
      name: a.name,
      color: a.color,
      state: a.backendState,
      task: a.currentTask,
      bubble: a.bubble.content?.text ?? null,
    });
  }
  return JSON.stringify([s.boss.backendState, s.boss.currentTask, list]);
}

const BLANK = {
  nativeId: null,
  parentId: null,
  agentType: null,
  color: null,
  taskPreview: null,
  startedAt: null,
  endedAt: null,
  spawnToolUseId: null,
  resultPreview: null,
  toolCalls: 0,
  errors: 0,
  currentActivity: null,
  rev: 0,
};

/** Game-state fallback: main + one node per subagent character. */
function fromGame(key: string): Map<string, AgentNode> {
  const [bossState, bossTask, agents] = JSON.parse(key) as [
    string,
    string | null,
    GameAgentLite[],
  ];
  const out = new Map<string, AgentNode>();
  out.set("main", {
    ...BLANK,
    id: "main",
    kind: "main",
    name: "Main agent",
    state: bossState,
    currentActivity: bossTask,
  });
  for (const a of agents) {
    out.set(a.id, {
      ...BLANK,
      id: a.id,
      kind: "subagent",
      name: a.name ?? a.id,
      parentId: "main",
      color: a.color,
      taskPreview: a.task,
      state: a.state,
      currentActivity: a.bubble,
    });
  }
  return out;
}

/**
 * The selected session's agents. Console nodes win; game-state agents that
 * the console has not seen yet are added so names and colours always resolve.
 */
export function useSelectedAgents(): ReadonlyMap<string, AgentNode> {
  const sessionId = useGameStore(selectSessionId);
  const consoleAgents = useConsoleStore((s) => s.sessions[sessionId]?.agents);
  const key = useGameStore(gameKey);
  return useMemo(() => {
    const game = fromGame(key);
    if (!consoleAgents || consoleAgents.size === 0) return game;
    const merged = new Map(consoleAgents);
    for (const [id, a] of game) if (!merged.has(id)) merged.set(id, a);
    return merged;
  }, [consoleAgents, key]);
}
