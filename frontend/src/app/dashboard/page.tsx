"use client";

import type { ReactNode } from "react";
import { DashboardShell } from "@/components/dashboard/DashboardShell";

/** Static-export route: dashboard.html (no WebGL, no pixi). */
export default function DashboardPage(): ReactNode {
  return <DashboardShell />;
}
