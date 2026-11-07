/**
 * Attention-store stop toasts: one labelled, auto-dismissing toast per session,
 * removed when the session is active again, and never raised for subagents.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  isSubagentAgentId,
  sessionToastLabel,
  useAttentionStore,
} from "@/stores/attentionStore";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { getTranslation } from "@/i18n";

function reset(): void {
  usePreferencesStore.setState({ language: "en" });
  useAttentionStore.setState({ toastQueue: [] });
}

function stopToasts(sessionId?: string) {
  return useAttentionStore
    .getState()
    .toastQueue.filter(
      (t) =>
        t.eventType === "stop" &&
        (sessionId === undefined || t.sessionId === sessionId),
    );
}

describe("stop toasts", () => {
  beforeEach(reset);

  it("is low urgency and auto-dismisses after the low-urgency preference", () => {
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    const [toast] = stopToasts("s1");
    expect(toast.urgencyLevel).toBe("low");
    expect(toast.urgency).toBe(30);
    expect(toast.autoDismissMs).toBe(
      usePreferencesStore.getState().toastAutoDismissLow,
    );
  });

  it("reads '<label> · finished — waiting for you', never a bare 'stop'", () => {
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    const [toast] = stopToasts("s1");
    expect(toast.title).toBe(
      getTranslation("en")("attention.toast.stop", { label: "api" }),
    );
    expect(toast.title).toBe("api · finished — waiting for you");
    expect(toast.title).not.toBe("stop");
  });

  it("falls back to a generic label when none is known", () => {
    useAttentionStore
      .getState()
      .processEvent({ type: "stop", sessionId: "s1", agentId: "main" });
    expect(stopToasts("s1")[0].title).toBe(
      "Claude · finished — waiting for you",
    );
  });

  it("uses the pt-BR and es strings when that language is selected", () => {
    usePreferencesStore.setState({ language: "pt-BR" });
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    expect(stopToasts("s1")[0].title).toBe(
      getTranslation("pt-BR")("attention.toast.stop", { label: "api" }),
    );
    reset();
    usePreferencesStore.setState({ language: "es" });
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    expect(stopToasts("s1")[0].title).toBe(
      getTranslation("es")("attention.toast.stop", { label: "api" }),
    );
  });

  it("keeps at most one stop toast per session; a newer stop replaces the older", () => {
    const { processEvent } = useAttentionStore.getState();
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    processEvent({
      type: "stop",
      sessionId: "s2",
      agentId: "main",
      label: "web",
    });
    expect(stopToasts("s1")).toHaveLength(1);
    expect(stopToasts("s2")).toHaveLength(1);
  });

  it("keeps other event types for the same session untouched by stop dedupe", () => {
    const { processEvent } = useAttentionStore.getState();
    processEvent({
      type: "error",
      sessionId: "s1",
      agentId: "main",
      message: "boom",
    });
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    const errors = useAttentionStore
      .getState()
      .toastQueue.filter((t) => t.eventType === "error");
    expect(errors).toHaveLength(1);
    expect(stopToasts("s1")).toHaveLength(1);
  });

  it("is removed when the session becomes active again (any non-stop event)", () => {
    const { processEvent } = useAttentionStore.getState();
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    processEvent({
      type: "stop",
      sessionId: "s2",
      agentId: "main",
      label: "web",
    });
    processEvent({
      type: "permission_request",
      sessionId: "s1",
      agentId: "main",
    });
    expect(stopToasts("s1")).toHaveLength(0);
    expect(stopToasts("s2")).toHaveLength(1);
  });

  it("is removed by markSessionActive even when the event raises no toast", () => {
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    useAttentionStore.getState().markSessionActive("s1");
    expect(stopToasts("s1")).toHaveLength(0);
  });

  it("markSessionActive leaves the queue reference alone when nothing matches", () => {
    const before = useAttentionStore.getState().toastQueue;
    useAttentionStore.getState().markSessionActive("nobody");
    expect(useAttentionStore.getState().toastQueue).toBe(before);
  });

  it("a stop event does not clear its own session's stop toast before adding the new one", () => {
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    expect(stopToasts("s1")).toHaveLength(1);
  });

  it("does not raise a toast for stops from subagents", () => {
    const { processEvent } = useAttentionStore.getState();
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "agent-42",
      label: "api",
    });
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "subagent_xyz",
      label: "api",
    });
    expect(stopToasts()).toHaveLength(0);
  });

  it("subagent stops do not remove the boss stop toast", () => {
    const { processEvent } = useAttentionStore.getState();
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "agent-42",
      label: "api",
    });
    expect(stopToasts("s1")).toHaveLength(1);
  });

  it("still raises a stop toast when the agent id is the boss marker", () => {
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s1",
      agentId: "main",
      label: "api",
    });
    useAttentionStore.getState().processEvent({
      type: "stop",
      sessionId: "s2",
      agentId: null,
      label: "web",
    });
    expect(stopToasts()).toHaveLength(2);
  });
});

describe("urgency of other toasts", () => {
  beforeEach(reset);

  it("keeps permission_request critical and sticky", () => {
    useAttentionStore.getState().processEvent({
      type: "permission_request",
      sessionId: "s1",
      agentId: "main",
    });
    const [toast] = useAttentionStore.getState().toastQueue;
    expect(toast.urgencyLevel).toBe("critical");
    expect(toast.autoDismissMs).toBeNull();
  });

  it("keeps error high and sticky", () => {
    useAttentionStore
      .getState()
      .processEvent({ type: "error", message: "boom" });
    const [toast] = useAttentionStore.getState().toastQueue;
    expect(toast.urgencyLevel).toBe("high");
    expect(toast.autoDismissMs).toBeNull();
  });
});

describe("helpers", () => {
  it("isSubagentAgentId treats the boss markers and empties as not subagents", () => {
    expect(isSubagentAgentId("main")).toBe(false);
    expect(isSubagentAgentId("boss")).toBe(false);
    expect(isSubagentAgentId("")).toBe(false);
    expect(isSubagentAgentId(null)).toBe(false);
    expect(isSubagentAgentId(undefined)).toBe(false);
    expect(isSubagentAgentId("agent-42")).toBe(true);
  });

  it("sessionToastLabel prefers session name, then project, then the short id", () => {
    expect(
      sessionToastLabel({
        sessionId: "abcdef123456",
        sessionName: "refactor",
        project: "api",
      }),
    ).toBe("refactor");
    expect(
      sessionToastLabel({
        sessionId: "abcdef123456",
        sessionName: "  ",
        project: "api",
      }),
    ).toBe("api");
    expect(
      sessionToastLabel({
        sessionId: "abcdef123456",
        sessionName: null,
        project: null,
      }),
    ).toBe("abcdef12");
  });
});
