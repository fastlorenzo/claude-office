import type { ReactNode } from "react";

export function Keycap({
  children,
  accent = false,
}: {
  children: ReactNode;
  accent?: boolean;
}): ReactNode {
  return (
    <kbd
      className={`inline-flex min-w-[1.5rem] h-6 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold leading-none border border-b-2 ${
        accent
          ? "bg-[#D97757]/20 text-[#f0a58b] border-[#D97757]/50"
          : "bg-white/5 text-slate-200 border-white/15"
      }`}
    >
      {children}
    </kbd>
  );
}
