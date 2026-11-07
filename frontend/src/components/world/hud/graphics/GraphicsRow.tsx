"use client";

import type { ReactNode } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import type { GraphicsSettings } from "@/engine/fx/graphicsSettings";
import { ImpactIcon, Segmented, SelectField, Slider, Toggle } from "./controls";
import { formatValue, type RowDef } from "./schema";

type SettingKey = Exclude<keyof GraphicsSettings, "preset">;

export function GraphicsRow({
  row,
  value,
  pending,
  onChange,
}: {
  row: RowDef;
  value: GraphicsSettings[keyof GraphicsSettings];
  /** Engine can't apply live yet (world.setGraphics missing). */
  pending: boolean;
  onChange: (key: keyof GraphicsSettings, v: never) => void;
}): ReactNode {
  const { t } = useTranslation();
  const label = t(`gfx.s.${row.key as SettingKey}`);
  const desc = t(`gfx.s.${row.key as SettingKey}.d`);
  const set = (v: unknown): void => onChange(row.key, v as never);

  let control: ReactNode = null;
  if (row.kind === "toggle")
    control = <Toggle label={label} checked={value === true} onChange={set} />;
  else if (row.kind === "segmented")
    control = (
      <Segmented
        label={label}
        options={row.options}
        value={value as string | number}
        onChange={set}
      />
    );
  else if (row.kind === "select")
    control = (
      <SelectField
        label={label}
        options={row.options}
        value={value as string | number}
        onChange={set}
      />
    );
  else if (row.kind === "slider")
    control = (
      <Slider
        label={label}
        value={value as number}
        min={row.min}
        max={row.max}
        step={row.step}
        display={formatValue(value as number, row.format)}
        onChange={set}
      />
    );

  return (
    <div
      title={desc}
      className="flex flex-col gap-1.5 border-b border-white/5 px-4 py-2.5 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <ImpactIcon impact={row.impact} />
          <span className="text-[13px] font-medium text-slate-100">
            {label}
          </span>
          {pending ? (
            <span className="rounded bg-white/5 px-1.5 py-px text-[9px] uppercase tracking-wider text-slate-500">
              {t("gfx.nextUpdate")}
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 pl-[22px] text-[11px] leading-snug text-slate-500">
          {desc}
        </p>
      </div>
      <div className="shrink-0 pl-[22px] sm:pl-0">{control}</div>
    </div>
  );
}
