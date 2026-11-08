import {
  Bot,
  Factory,
  GitPullRequest,
  PackageCheck,
  ScanLine,
  CircleHelp,
  GitBranch,
  LayoutList,
  Map as MapIcon,
  MessageSquare,
  ScanSearch,
  ScrollText,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";
import type { TranslationKey } from "@/i18n/en";
import type { HudPanel } from "@/stores/worldUiStore";

export interface PanelMeta {
  id: HudPanel;
  /** Key that toggles the panel (display form). */
  keyLabel: string | null;
  /** KeyboardEvent.key (lower-cased) that toggles it. */
  keys: string[];
  icon: LucideIcon;
  titleKey: TranslationKey;
  hintKey: TranslationKey | null;
}

export const PANELS: Record<HudPanel, PanelMeta> = {
  sessions: {
    id: "sessions",
    keyLabel: "Tab",
    keys: ["tab"],
    icon: LayoutList,
    titleKey: "hud.panel.sessions",
    hintKey: "hud.keys.sessions",
  },
  git: {
    id: "git",
    keyLabel: "G",
    keys: ["g"],
    icon: GitBranch,
    titleKey: "hud.panel.git",
    hintKey: "hud.keys.git",
  },
  conversation: {
    id: "conversation",
    keyLabel: "C",
    keys: ["c"],
    icon: MessageSquare,
    titleKey: "hud.panel.conversation",
    hintKey: "hud.keys.chat",
  },
  events: {
    id: "events",
    keyLabel: "L",
    keys: ["l"],
    icon: ScrollText,
    titleKey: "hud.panel.events",
    hintKey: "hud.keys.events",
  },
  agents: {
    id: "agents",
    keyLabel: "T",
    keys: ["t"],
    icon: Bot,
    titleKey: "hud.panel.agents",
    hintKey: "hud.keys.agents",
  },
  minimap: {
    id: "minimap",
    keyLabel: "M",
    keys: ["m"],
    icon: MapIcon,
    titleKey: "hud.panel.minimap",
    hintKey: "hud.keys.map",
  },
  help: {
    id: "help",
    keyLabel: "H",
    keys: ["h", "?"],
    icon: CircleHelp,
    titleKey: "hud.panel.help",
    hintKey: "hud.keys.help",
  },
  graphics: {
    id: "graphics",
    keyLabel: "O",
    keys: ["o"],
    icon: SlidersHorizontal,
    titleKey: "hud.panel.graphics",
    hintKey: "hud.keys.graphics",
  },
  inspect: {
    id: "inspect",
    keyLabel: "F",
    keys: [],
    icon: ScanSearch,
    titleKey: "hud.panel.inspect",
    hintKey: null,
  },
  factoryPr: {
    id: "factoryPr",
    keyLabel: "F",
    keys: [],
    icon: GitPullRequest,
    titleKey: "hud.panel.factoryPr",
    hintKey: null,
  },
  factoryStation: {
    id: "factoryStation",
    keyLabel: "F",
    keys: [],
    icon: ScanLine,
    titleKey: "hud.panel.factoryStation",
    hintKey: null,
  },
  factoryLine: {
    id: "factoryLine",
    keyLabel: "F",
    keys: [],
    icon: Factory,
    titleKey: "hud.panel.factoryLine",
    hintKey: null,
  },
  factoryDeploy: {
    id: "factoryDeploy",
    keyLabel: "F",
    keys: [],
    icon: PackageCheck,
    titleKey: "hud.panel.factoryDeploy",
    hintKey: null,
  },
};

/** Panels with a toggle key, in key-hint order. */
export const HINT_ORDER: HudPanel[] = [
  "sessions",
  "git",
  "conversation",
  "events",
  "agents",
  "minimap",
  "graphics",
  "help",
];
