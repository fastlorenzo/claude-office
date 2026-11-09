"use client";

import { useEffect, useRef, useState } from "react";
import {
  MoreHorizontal,
  Play,
  RefreshCw,
  Trash2,
  Bug,
  FileUp,
  Download,
} from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";

// ============================================================================
// TYPES
// ============================================================================

interface HeaderMoreMenuProps {
  debugMode: boolean;
  onSimulate: () => Promise<void>;
  /** Play a demo file (.jsonl) picked by the user. */
  onPlayDemo: (file: File) => Promise<void>;
  /** Download the current session as a demo file. */
  onExportDemo: () => Promise<void>;
  onReset: () => void;
  onClearDB: () => void;
  onToggleDebug: () => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Overflow "⋯" menu holding the rarely-used developer/maintenance actions
 * (Simulate, demo files, Reset, Clear DB, Debug) so they don't crowd the header.
 * Closes on outside click or Escape.
 */
export function HeaderMoreMenu({
  debugMode,
  onSimulate,
  onPlayDemo,
  onExportDemo,
  onReset,
  onClearDB,
  onToggleDebug,
}: HeaderMoreMenuProps): React.ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const itemClass =
    "flex w-full items-center gap-2 px-3 py-2 text-xs font-bold rounded transition-colors text-left";

  return (
    <div ref={ref} className="relative">
      <input
        ref={fileRef}
        type="file"
        accept=".jsonl,.ndjson,.json,application/x-ndjson,application/json"
        className="hidden"
        data-testid="demo-file-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so picking the same file again still fires onChange.
          e.target.value = "";
          if (file) void onPlayDemo(file);
        }}
      />
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("header.moreMenu")}
        title={t("header.more")}
        className={`flex items-center gap-2 px-3 py-1.5 border rounded text-xs font-bold transition-colors ${
          open
            ? "bg-slate-700 text-white border-slate-600"
            : "bg-slate-500/10 text-slate-400 border-slate-500/30 hover:bg-slate-500/20"
        }`}
      >
        <MoreHorizontal size={14} />
        {t("header.more")}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-50 min-w-[11rem] p-1 bg-slate-900 border border-slate-700 rounded-lg shadow-xl"
        >
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void onSimulate();
            }}
            className={`${itemClass} text-emerald-400 hover:bg-emerald-500/15`}
          >
            <Play size={14} fill="currentColor" />
            {t("header.simulate")}
          </button>

          <button
            role="menuitem"
            title={t("header.playDemoHint")}
            onClick={() => {
              setOpen(false);
              fileRef.current?.click();
            }}
            className={`${itemClass} text-emerald-400 hover:bg-emerald-500/15`}
          >
            <FileUp size={14} />
            {t("header.playDemo")}
          </button>

          <button
            role="menuitem"
            title={t("header.exportDemoHint")}
            onClick={() => {
              setOpen(false);
              void onExportDemo();
            }}
            className={`${itemClass} text-sky-400 hover:bg-sky-500/15`}
          >
            <Download size={14} />
            {t("header.exportDemo")}
          </button>

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onReset();
            }}
            className={`${itemClass} text-amber-400 hover:bg-amber-500/15`}
          >
            <RefreshCw size={14} />
            {t("header.reset")}
          </button>

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onClearDB();
            }}
            className={`${itemClass} text-rose-400 hover:bg-rose-500/15`}
          >
            <Trash2 size={14} />
            {t("header.clearDb")}
          </button>

          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onToggleDebug();
            }}
            className={`${itemClass} ${
              debugMode
                ? "text-green-400 hover:bg-green-500/15"
                : "text-slate-400 hover:bg-slate-500/15"
            }`}
          >
            <Bug size={14} />
            {debugMode ? t("header.debugOn") : t("header.debugOff")}
          </button>
        </div>
      )}
    </div>
  );
}
