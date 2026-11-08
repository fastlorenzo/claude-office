"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Activity, Factory, LayoutList, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { TranslationKey } from "@/i18n/en";
import {
  dashboardHref,
  DASHBOARD_TABS,
  type DashboardState,
  type DashboardTab,
} from "./dashboardUrl";

const TAB_META: Record<
  DashboardTab,
  { icon: LucideIcon; label: TranslationKey }
> = {
  ops: { icon: Activity, label: "dashboard.tab.ops" },
  sessions: { icon: LayoutList, label: "dashboard.tab.sessions" },
  console: { icon: Terminal, label: "dashboard.tab.console" },
  factory: { icon: Factory, label: "dashboard.tab.factory" },
};

/** Tab strip (horizontally scrollable on phones). Real links, intercepted in-page. */
export function DashboardNav({
  state,
  token,
  onSelect,
}: {
  state: DashboardState;
  token: string | null;
  onSelect: (tab: DashboardTab) => void;
}): ReactNode {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the active tab visible in the phone carousel.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>("[aria-selected='true']")
      ?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [state.tab]);
  return (
    <nav
      aria-label={t("dashboard.title")}
      className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
    >
      <div
        ref={listRef}
        role="tablist"
        className="inline-flex min-w-full gap-1 rounded-2xl border border-white/10 bg-slate-950/70 p-1 backdrop-blur-xl sm:min-w-0"
      >
        {DASHBOARD_TABS.map((tab) => {
          const { icon: Icon, label } = TAB_META[tab];
          const active = state.tab === tab;
          return (
            <a
              key={tab}
              role="tab"
              aria-selected={active}
              href={dashboardHref({ ...state, tab }, token)}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)
                  return;
                e.preventDefault();
                onSelect(tab);
              }}
              className={`flex flex-1 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition-colors sm:flex-none ${
                active
                  ? "bg-[#D97757]/20 text-[#f0a58a] shadow-[inset_0_0_0_1px_rgba(217,119,87,0.45)]"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {t(label)}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
