"use client";

import { create } from "zustand";
import type {
  BuildingLayout,
  CameraMode,
  InteractionEvent,
  InteractionTarget,
  PlayerPose,
  QualityTier,
} from "@/engine/contracts";

// ============================================================================
// TYPES
// ============================================================================

export type HudPanel =
  | "sessions"
  | "git"
  | "conversation"
  | "events"
  | "agents"
  | "minimap"
  | "help"
  | "graphics"
  | "inspect"
  | "factoryPr"
  | "factoryStation"
  | "factoryLine"
  | "factoryDeploy";

/** Popup for a character that belongs to a non-selected session. */
export interface PeerPopupTarget {
  sessionId: string;
  x: number;
  y: number;
}

export interface WorldStats {
  fps: number;
  frameMs: number;
  tier: QualityTier;
  drawCalls: number;
  effective?: "low" | "medium" | "high" | "ultra";
  postProcesses?: number;
}

interface WorldUiState {
  /** Panels currently open, oldest first (last = top-most). */
  panels: HudPanel[];
  /** Top-most open panel (null when none). Kept in sync with `panels`. */
  openPanel: HudPanel | null;
  inspectTarget: InteractionTarget | null;
  /** Factory target shown by the factory panels (ids only; data is read live). */
  factoryTarget: InteractionTarget | null;
  prompt: InteractionEvent | null;
  pose: PlayerPose | null;
  stats: WorldStats | null;
  cameraMode: CameraMode;
  pointerLocked: boolean;
  layout: BuildingLayout | null;
  error: string | null;
  ready: boolean;
  peerPopup: PeerPopupTarget | null;
  /** Short-lived "Entered <room>" banner. */
  banner: { id: number; text: string } | null;
  /** Bumped to re-create the world after an error (never reset). */
  worldEpoch: number;
  /** Full-screen Ops dashboard (control room) open. */
  opsOpen: boolean;
  /** Session highlighted in the Ops dashboard (console monitor F). */
  opsFocus: string | null;

  /** Replace the open panels (capped at {@link MAX_OPEN_PANELS}). */
  setPanels: (panels: HudPanel[]) => void;
  showBanner: (text: string) => void;
  clearBanner: (id?: number) => void;
  /** Clear the error and ask WorldView to build a fresh world. */
  retryWorld: () => void;
  /** Open a panel (becomes the top-most). */
  open: (panel: HudPanel) => void;
  close: (panel: HudPanel) => void;
  toggle: (panel: HudPanel) => void;
  /** Close the top-most panel. Returns true when something was closed. */
  closeTop: () => boolean;
  closeAll: () => void;
  openInspect: (target: InteractionTarget) => void;
  /** Open the factory panel matching the target kind (pr / station / line / deploy). */
  openFactory: (target: InteractionTarget) => void;
  setPrompt: (prompt: InteractionEvent | null) => void;
  setPose: (pose: PlayerPose | null) => void;
  setStats: (stats: WorldStats | null) => void;
  setCameraMode: (mode: CameraMode) => void;
  setPointerLocked: (locked: boolean) => void;
  setLayout: (layout: BuildingLayout | null) => void;
  setError: (error: string | null) => void;
  setReady: (ready: boolean) => void;
  setPeerPopup: (popup: PeerPopupTarget | null) => void;
  openOps: (focus?: string | null) => void;
  closeOps: () => void;
  toggleOps: () => void;
  reset: () => void;
}

/** How many panels can be shown at once (bottom dock shows two side by side). */
export const MAX_OPEN_PANELS = 2;

// ============================================================================
// HELPERS
// ============================================================================

function withPanels(
  panels: HudPanel[],
): Pick<WorldUiState, "panels" | "openPanel"> {
  return { panels, openPanel: panels[panels.length - 1] ?? null };
}

function pushPanel(panels: HudPanel[], panel: HudPanel): HudPanel[] {
  const next = panels.filter((p) => p !== panel);
  next.push(panel);
  // Drop the oldest when over the cap so the dock never overflows.
  while (next.length > MAX_OPEN_PANELS) next.shift();
  return next;
}

const INITIAL = {
  ...withPanels([]),
  inspectTarget: null,
  factoryTarget: null,
  prompt: null,
  pose: null,
  stats: null,
  cameraMode: "fp" as CameraMode,
  pointerLocked: false,
  layout: null,
  error: null,
  ready: false,
  peerPopup: null,
  banner: null as { id: number; text: string } | null,
  opsOpen: false,
  opsFocus: null as string | null,
};

/** Interaction kind -> factory panel (kept here so the store stays engine-free). */
export const FACTORY_PANEL_BY_KIND: Partial<
  Record<InteractionTarget["kind"], HudPanel>
> = {
  lanePlate: "factoryPr",
  workpiece: "factoryPr",
  station: "factoryStation",
  lineBoard: "factoryLine",
  trunk: "factoryLine",
  mainLine: "factoryLine",
  dock: "factoryDeploy",
};

let bannerSeq = 0;

// ============================================================================
// STORE
// ============================================================================

export const useWorldUiStore = create<WorldUiState>()((set, get) => ({
  ...INITIAL,
  worldEpoch: 0,

  setPanels: (panels) => set(withPanels(panels.slice(-MAX_OPEN_PANELS))),
  showBanner: (text) => set({ banner: { id: ++bannerSeq, text } }),
  clearBanner: (id) =>
    set((s) =>
      s.banner && (id === undefined || s.banner.id === id)
        ? { banner: null }
        : s,
    ),
  retryWorld: () =>
    set((s) => ({ error: null, ready: false, worldEpoch: s.worldEpoch + 1 })),
  open: (panel) => set((s) => withPanels(pushPanel(s.panels, panel))),
  close: (panel) =>
    set((s) =>
      s.panels.includes(panel)
        ? withPanels(s.panels.filter((p) => p !== panel))
        : s,
    ),
  toggle: (panel) => {
    const { panels } = get();
    if (panels.includes(panel)) get().close(panel);
    else get().open(panel);
  },
  closeTop: () => {
    const { panels } = get();
    if (panels.length === 0) return false;
    set(withPanels(panels.slice(0, -1)));
    return true;
  },
  closeAll: () => set((s) => (s.panels.length ? withPanels([]) : s)),
  openInspect: (target) => {
    set({ inspectTarget: target });
    get().open("inspect");
  },
  openFactory: (target) => {
    const id = FACTORY_PANEL_BY_KIND[target.kind];
    if (!id) return;
    set({ factoryTarget: target });
    get().open(id);
  },
  setPrompt: (prompt) => set({ prompt }),
  setPose: (pose) => set({ pose }),
  setStats: (stats) => set({ stats }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  setPointerLocked: (pointerLocked) => set({ pointerLocked }),
  setLayout: (layout) => set({ layout }),
  setError: (error) => set({ error }),
  setReady: (ready) => set({ ready }),
  setPeerPopup: (peerPopup) => set({ peerPopup }),
  openOps: (focus = null) => set({ opsOpen: true, opsFocus: focus }),
  closeOps: () => set((s) => (s.opsOpen ? { opsOpen: false } : s)),
  toggleOps: () =>
    set((s) => ({
      opsOpen: !s.opsOpen,
      opsFocus: s.opsOpen ? s.opsFocus : null,
    })),
  reset: () => set({ ...INITIAL }),
}));

export const selectOpenPanel = (s: WorldUiState): HudPanel | null =>
  s.openPanel;
export const selectPanels = (s: WorldUiState): HudPanel[] => s.panels;
