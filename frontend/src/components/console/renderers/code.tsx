"use client";

/** Code-ish building blocks shared by the tool renderers. */

import { memo, useState, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { CODE_BOX } from "../theme";
import {
  TOKEN_CLASS,
  tokenizeLine,
  tokenizeShell,
  type Lang,
  type Token,
} from "../tokenize";

/** Lines shown before a "show all" toggle. */
export const PREVIEW_LINES = 40;

export function Tokens({ tokens }: { tokens: readonly Token[] }): ReactNode {
  return (
    <>
      {tokens.map((tk, i) =>
        tk.t === "plain" ? (
          <span key={i}>{tk.v}</span>
        ) : (
          <span key={i} className={TOKEN_CLASS[tk.t]}>
            {tk.v}
          </span>
        ),
      )}
    </>
  );
}

/** Byte size label: `812 B`, `2.0 KB`, `1.4 MB`. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Highlighted, optionally numbered code lines with a "show all" toggle past
 * {@link PREVIEW_LINES}.
 */
export const CodeLines = memo(function CodeLines({
  text,
  lang,
  startLine = 1,
  numbered = true,
  shell = false,
  maxLines = PREVIEW_LINES,
  className = "",
}: {
  text: string;
  lang: Lang;
  startLine?: number;
  numbered?: boolean;
  /** Tokenize as shell instead of `lang`. */
  shell?: boolean;
  maxLines?: number;
  className?: string;
}): ReactNode {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const lines = text.replace(/\n$/, "").split("\n");
  const shown = all ? lines : lines.slice(0, maxLines);
  const width = String(startLine + lines.length - 1).length;
  return (
    <div className={`${CODE_BOX} ${className}`}>
      <div className="overflow-x-auto py-1.5">
        <table className="w-full border-collapse">
          <tbody>
            {shown.map((line, i) => (
              <tr key={i} className="align-top hover:bg-white/[0.03]">
                {numbered && (
                  <td
                    className="select-none pl-3 pr-3 text-right text-slate-600 tabular-nums"
                    style={{ width: `${width + 2}ch` }}
                  >
                    {startLine + i}
                  </td>
                )}
                <td
                  className={`whitespace-pre pr-4 text-slate-200 ${numbered ? "" : "pl-3"}`}
                >
                  <Tokens
                    tokens={
                      shell ? tokenizeShell(line) : tokenizeLine(line, lang)
                    }
                  />
                  {line === "" ? " " : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length > maxLines && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="w-full border-t border-white/[0.06] px-3 py-1 text-left text-xs text-sky-300 hover:bg-white/[0.04]"
        >
          {all
            ? t("console.showLess")
            : t("console.showAllLines", { count: lines.length })}
        </button>
      )}
    </div>
  );
});

/** Section divider: `── stdout (2.0 KB of 18.4 KB) ──`. */
export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}): ReactNode {
  return (
    <div className="mb-1 mt-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500 first:mt-0">
      <span className="shrink-0">{children}</span>
      <span className="h-px flex-1 bg-white/[0.06]" />
      {right && (
        <span className="shrink-0 normal-case tracking-normal">{right}</span>
      )}
    </div>
  );
}

/** Key/value chip: `path: src` . */
export function KV({ k, v }: { k: string; v: ReactNode }): ReactNode {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-0.5 text-xs">
      <span className="text-slate-500">{k}</span>
      <span className="truncate font-mono text-slate-200">{v}</span>
    </span>
  );
}

/** Placeholder for an empty section. */
export function Empty({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-1 py-1 text-xs italic text-slate-500">{children}</div>
  );
}
