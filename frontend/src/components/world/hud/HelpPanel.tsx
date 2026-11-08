"use client";

import type { ReactNode } from "react";
import { useTranslation, type TranslationKey } from "@/hooks/useTranslation";
import { Keycap } from "./Keycap";
import { LABEL } from "./glass";

const ROWS: { keys: string[]; label: TranslationKey }[] = [
  { keys: ["W", "A", "S", "D"], label: "hud.help.move" },
  { keys: ["Mouse"], label: "hud.help.look" },
  { keys: ["Shift"], label: "hud.help.run" },
  { keys: ["F"], label: "hud.help.interact" },
  { keys: ["Enter"], label: "hud.help.enter" },
  { keys: ["V"], label: "hud.help.camera" },
  { keys: ["N"], label: "hud.help.fly" },
  { keys: ["Shift", "N"], label: "hud.help.flyLand" },
  { keys: ["Space", "E", "Ctrl", "Q"], label: "hud.help.flyVertical" },
  { keys: ["Shift", "Alt", "Wheel"], label: "hud.help.flySpeed" },
  { keys: ["Tab"], label: "hud.keys.sessions" },
  { keys: ["G"], label: "hud.keys.git" },
  { keys: ["C"], label: "hud.keys.chat" },
  { keys: ["L"], label: "hud.keys.events" },
  { keys: ["A"], label: "hud.keys.agents" },
  { keys: ["M"], label: "hud.keys.map" },
  { keys: ["P"], label: "hud.keys.overview" },
  { keys: ["B"], label: "hud.help.ops" },
  { keys: ["O"], label: "hud.keys.graphics" },
  { keys: ["H"], label: "hud.keys.help" },
  { keys: ["Esc"], label: "hud.help.close" },
];

export function HelpPanel(): ReactNode {
  const { t } = useTranslation();
  return (
    <div className="p-4">
      <p className={`${LABEL} mb-3`}>{t("hud.help.controls")}</p>
      <table className="w-full text-sm">
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.label} className="border-b border-white/5 last:border-0">
              <td className="py-2 pr-4">
                <span className="flex flex-wrap gap-1">
                  {r.keys.map((k) => (
                    <Keycap key={k}>{k}</Keycap>
                  ))}
                </span>
              </td>
              <td className="py-2 text-slate-300">{t(r.label)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-4 text-xs leading-relaxed text-slate-500">
        {t("hud.help.tip")}
      </p>
    </div>
  );
}
