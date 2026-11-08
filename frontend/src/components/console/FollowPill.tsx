"use client";

import type { ReactNode } from "react";
import { ArrowDown, Pause } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { FollowState } from "@/utils/console/followScroll";

/** `⏸ Paused · N new ↓`: shown while live-follow is paused; click resumes. */
export function FollowPill({
  follow,
  onResume,
}: {
  follow: FollowState;
  onResume: () => void;
}): ReactNode {
  const { t } = useTranslation();
  if (follow.mode === "following") return null;
  return (
    <button
      type="button"
      onClick={onResume}
      className="pointer-events-auto absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-2 rounded-full border border-sky-400/40 bg-slate-900/95 px-3.5 py-1.5 text-xs font-semibold text-sky-100 shadow-lg shadow-black/50 backdrop-blur hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70"
      title={t("console.followHint")}
    >
      <Pause className="h-3.5 w-3.5 text-sky-300" />
      <span>{t("console.paused")}</span>
      {follow.unseen > 0 && (
        <span className="rounded-full bg-sky-400/20 px-1.5 text-sky-200">
          {t("console.nNew", { count: follow.unseen })}
        </span>
      )}
      <ArrowDown className="h-3.5 w-3.5 text-sky-300" />
    </button>
  );
}
