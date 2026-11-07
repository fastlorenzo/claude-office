/**
 * Shared contracts for the 3D office (Babylon.js) — the single source of truth
 * for the types exchanged between:
 *   - the backend `/ws/campus` feed        (CampusSession / CampusState)
 *   - pure layout / logic modules          (engine/layout, engine/logic)
 *   - the Babylon world                    (engine/world/World.ts)
 *   - the React shell + HUD                (components/world/*)
 *
 * No Babylon imports here: everything is plain data so it is usable from node
 * tests and from React without pulling the engine into the bundle graph.
 *
 * Units: metres, radians. World axes: +Y up, +Z runs down the hall away from
 * the lobby, X is across the hall (east rooms x > 0, west rooms x < 0).
 */

import type {
  Agent,
  AgentState,
  BossState,
  OfficeState,
  TodoItem,
} from "@/types";
// NOTE: `Boss` exported from @/types is an unrelated `string | null` alias
// (generated name collision); the real model is `Boss1` in generated.ts.
import type { Boss1 as Boss } from "@/types/generated";
import type { GraphicsSettings } from "@/engine/fx/graphicsSettings";

export type { GraphicsSettings };

// ============================================================================
// CAMPUS FEED (mirrors backend/app/models/campus.py, camelCase over the wire)
// Kept hand-written on purpose: the generated CampusSession (@/types) marks
// defaulted fields optional and adds an index signature, while the backend
// always serialises them. This stricter shape is what the wire carries.
// ============================================================================

export type CampusBucket = "needs_you" | "working" | "done";

export interface CampusActivity {
  timestamp: string; // ISO
  type: string; // event type, e.g. "pre_tool_use"
  agentId: string; // "main" for the boss
  summary: string; // <= 140 chars
}

export interface CampusSession {
  sessionId: string;
  bucket: CampusBucket;
  boss: Boss;
  agents: Agent[];
  office: OfficeState;
  todos: TodoItem[];
  recentActivity: CampusActivity[]; // newest last, <= 8
  /**
   * Session-level goal, a short headline (<= 90 chars), e.g. "Build the 3D office view".
   * Rolling: refined when the user gives a new top-level instruction.
   * Null until the first prompt.
   */
  objective?: string | null;
  /** What it is doing right now, one line (<= 90 chars), e.g. "Fixing parallel subagent tracking". */
  focus?: string | null;
  /** Up to 4 concrete work items in flight (in-progress todos, then active subagent tasks). */
  workItems?: string[];
  /** Claude Code session name (/rename → transcript `custom-title`), when set. */
  sessionName?: string | null;
  /** Git branch of the session's working dir when known, e.g. "feat/3d-office". */
  gitBranch?: string | null;
  ended: boolean;
  lastUpdated: string; // ISO
}

export interface CampusState {
  sessions: CampusSession[];
  lastUpdated: string;
}

/** Session metadata from REST `/api/v1/sessions` needed by the world. */
export interface SessionMeta {
  id: string;
  label: string; // display name / project name
  createdAt: number; // epoch ms
  status: "active" | "completed";
}

// ============================================================================
// GEOMETRY
// ============================================================================

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

// ============================================================================
// BUILDING LAYOUT (engine/layout/buildingLayout.ts produces these)
// ============================================================================

export const LAYOUT = {
  ROOM_W: 9, // along the hall (Z)
  ROOM_D: 7, // across the hall (X)
  WALL_H: 3.2,
  HALL_W: 7,
  LOBBY_D: 12,
  CONTROL_D: 10,
  ROOM_GAP: 0.4, // wall thickness between neighbouring rooms
  DOOR_W: 1.4,
  SILL_H: 0.9, // plaster below the glass front
  MIN_BAYS: 2, // building always shows at least 2 bays per side
  MAX_FEEDS: 16,
} as const;

export type RoomSide = "east" | "west";

export interface RoomSlot {
  index: number; // 0-based allocation index
  side: RoomSide;
  bay: number; // position along the hall
}

export interface DeskSlot {
  /** Desk centre on the floor (world space). */
  position: Vec3;
  /** Yaw the seated character faces (world space). */
  yaw: number;
  /** Where the character's hips go when seated. */
  seat: Vec3;
  /** Point 0.7 m behind the chair where walking ends before sitting. */
  approach: Vec3;
  /** Monitor screen centre (world space) and its facing yaw. */
  monitor: { position: Vec3; yaw: number };
}

export interface RoomLayout {
  sessionId: string;
  slot: RoomSlot;
  /** Room centre at floor level (world space). */
  origin: Vec3;
  /** Rotation of the room's local frame. Local -X faces the hall (door wall). */
  yaw: number;
  size: { w: number; d: number; h: number };
  door: Vec3; // centre of the door gap, floor level
  doorOutside: Vec3; // 1 m into the hall
  doorInside: Vec3; // 1 m into the room
  bossDesk: DeskSlot;
  desks: DeskSlot[]; // exactly 8, index == backend agent.desk - 1 (desk is 1-based) — see roomLayout
  /** Walking spine from doorInside to the room centre. */
  aisle: Vec3[];
  whiteboard: { position: Vec3; yaw: number; width: number; height: number };
  lounge: { position: Vec3; yaw: number };
  lamp: Vec3; // status lamp above the door, hall side
  nameplate: { position: Vec3; yaw: number };
  feedCamera: { position: Vec3; target: Vec3 };
  bounds: { min: Vec3; max: Vec3 };
}

export interface BuildingLayout {
  lobby: { origin: Vec3; size: Vec3; spawn: Vec3; spawnYaw: number };
  hall: { origin: Vec3; length: number; width: number }; // origin = hall start centre at floor
  controlRoom: {
    origin: Vec3;
    size: Vec3;
    door: Vec3;
    screenWall: {
      origin: Vec3;
      yaw: number;
      cols: number;
      rows: number;
      cellW: number;
      cellH: number;
    };
    spawn: Vec3;
  };
  rooms: RoomLayout[];
  bays: number; // rooms per side (>= MIN_BAYS)
  /** Empty bay slots (no session) that render as plain wall. */
  emptySlots: RoomSlot[];
  bounds: { min: Vec3; max: Vec3 };
}

export type Zone =
  | { kind: "lobby" }
  | { kind: "hall" }
  | { kind: "control" }
  | { kind: "room"; sessionId: string }
  | { kind: "outside" };

// ============================================================================
// STATUS / POSES (engine/logic/status.ts)
// ============================================================================

export type RoomStatus = "needs_you" | "working" | "done" | "ended";

export const STATUS_COLORS: Record<RoomStatus, string> = {
  needs_you: "#f59e0b",
  working: "#3b82f6",
  done: "#22c55e",
  ended: "#475569",
};

export type CharacterPose =
  | "idle" // standing idle
  | "walking"
  | "sitting" // seated, hands resting
  | "typing" // seated, typing
  | "thinking" // seated, hand on chin / slower
  | "raiseHand" // seated/standing, hand raised (needs permission)
  | "celebrating"; // short cheer then back to sitting

// ============================================================================
// WORLD SYNC (engine/logic/syncDiff.ts)
// ============================================================================

export interface WorldAgentModel {
  state: AgentState;
  desk: number | null;
  bubbleKey: string;
  taskKey: string;
  color: string;
}

export interface WorldRoomModel {
  slot: RoomSlot;
  label: string;
  status: RoomStatus;
  monitorKey: string;
  todosKey: string;
  boss: { state: BossState; bubbleKey: string };
  agents: Map<string, WorldAgentModel>;
}

export interface WorldModel {
  rooms: Map<string, WorldRoomModel>;
  selectedSessionId: string | null;
}

export type SyncOp =
  | { op: "createRoom"; sessionId: string; slot: RoomSlot; label: string }
  | { op: "disposeRoom"; sessionId: string }
  | { op: "roomLabel"; sessionId: string; label: string }
  | { op: "roomStatus"; sessionId: string; status: RoomStatus }
  | { op: "monitor"; sessionId: string; lines: string[]; key: string }
  | { op: "todos"; sessionId: string; todos: TodoItem[]; key: string }
  | { op: "boss"; sessionId: string; boss: Boss }
  | { op: "spawnAgent"; sessionId: string; agent: Agent }
  | { op: "updateAgent"; sessionId: string; agent: Agent }
  | { op: "departAgent"; sessionId: string; agentId: string }
  | { op: "select"; sessionId: string | null };

export interface SyncInput {
  campus: CampusSession[];
  sessions: SessionMeta[];
  selectedSessionId: string | null;
}

// ============================================================================
// INTERACTION (engine/interaction/*)
// ============================================================================

export type InteractionKind =
  "monitor" | "whiteboard" | "screen" | "character" | "door";

export interface InteractionTarget {
  kind: InteractionKind;
  sessionId: string;
  agentId?: string; // "boss" for the main agent
  roomLabel: string;
}

/** Read-only today; write actions (answer_permission, send_message) are added here later. */
export type InteractionActionId = "inspect" | "enter" | "popup";

export interface InteractionAction {
  id: InteractionActionId;
  key: "F" | "Enter";
  labelKey: string; // i18n key, e.g. "world.action.inspect"
}

export interface ScreenPos {
  x: number;
  y: number;
}

export interface InteractionEvent {
  target: InteractionTarget;
  actions: InteractionAction[];
  screenPos: ScreenPos;
  distance: number;
}

// ============================================================================
// WORLD API + EVENTS (engine/world/World.ts implements, React consumes)
// ============================================================================

export type CameraMode = "fp" | "tp";
export type QualitySetting = "auto" | "high" | "low";
export type QualityTier = "high" | "low";

export interface PlayerPose {
  x: number;
  z: number;
  yaw: number;
  zone: Zone;
}

export interface WorldEvents {
  ready: void;
  error: { message: string };
  /** Current interactable in reach (null when nothing). Emitted on change. */
  interaction: InteractionEvent | null;
  /** User triggered an action on a target (F / Enter / click). */
  action: {
    action: InteractionActionId;
    target: InteractionTarget;
    screenPos: ScreenPos;
  };
  /** ~10 Hz while moving. */
  pose: PlayerPose;
  /** ~1 Hz. */
  stats: { fps: number; frameMs: number; tier: QualityTier; drawCalls: number };
  pointerLock: boolean;
  cameraMode: CameraMode;
  layout: BuildingLayout;
}

export interface WorldOptions {
  quality: QualitySetting;
  /** Full graphics settings (Graphics menu). When present it supersedes `quality`. */
  graphics?: GraphicsSettings;
  cameraMode: CameraMode;
  isMobile: boolean;
  assetBase: string; // "/assets"
}

export interface IWorld {
  init(): Promise<void>;
  sync(input: SyncInput): void;
  setCameraMode(mode: CameraMode): void;
  setQuality(q: QualitySetting): void;
  /** Apply full graphics settings live (presets / custom). Optional until the quality pass lands. */
  setGraphics?(settings: GraphicsSettings): void;
  /** Disable game input (HUD panel open) — releases pointer lock. */
  setInputEnabled(enabled: boolean): void;
  /** Teleport the player to a room's door (minimap fast travel) or "lobby" / "control". */
  teleport(to: { sessionId: string } | "lobby" | "control"): void;
  /** Touch controls feed these. */
  setVirtualMove(x: number, y: number): void;
  addLook(dx: number, dy: number): void;
  triggerAction(id: InteractionActionId): void;
  resize(): void;
  dispose(): void;
  on<K extends keyof WorldEvents>(
    event: K,
    cb: (payload: WorldEvents[K]) => void,
  ): () => void;
}
