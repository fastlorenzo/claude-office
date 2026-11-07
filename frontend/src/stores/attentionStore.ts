"use client";

import { create } from "zustand";
import type { EventType } from "@/types";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { apiFetch, getApiKey } from "@/utils/api";
import { getTranslation, type TranslationKey } from "@/i18n";

// ============================================================================
// TYPES
// ============================================================================

export type UrgencyLevel = "critical" | "high" | "low" | "info";

export interface AttentionToast {
  id: string;
  /** Session the toast belongs to (null when the event carried none). */
  sessionId: string | null;
  agentId: string | null;
  agentName: string | null;
  eventType: EventType;
  urgency: number;
  urgencyLevel: UrgencyLevel;
  title: string;
  description: string;
  createdAt: number;
  autoDismissMs: number | null;
  dismissed: boolean;
}

export interface FocusPopupState {
  agentId: string;
  screenX: number;
  screenY: number;
}

interface AttentionState {
  // Toast queue
  toastQueue: AttentionToast[];
  // Command bar
  isCommandBarOpen: boolean;
  commandFilter: string;
  // Focus popup
  focusPopup: FocusPopupState | null;

  // Actions
  processEvent: (event: {
    type: EventType;
    /** Owning Claude Code session; keys stop-toast dedupe and reactivation. */
    sessionId?: string | null;
    /** Human label for the session (project or session name), used by stop toasts. */
    label?: string | null;
    agentId?: string | null;
    agentName?: string | null;
    taskDescription?: string | null;
    errorType?: string | null;
    message?: string | null;
    /** Override the derived title and urgency (e.g. soft info/warning toasts). */
    title?: string;
    level?: UrgencyLevel;
  }) => void;
  /** Drop the session's stop toast: called when the session is active again. */
  markSessionActive: (sessionId: string) => void;
  dismissToast: (id: string) => void;
  clearAllToasts: () => void;
  openCommandBar: () => void;
  closeCommandBar: () => void;
  setCommandFilter: (filter: string) => void;
  openFocusPopup: (agentId: string, screenX: number, screenY: number) => void;
  closeFocusPopup: () => void;
  focusAgentTerminal: (
    sessionId: string,
    agentId: string | null,
  ) => Promise<void>;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_VISIBLE_TOASTS = 5;

/** Map event types to urgency scores and auto-dismiss timing. */
function scoreEvent(
  eventType: EventType,
  forced?: UrgencyLevel,
): {
  urgency: number;
  level: UrgencyLevel;
  autoDismissMs: number | null;
} {
  const prefs = usePreferencesStore.getState();
  if (forced === "info")
    return {
      urgency: 10,
      level: "info",
      autoDismissMs: prefs.toastAutoDismissInfo,
    };
  if (forced === "low")
    return {
      urgency: 30,
      level: "low",
      autoDismissMs: prefs.toastAutoDismissLow,
    };
  switch (eventType) {
    case "permission_request":
      return { urgency: 90, level: "critical", autoDismissMs: null };
    case "error":
      return { urgency: 70, level: "high", autoDismissMs: null };
    case "stop":
      // A finished turn is informational: it auto-dismisses like task_completed.
      return {
        urgency: 30,
        level: "low",
        autoDismissMs: prefs.toastAutoDismissLow,
      };
    case "task_completed":
      return {
        urgency: 30,
        level: "low",
        autoDismissMs: prefs.toastAutoDismissLow,
      };
    case "subagent_start":
    case "background_task_notification":
      return {
        urgency: 10,
        level: "info",
        autoDismissMs: prefs.toastAutoDismissInfo,
      };
    default:
      return {
        urgency: 5,
        level: "info",
        autoDismissMs: prefs.toastAutoDismissInfo,
      };
  }
}

/**
 * True when a stop event came from a subagent rather than the boss. The
 * backend stamps the boss as "main" (or leaves it empty); anything else is an
 * agent id.
 */
export function isSubagentAgentId(agentId: string | null | undefined): boolean {
  const id = agentId?.trim();
  return !!id && id !== "main" && id !== "boss";
}

/**
 * Short label for a session's stop toast: the Claude Code session name when
 * set, else the project, else the first 8 characters of the id.
 */
export function sessionToastLabel(session: {
  sessionId: string;
  sessionName?: string | null;
  project?: string | null;
}): string {
  return (
    session.sessionName?.trim() ||
    session.project?.trim() ||
    session.sessionId.slice(0, 8)
  );
}

// ============================================================================
// TERMINAL FOCUS HELPERS
// ============================================================================

/** Map a failed focus response to a soft (non-error) toast. */
export function mapFocusFailure(status: number): {
  level: UrgencyLevel;
  key: TranslationKey;
} {
  if (status === 401 || status === 403)
    return { level: "low", key: "focus.needsToken" };
  if (status === 404) return { level: "info", key: "focus.notFound" };
  if (status >= 500) return { level: "info", key: "focus.unsupported" };
  return { level: "info", key: "focus.failed" };
}

/**
 * Whether "Open terminal" can plausibly work: the backend only supports it on
 * macOS and the endpoint is token-gated. No endpoint exposes the server
 * platform, so infer from the browser (same machine in the dev setup).
 */
export function canFocusTerminal(
  userAgent: string | null = typeof navigator === "undefined"
    ? null
    : navigator.userAgent,
  token: string | null = getApiKey(),
): boolean {
  return !!token && !!userAgent && /Macintosh|Mac OS X/i.test(userAgent);
}

// ============================================================================
// STORE
// ============================================================================

export const useAttentionStore = create<AttentionState>()((set, get) => ({
  toastQueue: [],
  isCommandBarOpen: false,
  commandFilter: "",
  focusPopup: null,

  processEvent: (event) => {
    const sessionId = event.sessionId ?? null;
    if (event.type === "stop") {
      // Subagent turn ends are not the session finishing: never toast them.
      if (isSubagentAgentId(event.agentId)) return;
    } else if (sessionId) {
      // Any other activity means the session is working again.
      get().markSessionActive(sessionId);
    }

    const { urgency, level, autoDismissMs } = scoreEvent(
      event.type,
      event.level,
    );
    // Skip very low urgency events that aren't in our explicit list
    if (urgency <= 5) return;

    const title =
      event.type === "stop"
        ? getTranslation(usePreferencesStore.getState().language)(
            "attention.toast.stop",
            { label: event.label?.trim() || "Claude" },
          )
        : (event.title ?? event.type.replace(/_/g, " "));

    const toast: AttentionToast = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      agentId: event.agentId ?? null,
      agentName: event.agentName ?? null,
      eventType: event.type,
      urgency,
      urgencyLevel: level,
      title,
      description:
        event.taskDescription ?? event.errorType ?? event.message ?? "",
      createdAt: Date.now(),
      autoDismissMs,
      dismissed: false,
    };

    set((state) => {
      // At most one stop toast per session: the newer stop replaces the older.
      const kept =
        event.type === "stop"
          ? state.toastQueue.filter(
              (t) => !(t.eventType === "stop" && t.sessionId === sessionId),
            )
          : state.toastQueue;
      const queue = [...kept, toast];
      // Sort by urgency descending
      queue.sort((a, b) => b.urgency - a.urgency);
      // Auto-dismiss oldest low-urgency toasts if over max
      if (queue.filter((t) => !t.dismissed).length > MAX_VISIBLE_TOASTS) {
        const activeSorted = queue
          .filter((t) => !t.dismissed)
          .sort((a, b) => a.urgency - b.urgency);
        const toastId = activeSorted[0]?.id;
        const finalQueue = queue.map((t) =>
          t.id === toastId ? { ...t, dismissed: true } : t,
        );
        return { toastQueue: finalQueue };
      }
      return { toastQueue: queue };
    });
  },

  markSessionActive: (sessionId) =>
    set((state) => {
      if (
        !state.toastQueue.some(
          (t) => t.eventType === "stop" && t.sessionId === sessionId,
        )
      )
        return state; // no change: skip the notification entirely
      return {
        toastQueue: state.toastQueue.filter(
          (t) => !(t.eventType === "stop" && t.sessionId === sessionId),
        ),
      };
    }),

  dismissToast: (id) =>
    set((state) => ({
      toastQueue: state.toastQueue.map((t) =>
        t.id === id ? { ...t, dismissed: true } : t,
      ),
    })),

  clearAllToasts: () =>
    set((state) => ({
      toastQueue: state.toastQueue.map((t) => ({ ...t, dismissed: true })),
    })),

  openCommandBar: () => set({ isCommandBarOpen: true, commandFilter: "" }),
  closeCommandBar: () => set({ isCommandBarOpen: false, commandFilter: "" }),
  setCommandFilter: (filter) => set({ commandFilter: filter }),

  openFocusPopup: (agentId, screenX, screenY) =>
    set({
      focusPopup: { agentId, screenX, screenY },
    }),

  closeFocusPopup: () => set({ focusPopup: null }),

  focusAgentTerminal: async (sessionId, _agentId) => {
    try {
      const res = await apiFetch(`/api/v1/sessions/${sessionId}/focus`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const f = mapFocusFailure(res.status);
        const t = getTranslation(usePreferencesStore.getState().language);
        get().processEvent({
          type: "background_task_notification",
          level: f.level,
          title: t("focus.title"),
          message: t(f.key),
        });
      }
    } catch {
      const t = getTranslation(usePreferencesStore.getState().language);
      get().processEvent({
        type: "error",
        message: t("focus.unreachable"),
      });
    }
    get().closeFocusPopup();
  },
}));

// ============================================================================
// SELECTORS
// ============================================================================

export const selectActiveToasts = (state: AttentionState) =>
  state.toastQueue.filter((t) => !t.dismissed);

export const selectUnreadCount = (state: AttentionState) =>
  state.toastQueue.filter((t) => !t.dismissed).length;

export const selectFocusPopup = (state: AttentionState) => state.focusPopup;
