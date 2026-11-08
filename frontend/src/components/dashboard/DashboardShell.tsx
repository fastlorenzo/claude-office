"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ChevronRight, Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { useCampusWebSocket } from "@/hooks/useCampusWebSocket";
import { useSessions, type Session } from "@/hooks/useSessions";
import { useSessionSwitch } from "@/hooks/useSessionSwitch";
import { useCampusStore } from "@/stores/campusStore";
import { usePreferencesStore } from "@/stores/preferencesStore";
import { getApiKey, initApiKeyFromBrowser } from "@/utils/api";
import { STATUS_COLORS } from "@/engine/contracts";
import { roomStatus } from "@/engine/logic/status";
import {
  SessionNavProvider,
  useSessionNav,
  type SessionNav,
} from "@/components/shared/sessionNav";
import { labelMap } from "@/components/world/sessionMeta";
import { useCampusConnection } from "@/components/world/hud/connectionStatus";
import { DashboardNav } from "./DashboardNav";
import { OpsTab } from "./OpsTab";
import { SessionsTab } from "./SessionsTab";
import { ConsoleTab } from "./ConsoleTab";
import { FactoryTab } from "./FactoryTab";
import { attentionSession } from "./focusSession";
import { threeDHref } from "./dashboardUrl";
import { useDashboardState } from "./useDashboardState";

/** Renderer switch: 3D / Pixel (set the preference, go home) / Dashboards (here). */
function RendererLinks({ token }: { token: string | null }): ReactNode {
  const { t } = useTranslation();
  const setRenderer = usePreferencesStore((s) => s.setRenderer);
  const seg =
    "px-2.5 py-1 rounded-sm text-[11px] font-bold tracking-wide transition-colors";
  return (
    <div
      role="group"
      aria-label={t("settings.renderer")}
      className="flex items-center rounded border border-slate-700 bg-slate-900 p-0.5"
    >
      {(["3d", "pixel"] as const).map((r) => (
        <a
          key={r}
          href={threeDHref(null, token)}
          onClick={(e) => {
            e.preventDefault();
            void setRenderer(r).finally(() =>
              window.location.assign(threeDHref(null, token)),
            );
          }}
          className={`${seg} text-slate-500 hover:text-slate-300`}
        >
          {r === "3d" ? t("settings.renderer3d") : t("settings.rendererPixel")}
        </a>
      ))}
      <span
        aria-current="page"
        className={`${seg} bg-orange-500/20 text-orange-400`}
      >
        {t("header.dashboards")}
      </span>
    </div>
  );
}

/** Live session pills under the tabs (a pill carousel on phones). */
function StatusStrip({ sessions }: { sessions: Session[] }): ReactNode {
  const campus = useCampusStore((s) => s.sessions);
  const nav = useSessionNav();
  const labels = useMemo(() => labelMap(sessions, campus), [sessions, campus]);
  const live = campus.filter((c) => !c.ended);
  if (live.length === 0) return null;
  return (
    <ul
      aria-hidden={false}
      className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0"
    >
      {live.map((c) => {
        const status = roomStatus(c);
        const color = STATUS_COLORS[status];
        return (
          <li key={c.sessionId} className="shrink-0">
            <button
              type="button"
              onClick={() => nav.openConsole(c.sessionId)}
              className="flex items-center gap-2 rounded-full border border-white/10 bg-slate-950/70 py-1.5 pl-2.5 pr-3 text-xs text-slate-300 backdrop-blur-xl transition-colors hover:bg-white/10"
            >
              <span
                className={`h-2 w-2 rounded-full ${status === "needs_you" ? "animate-pulse" : ""}`}
                style={{ background: color, boxShadow: `0 0 8px ${color}` }}
              />
              <span className="max-w-[10rem] truncate font-semibold text-slate-100">
                {labels.get(c.sessionId) ??
                  c.project ??
                  c.sessionId.slice(0, 8)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The /dashboard page: mounts its own campus feed (no WebGL), provides URL
 * based session navigation and renders the active tab.
 */
export function DashboardShell(): ReactNode {
  const { t } = useTranslation();
  const language = usePreferencesStore((s) => s.language);
  const loadPreferences = usePreferencesStore((s) => s.loadPreferences);
  const { state, navigate } = useDashboardState();
  const [deleting, setDeleting] = useState<Session | null>(null);

  // Token intake must run before the sockets/fetches below connect.
  const [linkToken, setLinkToken] = useState<string | null>(null);
  useEffect(() => {
    initApiKeyFromBrowser();
    // Links to other documents carry the token (this address bar never does).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLinkToken(getApiKey());
  }, []);
  useCampusWebSocket({ enabled: true });
  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const showStatus = useCallback(() => undefined, []);
  const { sessions, sessionsLoading, sessionId, setSessionId, fetchSessions } =
    useSessions(showStatus);
  const { handleDeleteSession, handleRenameSession } = useSessionSwitch({
    sessionId,
    setSessionId,
    fetchSessions,
    showStatus,
  });

  const conn = useCampusConnection();
  const attention = useCampusStore((s) => attentionSession(s.sessions));
  const liveCount = useCampusStore(
    (s) => s.sessions.filter((c) => !c.ended).length,
  );

  const nav = useMemo<SessionNav>(
    () => ({
      openConsole: (id, opts) =>
        navigate({ tab: "console", session: id, call: opts?.callId }),
      openFactory: (target) =>
        navigate({
          tab: "factory",
          project: target.projectId,
          pr:
            target.prNumber !== undefined ? String(target.prNumber) : undefined,
        }),
    }),
    [navigate],
  );

  const ok = conn.kind === "ok";
  return (
    <SessionNavProvider value={nav}>
      <div className="min-h-screen bg-[#04070C] bg-[radial-gradient(1200px_600px_at_80%_-10%,rgba(217,119,87,0.10),transparent),radial-gradient(900px_500px_at_0%_0%,rgba(56,189,248,0.06),transparent)] font-sans text-slate-100">
        <div className="mx-auto flex w-full max-w-[1760px] flex-col gap-4 px-4 py-4 sm:py-6">
          <header className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <h1 className="flex items-center gap-2 text-lg font-bold tracking-tight text-white sm:text-2xl">
              <span className="text-orange-500">Claude</span>
              <ChevronRight className="h-4 w-4 text-slate-600" aria-hidden />
              <span>{t("dashboard.title")}</span>
            </h1>
            <div className="ml-auto flex items-center gap-3">
              <span
                className={`flex items-center gap-1.5 font-mono text-xs ${ok ? "text-emerald-400" : "text-rose-400"}`}
              >
                {ok ? (
                  <Wifi className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <WifiOff className="h-3.5 w-3.5" aria-hidden />
                )}
                {t("dashboard.live")} · {liveCount}
              </span>
              <RendererLinks token={linkToken} />
            </div>
          </header>

          <DashboardNav
            state={state}
            token={linkToken}
            onSelect={(tab) => navigate({ tab })}
          />
          <StatusStrip sessions={sessions} />

          <main className="min-w-0">
            {state.tab === "ops" && (
              <div className="-mx-4">
                <OpsTab
                  sessions={sessions}
                  focusId={state.session}
                  onFocus={(id) => navigate({ session: id }, { replace: true })}
                />
              </div>
            )}
            {state.tab === "sessions" && (
              <SessionsTab
                sessions={sessions}
                sessionsLoading={sessionsLoading}
                sessionId={state.session ?? sessionId}
                onSessionSelect={async (id) => navigate({ session: id })}
                onDeleteSession={setDeleting}
                onRenameSession={handleRenameSession}
              />
            )}
            {state.tab === "console" && (
              <ConsoleTab
                sessions={sessions}
                sessionId={state.session ?? attention}
                callId={state.call}
                token={linkToken}
                onPick={(id) => navigate({ session: id }, { replace: true })}
              />
            )}
            {state.tab === "factory" && (
              <FactoryTab
                projectId={state.project}
                pr={state.pr}
                onPick={(patch) => navigate(patch, { replace: true })}
              />
            )}
          </main>
        </div>
        {deleting && (
          <div
            role="alertdialog"
            aria-modal="true"
            aria-label={t("modal.deleteSession")}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          >
            <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-slate-900 p-5 shadow-2xl">
              <h2 className="text-base font-bold text-white">
                {t("modal.deleteSession")}
              </h2>
              <p className="mt-2 text-sm text-slate-400">
                {t("modal.deleteSessionConfirm")} {deleting.id.slice(0, 8)}?{" "}
                {t("modal.cannotBeUndone")}
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  autoFocus
                  onClick={() => setDeleting(null)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-sm text-slate-300 hover:bg-white/10"
                >
                  {t("modal.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const s = deleting;
                    setDeleting(null);
                    void handleDeleteSession(s);
                  }}
                  className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-rose-500"
                >
                  {t("modal.delete")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </SessionNavProvider>
  );
}
