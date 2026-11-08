"use client";

/** Timeline filter bar (spec 2.5 "Filters"): search, tool kinds, errors, waiting, Tree/Flat. */

import { useState, type ReactNode, type RefObject } from "react";
import {
  TriangleExclamationPoint,
  ListTree,
  Pause,
  Rows3,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import { TOOL_KINDS } from "@/utils/console/toolFormat";
import { CHIP, CHIP_OFF, CHIP_ON, KIND_LABEL, kindIcon } from "./theme";
import type { ConsoleUi } from "./useConsoleUi";

function SearchBox({
  ui,
  inputRef,
  touch,
}: {
  ui: ConsoleUi;
  inputRef: RefObject<HTMLInputElement | null>;
  touch: boolean;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <label
      className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2.5 focus-within:border-sky-400/50 focus-within:ring-1 focus-within:ring-sky-400/30 ${touch ? "h-10" : "h-8"}`}
    >
      <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
      <input
        ref={inputRef}
        type="search"
        value={ui.queryInput}
        onChange={(e) => ui.setQueryInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            ui.setQueryInput("");
            e.currentTarget.blur();
            e.currentTarget
              .closest<HTMLElement>("[data-console-root]")
              ?.querySelector<HTMLElement>("[role=listbox]")
              ?.focus();
          }
        }}
        placeholder={t("console.searchPlaceholder")}
        aria-label={t("console.search")}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-slate-100 placeholder:text-slate-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {ui.queryInput ? (
        <button
          type="button"
          onClick={() => ui.setQueryInput("")}
          aria-label={t("console.clearSearch")}
          className="rounded p-0.5 text-slate-500 hover:text-slate-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : (
        !touch && (
          <kbd className="rounded border border-white/10 px-1 font-mono text-xs text-slate-500">
            /
          </kbd>
        )
      )}
    </label>
  );
}

function StatusToggles({
  ui,
  touch,
}: {
  ui: ConsoleUi;
  touch: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const h = touch ? "min-h-[36px]" : "h-7";
  return (
    <>
      <button
        type="button"
        aria-pressed={ui.filters.errorsOnly}
        onClick={ui.toggleErrors}
        title={t("console.errorsOnlyHint")}
        className={`${CHIP} ${h} shrink-0 ${
          ui.filters.errorsOnly
            ? "border-rose-400/60 bg-rose-500/20 text-rose-100"
            : ui.errorCount > 0
              ? "border-rose-400/30 bg-rose-500/[0.08] text-rose-300 hover:bg-rose-500/15"
              : CHIP_OFF
        }`}
      >
        <TriangleExclamationPoint className="h-3.5 w-3.5" />
        {t("console.nErrors", { count: ui.errorCount })}
      </button>
      <button
        type="button"
        aria-pressed={ui.filters.waitingOnly}
        onClick={ui.toggleWaiting}
        className={`${CHIP} ${h} shrink-0 ${
          ui.filters.waitingOnly
            ? "border-amber-400/60 bg-amber-400/20 text-amber-100"
            : ui.waitingCount > 0
              ? "border-amber-400/40 bg-amber-400/10 text-amber-200"
              : CHIP_OFF
        }`}
      >
        <Pause className="h-3.5 w-3.5" />
        {t("console.nWaiting", { count: ui.waitingCount })}
      </button>
    </>
  );
}

function ModeToggle({
  ui,
  touch,
}: {
  ui: ConsoleUi;
  touch: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const seg = (on: boolean) =>
    `inline-flex items-center gap-1 px-2 text-xs font-medium ${touch ? "min-h-[36px]" : "h-7"} ${
      on ? "bg-white/10 text-slate-100" : "text-slate-400 hover:text-slate-200"
    }`;
  return (
    <div
      role="group"
      aria-label={t("console.grouping")}
      className="inline-flex shrink-0 overflow-hidden rounded-md border border-white/10"
    >
      <button
        type="button"
        aria-pressed={ui.mode === "tree"}
        onClick={() => ui.mode !== "tree" && ui.toggleMode()}
        className={seg(ui.mode === "tree")}
      >
        <ListTree className="h-3.5 w-3.5" />
        {t("console.tree")}
      </button>
      <button
        type="button"
        aria-pressed={ui.mode === "flat"}
        onClick={() => ui.mode !== "flat" && ui.toggleMode()}
        className={`${seg(ui.mode === "flat")} border-l border-white/10`}
      >
        <Rows3 className="h-3.5 w-3.5" />
        {t("console.flat")}
      </button>
    </div>
  );
}

function KindChips({
  ui,
  touch,
}: {
  ui: ConsoleUi;
  touch: boolean;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <>
      {TOOL_KINDS.map((k) => {
        const Icon = kindIcon(k);
        const on = ui.filters.kinds.has(k);
        return (
          <button
            key={k}
            type="button"
            aria-pressed={on}
            onClick={() => ui.toggleKind(k)}
            className={`${CHIP} ${touch ? "min-h-[36px]" : "h-7"} shrink-0 ${on ? CHIP_ON : CHIP_OFF}`}
          >
            <Icon className="h-3.5 w-3.5" />
            {t(KIND_LABEL[k])}
          </button>
        );
      })}
    </>
  );
}

/**
 * `full`: search + kinds + status toggles + Tree/Flat on two wrapping rows.
 * `compact`: search + errors + a Filters toggle that reveals the rest.
 */
export function ConsoleFilters({
  ui,
  variant,
  touch = false,
  searchRef,
}: {
  ui: ConsoleUi;
  variant: "full" | "compact";
  touch?: boolean;
  searchRef: RefObject<HTMLInputElement | null>;
}): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const active =
    ui.filters.kinds.size +
    (ui.filters.waitingOnly ? 1 : 0) +
    (ui.mode === "flat" ? 1 : 0);
  if (variant === "full") {
    return (
      <div className="flex flex-col gap-1.5 border-b border-white/[0.06] px-3 py-2">
        <div className="flex items-center gap-2">
          <SearchBox ui={ui} inputRef={searchRef} touch={touch} />
          <ModeToggle ui={ui} touch={touch} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <KindChips ui={ui} touch={touch} />
          <span className="mx-1 h-4 w-px bg-white/10" aria-hidden />
          <StatusToggles ui={ui} touch={touch} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 border-b border-white/[0.06] px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <SearchBox ui={ui} inputRef={searchRef} touch={touch} />
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={`${CHIP} ${touch ? "min-h-[40px]" : "h-8"} shrink-0 ${open || active > 0 ? CHIP_ON : CHIP_OFF}`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {active > 0
            ? t("console.filtersN", { count: active })
            : t("console.filters")}
        </button>
      </div>
      {open && (
        <div className="flex flex-wrap items-center gap-1.5">
          <KindChips ui={ui} touch={touch} />
          <StatusToggles ui={ui} touch={touch} />
          <ModeToggle ui={ui} touch={touch} />
        </div>
      )}
      {!open &&
        (ui.errorCount > 0 || ui.waitingCount > 0 || ui.filters.errorsOnly) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusToggles ui={ui} touch={touch} />
          </div>
        )}
    </div>
  );
}
