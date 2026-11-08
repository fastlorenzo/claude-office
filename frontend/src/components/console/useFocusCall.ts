"use client";

import { useEffect, useState } from "react";
import { seekCall } from "@/utils/console/focusCall";
import { fetchToolCallDetail } from "@/utils/consoleApi";

/**
 * Make a deep-linked call (`focusCallId`) available even when it lies outside
 * the loaded window. Returns true while older pages are being fetched.
 */
export function useFocusCall(
  sessionId: string,
  focusCallId: string | null | undefined,
  ready: boolean,
  loadOlder: () => Promise<void>,
): boolean {
  const [doneFor, setDoneFor] = useState<string | null>(null);
  useEffect(() => {
    if (!focusCallId || !ready) return;
    let stopped = false;
    void seekCall(
      sessionId,
      focusCallId,
      { fetchDetail: fetchToolCallDetail, loadOlder },
      () => stopped,
    ).finally(() => {
      if (!stopped) setDoneFor(focusCallId);
    });
    return () => {
      stopped = true;
    };
    // loadOlder is stable per controller; re-seeking on its change is fine.
  }, [sessionId, focusCallId, ready, loadOlder]);
  return !!focusCallId && ready && doneFor !== focusCallId;
}
