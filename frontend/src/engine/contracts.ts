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
import type { FactoryZone } from "@/engine/layout/factoryLayout";

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
  /**
   * Plain-language summary of what the session is building, <= 70 chars,
   * understandable without context, e.g. "Add SSO login to the admin dashboard".
   * Never just a ticket id. Null until it can be inferred.
   */
  summary?: string | null;
  /** Ticket / PR references found in the session (name, branch, prompts), e.g. ["CONT-839", "#412"]. */
  refs?: string[];
  /** Project / app name, e.g. "continuum" (repo basename or package name). */
  project?: string | null;
  /** Key of the CampusProject this session belongs to (CampusState.projects[].id). */
  projectId?: string | null;
  /** Where the session is at right now (deterministic, from the live tool stream). */
  phase?: SessionPhase | null;
  alive?: boolean | null;
  lastEventAt?: string | null;
  /** Claude Code session name (/rename → transcript `custom-title`), when set. */
  sessionName?: string | null;
  /** Git branch of the session's working dir when known, e.g. "feat/3d-office". */
  gitBranch?: string | null;
  /** Live Claude Code telemetry from the status line JSON (null until the statusline tee reports). */
  telemetry?: SessionTelemetry | null;
  /** Per-session activity counters for sparklines (ring buffer, oldest first). */
  activity?: SessionActivityStats | null;
  ended: boolean;
  lastUpdated: string; // ISO
}

/** Coarse activity phase shown at a glance ("Running tests", "Waiting for you"). */
export type SessionPhaseKind =
  | "needs_approval" // permission prompt pending
  | "waiting_user" // turn ended, waiting for the user's reply
  | "planning" // plan mode / thinking before tools
  | "researching" // web search / fetch / reading docs
  | "exploring" // reading / grepping code
  | "coding" // Edit / Write
  | "testing" // test runners
  | "building" // build / typecheck / lint
  | "running" // other shell commands
  | "git" // commit / push / PR
  | "delegating" // subagents running
  | "compacting"
  | "idle"
  | "ended";

export interface SessionPhase {
  kind: SessionPhaseKind;
  /** Short human label, <= 40 chars, e.g. "Running tests", "Waiting for your approval". */
  label: string;
  /** Optional specifics, <= 80 chars, e.g. "vitest · 3 failing", "editing World.ts". */
  detail?: string | null;
  /** ISO timestamp when this phase started (for "for 2m"). */
  since?: string | null;
}

/**
 * What Claude Code's status line JSON exposes per session (forwarded by the
 * hooks package's statusline tee). All optional: older Claude Code versions
 * omit some blocks.
 */
export interface SessionTelemetry {
  model?: string | null; // display name, e.g. "Opus 5.5"
  effort?: string | null; // "low" | "medium" | "high" | ...
  contextUsedPct?: number | null; // 0-100
  contextTokens?: number | null; // total input tokens in the window
  contextWindow?: number | null; // window size, e.g. 1_000_000
  costUsd?: number | null; // session total
  linesAdded?: number | null;
  linesRemoved?: number | null;
  durationMs?: number | null; // session wall time
  cacheWarm?: boolean | null;
  cacheExpiresAt?: string | null; // ISO
  repo?: string | null; // "owner/name"
  outputStyle?: string | null;
  /** "statusline" = exact (status line tee); "transcript" = estimated from the transcript JSONL. */
  source?: "statusline" | "transcript" | null;
  updatedAt: string; // ISO, when the status line last reported
}

/** Account-wide rate-limit window (from the status line `rate_limits`). */
export interface RateLimitWindow {
  usedPct: number; // 0-100
  resetsAt?: string | null; // ISO
  /** Projected use at reset if the current burn continues (0-100+), computed by the backend. */
  projectedPct?: number | null;
}

export interface SessionActivityStats {
  /** Events per minute for the last 30 minutes, oldest first (30 buckets). */
  eventsPerMin: number[];
  /** Tool-call counts in this session by coarse kind (same kinds as SessionPhaseKind where they apply). */
  toolMix: Partial<Record<SessionPhaseKind, number>>;
  toolCalls: number;
  /** Cumulative subagents spawned (not the live count). */
  subagentsSpawned: number;
  /** Subagents running right now (liveness-checked); absent = unknown. */
  subagentsRunning?: number | null;
  /** Test runs seen (Bash classified as testing) and how many exited non-zero, if known. */
  testRuns?: number;
  testFailures?: number;
  errors?: number; // tool errors (PostToolUseFailure)
}

/** Building-wide stats for the control room. */
export interface CampusStats {
  fiveHour?: RateLimitWindow | null;
  sevenDay?: RateLimitWindow | null;
  /** Sum of session costs seen today (local day) and over the restore window. */
  costTodayUsd?: number | null;
  /** Cost per hour over the last 60 min (burn rate). */
  burnUsdPerHour?: number | null;
  sessionsByStatus: Partial<Record<RoomStatus, number>>;
  activeSubagents: number;
  /** Building-wide events per minute, last 60 min, oldest first. */
  eventsPerMin: number[];
  /** Cost per 5-minute bucket, last 3 h, oldest first. */
  costSeries?: number[];
  linesAddedToday?: number | null;
  linesRemovedToday?: number | null;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Projects (one team room per project) + CI/CD
// ---------------------------------------------------------------------------

export type CheckState =
  "none" | "queued" | "running" | "success" | "failure" | "cancelled";

export type CheckKind =
  "test" | "build" | "lint" | "security" | "deploy" | "release" | "other";

export interface CheckRun {
  name: string; // e.g. "build", "test (3.12)", "lint"
  state: CheckState;
  startedAt?: string | null;
  durationS?: number | null;
  url?: string | null;
  kind?: CheckKind;
  attempt?: number | null;
  /** Failed at least once, then passed on a re-run. */
  flaky?: boolean;
}

export interface CheckSummary {
  state: CheckState; // rolled up: failure > running > queued > success > none
  total: number;
  passed: number;
  failed: number;
  pending: number;
  runs?: CheckRun[]; // <= 12
}

export interface PrLabel {
  name: string;
  color?: string | null; // "#rrggbb"
}

export interface PullRequestInfo {
  number: number;
  title: string;
  branch: string;
  author?: string | null;
  url?: string | null;
  draft: boolean;
  state: "open" | "merged" | "closed";
  reviewDecision?: "approved" | "changes_requested" | "review_required" | null;
  mergeable?: "mergeable" | "conflicting" | "unknown" | null;
  checks: CheckSummary;
  /** Session whose git branch matches this PR's head branch, when any. */
  sessionId?: string | null;
  updatedAt: string;
  baseBranch?: string | null;
  additions?: number | null;
  deletions?: number | null;
  changedFiles?: number | null;
  labels?: PrLabel[];
  /** dependabot / renovate / github-actions author. */
  bot?: boolean;
  /** mergeable == CONFLICTING. */
  conflict?: boolean;
  /** Open and not updated for more than the backend's CI_STALE_PR_DAYS. */
  stale?: boolean;
  /** Any check on this PR is flaky. */
  flaky?: boolean;
  createdAt?: string | null;
  mergedAt?: string | null;
  closedAt?: string | null;
}

/** A recent workflow run on the default branch / tags (CI, deploy, release). */
export interface PipelineRun {
  id: string;
  workflow: string;
  kind: "ci" | "deploy" | "release" | "other";
  branch?: string | null;
  state: CheckState;
  startedAt?: string | null;
  durationS?: number | null;
  url?: string | null;
  event?: string | null;
  headSha?: string | null;
  attempt?: number | null;
  /** Succeeded, but only on attempt > 1. */
  flaky?: boolean;
}

export interface ReleaseInfo {
  tag: string;
  name?: string | null;
  publishedAt?: string | null;
  prerelease?: boolean;
  url?: string | null;
}

export interface LocalGitState {
  branch: string | null;
  ahead: number;
  behind: number;
  dirtyFiles: number;
  /** Commits on local branches that exist on no remote. */
  unpushed?: number;
  /** Checked-out branches across the worktrees. */
  branches?: string[];
  lastCommit?: { hash: string; message: string; at: string } | null;
  worktrees?: {
    path: string;
    branch: string | null;
    sessionId?: string | null;
    dirtyFiles?: number;
    ahead?: number;
  }[];
}

export interface CampusProject {
  /** Stable key: "owner/name" when the remote is known, else the repo root path. */
  id: string;
  name: string; // display, e.g. "continuum"
  repo?: string | null; // "owner/name"
  defaultBranch?: string | null;
  sessionIds: string[]; // live sessions working in this repo (incl. worktrees)
  pullRequests?: PullRequestInfo[]; // open PRs + PRs merged/closed in the last 24 h, <= 20
  pipelines?: PipelineRun[]; // newest first, <= 10
  /** Whether CI data is available (gh installed + authenticated + GitHub remote). */
  ciAvailable?: boolean;
  updatedAt: string;
  /** Rolled up from the newest CI run on defaultBranch. */
  mainHealth?: CheckState;
  releases?: ReleaseInfo[]; // <= 5
  localGit?: LocalGitState | null;
  /** Last fetch failed; data is last-good. */
  stale?: boolean;
  ciError?: string | null;
  fetchedAt?: string | null;
  /** Shown because of the pinned-repos setting (may have no live session). */
  pinned?: boolean;
}

/** Content revisions of the three feed sections (equal rev = identical content). */
export interface CampusRevs {
  sessions: string;
  projects: string;
  stats: string;
}

export interface CampusState {
  sessions: CampusSession[];
  /** Sessions grouped by project with CI/CD data; absent on older backends. */
  projects?: CampusProject[] | null;
  /** Building-wide stats; absent on older backends. */
  stats?: CampusStats | null;
  lastUpdated: string;
  /** Server clock (epoch ms) when this frame was built. */
  sentAt?: number | null;
  /** Per-section content revisions; absent on older backends. */
  revs?: CampusRevs | null;
  /** Backend `CI_STALE_PR_DAYS` (PRs idle longer are flagged `stale`). */
  stalePrDays?: number | null;
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
//
// One TEAM ROOM per PROJECT off the hall; inside, one POD per session (the
// session's lead desk at the head of a bench of 8 subagent desks). Rooms sit
// on a bay grid along the hall (BAY_W per bay): an entry bay (door, lounge,
// coffee point) + one bay per pod. Rooms grow by appending pod bays at the
// far end, so existing pods never move when a room grows.

export const LAYOUT = {
  /** Bay pitch along the hall (one pod per bay). */
  ROOM_W: 4.8,
  /** Project room depth across the hall (glass front → far / overlook wall). */
  ROOM_D: 9.6,
  WALL_H: 3.2,
  HALL_W: 7,
  LOBBY_D: 12,
  /** Control-room footprint at the hall's far end (round ops room inside). */
  CONTROL_D: 18,
  CONTROL_MIN_W: 20,
  CONTROL_H: 4.5,
  /** Inter-room walls live inside the room footprints (bay grid is gapless). */
  ROOM_GAP: 0,
  DOOR_W: 1.4,
  /** Circulation strip along the glass front inside a project room. */
  CORRIDOR_W: 1.6,
  SILL_H: 0.9,
  /** Minimum hall length in bays (per side). */
  MIN_BAYS: 4,
  MAX_FEEDS: 16,
} as const;

export type RoomSide = "east" | "west";

/** Room size class by session count: 1–2 standard, 3–4 large, 5+ wing. */
export type ProjectRoomSize = "standard" | "large" | "wing";

/** A project room's place on the bay grid (stable across updates). */
export interface ProjectSlot {
  index: number; // stable allocation ordinal (accent colour, room number)
  side: RoomSide;
  bay: number; // first bay along the hall
  span: number; // bays occupied (entry bay + pod bays)
}

/** A pod's identity for the sync diff: changes iff the pod moves. */
export interface RoomSlot {
  index: number; // unique while the pod stays put
  side: RoomSide;
  bay: number; // bay of the pod along the hall
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

export interface Panel {
  position: Vec3;
  yaw: number;
  width: number;
  height: number;
}

/**
 * One SESSION's pod inside its project room (characters, monitors and the
 * walking graph use it like a room). Pod frame: origin on the room's
 * circulation spine at the pod centre; local +Z points into the room (away
 * from the glass), local X runs along the hall.
 */
export interface RoomLayout {
  sessionId: string;
  projectId: string;
  podIndex: number;
  slot: RoomSlot;
  /** Pod origin on the circulation spine (world space, floor level). */
  origin: Vec3;
  /** Pod frame yaw (see above). */
  yaw: number;
  size: { w: number; d: number; h: number };
  /** The project room's door (shared by its pods). */
  door: Vec3;
  doorOutside: Vec3;
  doorInside: Vec3; // on the circulation spine
  bossDesk: DeskSlot;
  desks: DeskSlot[]; // exactly 8, index == backend agent.desk - 1 (desk is 1-based)
  /** Mobile whiteboard (session todos). */
  whiteboard: Panel;
  /** Pod nameplate monitor at the head of the bench, facing the spine. */
  sign: Panel;
  /** Pod footprint (bay × room depth). */
  bounds: { min: Vec3; max: Vec3 };
}

export interface ProjectRoomLayout {
  projectId: string;
  name: string;
  slot: ProjectSlot;
  sizeClass: ProjectRoomSize;
  /** Pod bays (span - 1). */
  capacity: number;
  /** Room centre at floor level. */
  origin: Vec3;
  /** Local frame yaw: local -X faces the hall (door wall), Z along the hall. */
  yaw: number;
  size: { w: number; d: number; h: number }; // w along the hall, d across
  door: Vec3;
  doorOutside: Vec3;
  doorInside: Vec3;
  /** Entry bay centre (door, lounge corner, coffee point). */
  entry: { center: Vec3; yaw: number };
  /** Every pod bay of the room in order (yaw = pod frame yaw). */
  podBays: { center: Vec3; yaw: number; occupied: boolean }[];
  pods: RoomLayout[];
  /** Acoustic dividers between pod bays (centre, yaw of the panel's long axis frame). */
  dividers: { position: Vec3; yaw: number }[];
  /** LED panel over the door (hall side): project + aggregate status. */
  led: Panel;
  /** Wall-mounted info screen beside the door (hall side): one row per session. */
  infoScreen: Panel;
  /**
   * The far wall, glazed onto the outside (city today, factory floor later)
   * when `overlook` is on; null when the far wall is solid.
   */
  overlook: { origin: Vec3; dir: Vec3; length: number; height: number } | null;
  feedCamera: { position: Vec3; target: Vec3 };
  bounds: { min: Vec3; max: Vec3 };

  // ---- Factory exposure (pure data; the factory is generated from these) ----
  /** Room slab extents: x0 = glass-front line (s·3.5), x1 = outer glazing line (s·13.1). */
  footprint: { x0: number; x1: number; z0: number; z1: number };
  /** Outer glazing wall (the overlook side); yaw = its outward normal. */
  outer: { x: number; yaw: number; z0: number; z1: number };
  /** Balcony strip 1.2 m outside the outer glazing (x0 at the glazing); door at the entry bay. */
  balcony: {
    x0: number;
    x1: number;
    z0: number;
    z1: number;
    door: Vec3;
    doorYaw: number;
  };
  /** Structural glass strip 1.0 m inside the outer glazing (x1 at the glazing). */
  glassFloor: { x0: number; x1: number; z0: number; z1: number };
  /** Column positions (y = 0) on the bay grid at the glass-front and outer lines (incl. slab corners). */
  columns: Vec3[];
  /** Bay index of the entry bay (== slot.bay) and the room's span in bays. */
  entryBay: number;
  span: number;
}

/** Macro-layout knobs (all optional; defaults = rooms on both sides). */
export interface LayoutOptions {
  /** Hall sides that carry project rooms. */
  sides?: readonly RoomSide[];
  /**
   * Glaze one whole side of the hall as an overlook (no rooms on that side).
   * Implies `sides` = the other side.
   */
  hallOverlook?: RoomSide | null;
  /** Glaze the far wall of every project room (default true). */
  roomOverlook?: boolean;
  /**
   * Per-project size demand in session-equivalents, e.g.
   * max(sessions, ceil(activePRs / 2)). Honoured up to the `wing` size
   * (6 pods); live sessions always get a pod.
   */
  spanFor?: (projectId: string, sessions: number) => number;
}

export interface BuildingLayout {
  lobby: { origin: Vec3; size: Vec3; spawn: Vec3; spawnYaw: number };
  hall: {
    origin: Vec3; // hall start centre at floor
    length: number;
    width: number;
    /** Side of the hall glazed as an overlook (no rooms there), if any. */
    overlook: RoomSide | null;
  };
  controlRoom: {
    /** Footprint centre (floor). The round ops room lives inside. */
    origin: Vec3;
    /** Footprint (x = width ≥ CONTROL_MIN_W, y = clear height, z = depth). */
    size: Vec3;
    /** Door centre on the hall axis, in the hall-side wall (z = hall end). */
    door: Vec3;
    doorWidth: number;
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
  projects: ProjectRoomLayout[];
  /** Every session pod (flattened from `projects`). */
  rooms: RoomLayout[];
  bays: number; // bays per side (>= MIN_BAYS)
  sides: readonly RoomSide[];
  /** Free bay runs (no project) on room sides, rendered as plain wall. */
  emptySlots: ProjectSlot[];
  bounds: { min: Vec3; max: Vec3 };
}

export type Zone =
  | { kind: "lobby" }
  | { kind: "hall" }
  | { kind: "control" }
  /** Inside a project room; `sessionId` = the pod under the player (or the room's first pod). */
  | { kind: "room"; sessionId: string; projectId?: string }
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

export const CHECK_COLORS = {
  ...STATUS_COLORS,
  failure: "#ef4444",
  merged: "#a855f7",
} as const;

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
  /** Building-wide stats for the control room (CampusState.stats). */
  stats?: CampusStats | null;
  /** Projects (one team room each); grouped client-side when absent. */
  projects?: CampusProject[] | null;
}

// ============================================================================
// INTERACTION (engine/interaction/*)
// ============================================================================

export type InteractionKind =
  | "monitor"
  | "whiteboard"
  | "screen"
  | "character"
  | "door"
  /** Control-room ops wall / console (opens the Ops dashboard; sessionId may be ""). */
  | "ops"
  /** Software-factory targets (engine/interaction/factoryTargets.ts); sessionId is "" unless linked. */
  | "lanePlate"
  | "station"
  | "workpiece"
  | "lineBoard"
  | "dock"
  | "trunk"
  | "mainLine"
  /** Entrance glass lift door (call + ride); `stop` = the floor it is on. */
  | "lift";

export interface InteractionTarget {
  kind: InteractionKind;
  sessionId: string;
  agentId?: string; // "boss" for the main agent
  roomLabel: string;
  /** Factory targets: project (CampusProject.id) the target belongs to. */
  projectId?: string;
  prNumber?: number;
  /** Station: check name (or first name of a grouped "+N" station). */
  checkName?: string;
  /** 0-based lane. */
  lane?: number;
  /** GitHub URL (PR / run / release) for "Open on GitHub". */
  url?: string;
  /** Lift: the stop this door is on (0 = ground, 1 = reception). */
  stop?: number;
}

/** Read-only today; write actions (answer_permission, send_message) are added here later. */
export type InteractionActionId =
  | "inspect"
  | "enter"
  | "popup"
  | "github"
  /** Ride the entrance lift to the other floor. */
  | "ride";

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

export type TeleportTarget =
  | { sessionId: string }
  | { projectId: string }
  | "lobby"
  | "control"
  | "floor"
  | { factoryCell: string }
  | { factoryDock: true };

export interface PlayerPose {
  x: number;
  z: number;
  yaw: number;
  /** y-aware: office zones, or factory-level zones (factory / cell / dock / stair / balcony). */
  zone: Zone | FactoryZone;
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
  stats: {
    fps: number;
    frameMs: number;
    tier: QualityTier;
    drawCalls: number;
    /** Concrete preset in effect (the governor's tier under "auto"). */
    effective?: "low" | "medium" | "high" | "ultra";
    /** Active camera post-processes. */
    postProcesses?: number;
  };
  pointerLock: boolean;
  cameraMode: CameraMode;
  /** Free-fly / noclip camera on or off. */
  fly: boolean;
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

/** Customisable lobby neon sign. */
export interface BrandingOptions {
  name: string;
  tagline: string;
  /** PNG/WebP/JPG/SVG data URL, or null for the default neon star. */
  logo: string | null;
  /** "#rrggbb" neon colour. */
  color: string;
  flicker: boolean;
}

export interface IWorld {
  init(): Promise<void>;
  sync(input: SyncInput): void;
  setCameraMode(mode: CameraMode): void;
  /** Toggle the free-fly camera; leaving with `land` drops the body below the camera. */
  toggleFly(land?: boolean): void;
  setQuality(q: QualitySetting): void;
  /** Apply full graphics settings live (presets / custom). */
  setGraphics(settings: GraphicsSettings): void;
  /** Lobby brand sign (name, tagline, logo, neon colour, flicker); live. */
  setBranding?(opts: BrandingOptions): void;
  /** Disable game input (HUD panel open) — releases pointer lock. */
  setInputEnabled(enabled: boolean): void;
  /**
   * Teleport the player (minimap fast travel): a project room's door,
   * "lobby" / "control", the factory floor ("floor" = inside the factory door),
   * a production cell (its stair landing) or the dock.
   */
  teleport(to: TeleportTarget): void;
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
