"use client";

/** Unified diff of an Edit's `old_string` -> `new_string`, syntax highlighted. */

import { memo, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { lineDiff } from "@/utils/console/lineDiff";
import { CODE_BOX } from "../theme";
import { tokenizeLine, type Lang } from "../tokenize";
import { Tokens } from "./code";

const CAP = 2000;

const ROW_BG = {
  ctx: "",
  add: "bg-emerald-500/[0.12]",
  del: "bg-rose-500/[0.12]",
} as const;
const SIGN = {
  ctx: { ch: " ", cls: "text-slate-600" },
  add: { ch: "+", cls: "text-emerald-400" },
  del: { ch: "−", cls: "text-rose-400" },
} as const;

export const DiffView = memo(function DiffView({
  oldText,
  newText,
  lang,
}: {
  oldText: string;
  newText: string;
  lang: Lang;
}): ReactNode {
  const { t } = useTranslation();
  const [full, setFull] = useState(false);
  const diff = useMemo(
    () =>
      lineDiff(oldText, newText, {
        maxLines: full ? CAP * 2 : 400,
        context: 3,
      }),
    [oldText, newText, full],
  );
  // Relative line numbers inside the snippet (the file offset is unknown).
  const numbers = useMemo(() => {
    let o = 0;
    let n = 0;
    return diff.lines.map((l) => {
      if (l.type !== "add") o++;
      if (l.type !== "del") n++;
      return { o: l.type === "add" ? null : o, n: l.type === "del" ? null : n };
    });
  }, [diff]);
  return (
    <div className={CODE_BOX}>
      <div className="overflow-x-auto py-1.5">
        <table className="w-full border-collapse">
          <tbody>
            {diff.lines.map((l, i) => {
              const s = SIGN[l.type];
              return (
                <tr key={i} className={`align-top ${ROW_BG[l.type]}`}>
                  <td className="w-[4ch] select-none pl-2 pr-1 text-right text-slate-600 tabular-nums">
                    {numbers[i].o}
                  </td>
                  <td className="w-[4ch] select-none pr-2 text-right text-slate-600 tabular-nums">
                    {numbers[i].n}
                  </td>
                  <td className={`w-[2ch] select-none font-bold ${s.cls}`}>
                    {s.ch}
                  </td>
                  <td className="whitespace-pre pr-4 text-slate-200">
                    <Tokens tokens={tokenizeLine(l.text, lang)} />
                    {l.text === "" ? " " : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {diff.truncated && !full && (
        <button
          type="button"
          onClick={() => setFull(true)}
          className="w-full border-t border-white/[0.06] px-3 py-1 text-left text-xs text-sky-300 hover:bg-white/[0.04]"
        >
          {t("console.showFullDiff")}
        </button>
      )}
    </div>
  );
});
