"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Bordered card with a small-caps title, matching the ops dashboard cards. */
export function PanelCard({
  title,
  icon: Icon,
  action,
  children,
  className = "",
}: {
  title: string;
  icon: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0B111B]/90 shadow-lg shadow-black/30 ${className}`}
    >
      <header className="flex shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-4 py-2.5">
        <Icon className="h-4 w-4 text-[#D97757]" aria-hidden />
        <h2 className="flex-1 truncate text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">
          {title}
        </h2>
        {action}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  );
}

/** Labelled native select styled for the dark theme. */
export function Picker({
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  className?: string;
}): ReactNode {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`min-w-0 rounded-xl border border-white/10 bg-slate-900/90 px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-[#D97757]/60 ${className}`}
    >
      <option value="" disabled>
        {label}
      </option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
