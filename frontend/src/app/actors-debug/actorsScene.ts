/**
 * Standalone Babylon scene for /actors-debug (characters + in-world screens).
 */

import {
  ArcRotateCamera,
  Color3,
  Color4,
  CreateBox,
  CreateGround,
  DirectionalLight,
  Engine,
  HDRCubeTexture,
  HemisphericLight,
  Mesh,
  PBRMaterial,
  Scene,
  ShadowGenerator,
  Vector3,
  type AbstractMesh,
} from "@/engine/babylon";
import type { CharacterPose, RoomLayout } from "@/engine/contracts";
import { allocateSlots, generateLayout } from "@/engine/layout/buildingLayout";
import { MannequinRig } from "@/engine/characters/MannequinRig";
import {
  GltfRig,
  preloadCharacterPack,
  tryCreateGltfRig,
} from "@/engine/characters/GltfRig";
import type { CharacterRig } from "@/engine/characters/types";
import { CharacterActor } from "@/engine/characters/CharacterActor";
import { LabelLayer } from "@/engine/screens/LabelLayer";
import type { Lod } from "@/engine/characters/types";
import { AgentMonitor, BossMonitor } from "@/engine/screens/Monitor";
import { WhiteboardScreen } from "@/engine/screens/Whiteboard";
import { FeedScheduler } from "@/engine/screens/FeedScheduler";
import { ControlRoomWall } from "@/engine/screens/ControlRoomWall";
import { buildMonitorLines, agentScreenText } from "@/engine/logic/monitorText";
import { createDemoCampus } from "@/engine/demo/demoCampus";
import type { BuildingLayout } from "@/engine/contracts";
import type { Agent, AgentState } from "@/types";

const POSES: CharacterPose[] = [
  "idle",
  "walking",
  "sitting",
  "typing",
  "thinking",
  "raiseHand",
  "celebrating",
];
const PALETTE = [
  "#3B82F6",
  "#22C55E",
  "#A855F7",
  "#F97316",
  "#EC4899",
  "#14B8A6",
  "#EAB308",
  "#EF4444",
];

interface CamPreset {
  alpha: number;
  beta: number;
  radius: number;
  target: [number, number, number];
}

export function startActorsScene(
  canvas: HTMLCanvasElement,
  params: URLSearchParams,
): () => void {
  const engine = new Engine(
    canvas,
    true,
    { preserveDrawingBuffer: true, stencil: true },
    true,
  );
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.06, 0.08, 1);
  scene.ambientColor = new Color3(0.2, 0.2, 0.25);

  const forcedPose = params.get("pose") as CharacterPose | null;
  const freezeT = params.has("t") ? Number(params.get("t")) : null;
  const shot = params.get("shot") === "1";
  const realistic = params.get("rig") === "gltf";
  if (realistic) void preloadCharacterPack(scene);

  // --- Room layout (one east room) -----------------------------------------
  const layout = generateLayout(
    allocateSlots(new Map(), [{ id: "demo-0", createdAt: 0 }]),
  );
  const room: RoomLayout = layout.rooms[0];

  // --- Camera -----------------------------------------------------------------
  const presets: Record<string, CamPreset> = {
    overview: {
      alpha: -Math.PI / 2.6,
      beta: 1.05,
      radius: 16,
      target: [3, 0.8, 1],
    },
    row: {
      alpha: Math.PI / 2,
      beta: 1.32,
      radius: 6.2,
      target: [0.6, 0.9, -4],
    },
    face: {
      alpha: Math.PI / 2 - 0.25,
      beta: 1.45,
      radius: 2.0,
      target: [-1.2, 1.1, -4],
    },
    seated: {
      alpha: Math.PI / 2 - 0.5,
      beta: 1.25,
      radius: 3.6,
      target: [2.4, 0.8, -4],
    },
    room: {
      alpha: Math.PI,
      beta: 1.0,
      radius: 7.5,
      target: [room.origin.x + 0.6, 0.6, room.origin.z],
    },
    boss: { alpha: Math.PI, beta: 1.45, radius: 1.3, target: [0, 0, 0] },
    agent: { alpha: Math.PI, beta: 1.4, radius: 0.9, target: [0, 0, 0] },
    board: { alpha: -Math.PI / 2, beta: 1.5, radius: 2.6, target: [0, 0, 0] },
    wall: { alpha: 0, beta: 1.5, radius: 3.4, target: [-8, 1.9, 2] },
    side: {
      alpha: Math.PI + 0.12,
      beta: 1.45,
      radius: 3.6,
      target: [-3.0, 0.85, -4],
    },
    gest: {
      alpha: Math.PI / 2 - 0.35,
      beta: 1.35,
      radius: 3.4,
      target: [2.4, 1.0, -4],
    },
    badge: {
      alpha: Math.PI / 2 - 0.3,
      beta: 1.45,
      radius: 1.5,
      target: [-3.0, 1.35, -4],
    },
    typing: {
      alpha: Math.PI - 0.6,
      beta: 1.3,
      radius: 2.4,
      target: [-0.6, 0.8, -4],
    },
  };
  const facing = (
    p: { x: number; y: number; z: number },
    yaw: number,
    radius: number,
    beta = 1.5,
  ): CamPreset => ({
    alpha: Math.PI / 2 - yaw,
    beta,
    radius,
    target: [p.x, p.y, p.z],
  });
  // Showcase desk (screen close-ups) at z = 10, screens facing -Z.
  const SHOW = {
    boss: { x: -0.42, y: 1.0, z: 10.1 },
    agent: { x: 0.5, y: 0.97, z: 10.1 },
  };
  presets.boss = facing(SHOW.boss, Math.PI, 0.95, 1.5);
  presets.agent = facing(SHOW.agent, Math.PI, 0.7, 1.45);
  presets.screens = facing({ x: 0.05, y: 1.0, z: 10.1 }, Math.PI, 1.9, 1.38);
  presets.desk = facing(
    room.desks[1].monitor.position,
    room.desks[1].monitor.yaw + 0.5,
    2.2,
    1.2,
  );
  presets.board = facing(
    room.whiteboard.position,
    room.whiteboard.yaw,
    2.7,
    1.52,
  );
  presets.wall = facing({ x: -8, y: 1.9, z: 2 }, Math.PI / 2, 3.6, 1.52);
  const presetName = params.get("cam") ?? "overview";
  const preset = presets[presetName] ?? presets.overview;
  const camera = new ArcRotateCamera(
    "cam",
    preset.alpha,
    preset.beta,
    preset.radius,
    new Vector3(...preset.target),
    scene,
  );
  camera.minZ = 0.05;
  camera.wheelPrecision = 60;
  camera.attachControl(canvas, true);

  // --- Lighting ---------------------------------------------------------------
  const hemi = new HemisphericLight("hemi", new Vector3(0.2, 1, -0.3), scene);
  hemi.intensity = 0.55;
  hemi.groundColor = new Color3(0.22, 0.2, 0.2);
  const sun = new DirectionalLight("sun", new Vector3(-0.45, -1, 0.35), scene);
  sun.position = new Vector3(10, 18, -10);
  sun.intensity = 2.2;
  const shadows = new ShadowGenerator(2048, sun);
  shadows.useBlurExponentialShadowMap = true;
  shadows.blurKernel = 16;
  shadows.depthScale = 60;
  const hdr = new HDRCubeTexture(
    "/assets/hdri/blender_institute_1k.hdr",
    scene,
    128,
    false,
    true,
    false,
    true,
  );
  scene.environmentTexture = hdr;
  scene.environmentIntensity = 0.8;
  scene.imageProcessingConfiguration.toneMappingEnabled = true;
  scene.imageProcessingConfiguration.toneMappingType = 1; // ACES
  scene.imageProcessingConfiguration.exposure = 1.1;

  const addCaster = (m: AbstractMesh) => shadows.addShadowCaster(m, false);

  // --- Floor + simple furniture -------------------------------------------------
  const ground = CreateGround("ground", { width: 40, height: 40 }, scene);
  const gMat = new PBRMaterial("groundMat", scene);
  gMat.albedoColor = new Color3(0.32, 0.33, 0.36);
  gMat.metallic = 0;
  gMat.roughness = 0.85;
  ground.material = gMat;
  ground.receiveShadows = true;

  const wood = new PBRMaterial("wood", scene);
  wood.albedoColor = new Color3(0.42, 0.28, 0.17);
  wood.metallic = 0;
  wood.roughness = 0.55;
  const chairMat = new PBRMaterial("chair", scene);
  chairMat.albedoColor = new Color3(0.08, 0.08, 0.09);
  chairMat.metallic = 0;
  chairMat.roughness = 0.6;

  const furniture: Mesh[] = [];
  const addChair = (x: number, z: number, yaw: number) => {
    const seat = CreateBox(
      "seat",
      { width: 0.5, height: 0.08, depth: 0.48 },
      scene,
    );
    seat.position.set(0, 0.43, 0);
    const back = CreateBox(
      "back",
      { width: 0.48, height: 0.55, depth: 0.06 },
      scene,
    );
    back.position.set(0, 0.78, -0.26);
    const post = CreateBox(
      "post",
      { width: 0.06, height: 0.4, depth: 0.06 },
      scene,
    );
    post.position.set(0, 0.2, 0);
    const chair = Mesh.MergeMeshes([seat, back, post], true) as Mesh;
    chair.material = chairMat;
    chair.position.set(x, 0, z);
    chair.rotation.y = yaw;
    chair.receiveShadows = true;
    addCaster(chair);
    furniture.push(chair);
  };
  const addDesk = (x: number, z: number, yaw: number, w = 1.4) => {
    const top = CreateBox(
      "deskTop",
      { width: w, height: 0.04, depth: 0.7 },
      scene,
    );
    top.position.set(0, 0.74, 0);
    const l1 = CreateBox(
      "leg",
      { width: 0.05, height: 0.72, depth: 0.6 },
      scene,
    );
    l1.position.set(-w / 2 + 0.05, 0.36, 0);
    const l2 = l1.clone("leg2");
    l2.position.x = w / 2 - 0.05;
    const desk = Mesh.MergeMeshes([top, l1, l2], true) as Mesh;
    desk.material = wood;
    desk.position.set(x, 0, z);
    desk.rotation.y = yaw;
    desk.receiveShadows = true;
    addCaster(desk);
    furniture.push(desk);
  };

  // --- Pose row ---------------------------------------------------------------
  const rigs: CharacterRig[] = [];
  const rowPoses: CharacterPose[] = [...POSES, "typing"];
  rowPoses.forEach((pose, i) => {
    const boss = i === rowPoses.length - 1;
    const ropts = { id: `row-${i}`, boss, color: PALETTE[i % PALETTE.length] };
    const rig =
      tryCreateGltfRig(scene, ropts) ?? new MannequinRig(scene, ropts);
    if (rig instanceof GltfRig)
      rig.meshesChanged = (ms) => ms.forEach(addCaster);
    const x = -4.2 + i * 1.2;
    rig.root.position.set(x, 0, -4);
    const p = forcedPose ?? pose;
    rig.setPose(p, 0);
    if (p === "walking") rig.setMoving(1.35);
    if (p !== "idle" && p !== "walking") addChair(x, -4, 0);
    for (const m of rig.getMeshes()) addCaster(m);
    rigs.push(rig);
  });

  // --- Room with actors ---------------------------------------------------------
  const labels = new LabelLayer(scene);
  addDesk(
    room.bossDesk.position.x,
    room.bossDesk.position.z,
    room.bossDesk.yaw,
    1.8,
  );
  addChair(room.bossDesk.seat.x, room.bossDesk.seat.z, room.bossDesk.yaw);
  for (const d of room.desks) {
    addDesk(d.position.x, d.position.z, d.yaw);
    addChair(d.seat.x, d.seat.z, d.yaw);
  }
  const actx = { scene, room, addShadowCaster: addCaster, labels };
  const boss = new CharacterActor(
    { ...actx, deskIndex: null },
    {
      id: "boss",
      kind: "boss",
      color: "#D97757",
      name: "Claude",
      sessionId: "demo-0",
      roomLabel: "claude-office",
    },
  );
  boss.spawn("seat");
  boss.setBoss({
    state: "working",
    currentTask: "Refactor",
    bubble: { type: "thought", text: "Let me plan the refactor…" },
  });

  const agentStates: AgentState[] = [
    "working",
    "thinking",
    "waiting_permission",
    "working",
    "completed",
  ];
  const actors: CharacterActor[] = [boss];
  const mkAgent = (i: number, state: AgentState): Agent => ({
    id: `a${i}`,
    name: ["Explorer", "Planner", "Coder", "Reviewer", "Tester", "Scout"][
      i % 6
    ],
    color: PALETTE[i % PALETTE.length],
    number: i + 1,
    state,
    desk: i + 1,
    bubble:
      state === "waiting_permission"
        ? {
            type: "speech",
            text: "Allow Bash: npm test?",
            persistent: true,
            icon: null,
          }
        : i === 0
          ? {
              type: "speech",
              text: "Found 3 call sites",
              icon: "file-text",
              persistent: true,
            }
          : null,
  });
  agentStates.forEach((state, i) => {
    const a = new CharacterActor(
      { ...actx, deskIndex: i },
      {
        id: `a${i}`,
        kind: "agent",
        color: PALETTE[i % PALETTE.length],
        name: mkAgent(i, state).name as string,
        sessionId: "demo-0",
        roomLabel: "claude-office",
      },
    );
    a.spawn("seat");
    a.setAgent(mkAgent(i, state));
    actors.push(a);
  });
  // A walker that loops: door → desk → boss → desk → leaves → respawns.
  let walker: CharacterActor | null = null;
  let walkerCycle = 0;
  const spawnWalker = () => {
    const i = 6;
    walker = new CharacterActor(
      { ...actx, deskIndex: i },
      {
        id: `w${walkerCycle}`,
        kind: "agent",
        color: PALETTE[i],
        name: "Courier",
        sessionId: "demo-0",
        roomLabel: "claude-office",
      },
    );
    walker.spawn("door");
    walker.setAgent({
      ...mkAgent(i, "walking_to_desk"),
      id: `w${walkerCycle}`,
      name: "Courier",
    });
    actors.push(walker);
  };
  spawnWalker();
  let walkerT = 0;

  // --- Screens --------------------------------------------------------------------
  const demo = createDemoCampus(3, 61_000);
  const session = demo.campus[0];
  const bossMon = new BossMonitor(scene, {
    position: room.bossDesk.monitor.position,
    yaw: room.bossDesk.monitor.yaw,
    width: 0.66,
    height: 0.37,
    sessionId: "demo-0",
    roomLabel: "claude-office",
  });
  bossMon.setLines(buildMonitorLines(session, "claude-office", 61_000));
  addDesk(0.05, 10.3, Math.PI, 2.2);
  const showBoss = new BossMonitor(scene, {
    position: SHOW.boss,
    yaw: Math.PI,
    width: 0.66,
    height: 0.37,
    sessionId: "show",
    roomLabel: "claude-office",
  });
  showBoss.setLines(buildMonitorLines(demo.campus[1], "payments-api", 61_000));
  const showAgent = new AgentMonitor(scene, {
    position: SHOW.agent,
    yaw: Math.PI,
    width: 0.5,
    height: 0.28,
    sessionId: "show",
    roomLabel: "claude-office",
  });
  showAgent.setText(
    agentScreenText(mkAgent(2, "working"))
      .concat(["Refactor reconnect backoff"])
      .slice(0, 4),
    PALETTE[2],
  );
  const agentMons = room.desks.map((d, i) => {
    const m = new AgentMonitor(scene, {
      position: d.monitor.position,
      yaw: d.monitor.yaw,
      width: 0.5,
      height: 0.28,
      sessionId: "demo-0",
      roomLabel: "claude-office",
    });
    if (i < agentStates.length)
      m.setText(
        agentScreenText(mkAgent(i, agentStates[i])).concat(),
        PALETTE[i % PALETTE.length],
      );
    else m.setActive(false);
    return m;
  });
  const board = new WhiteboardScreen(scene, {
    position: room.whiteboard.position,
    yaw: room.whiteboard.yaw,
    width: room.whiteboard.width,
    height: room.whiteboard.height,
    sessionId: "demo-0",
    roomLabel: "claude-office",
  });
  board.setTodos([
    { content: "Map the websocket reconnect flow", status: "completed" },
    { content: "Add jittered backoff", status: "completed" },
    {
      content: "Write reconnect tests",
      status: "in_progress",
      active_form: "Writing reconnect tests",
    },
    { content: "Handle 4013 close code", status: "pending" },
    { content: "Update the architecture doc", status: "pending" },
    { content: "Release notes", status: "pending" },
  ]);
  for (const m of [
    ...bossMon.getMeshes(),
    ...board.getMeshes(),
    ...agentMons.flatMap((a) => a.getMeshes()),
  ]) {
    m.receiveShadows = true;
  }

  // --- Control room wall fed by RTTs of this scene -----------------------------
  const feeds = new FeedScheduler(scene);
  const wallMeshes = new Set<AbstractMesh>();
  const renderList = () =>
    scene.meshes.filter(
      (m) => !wallMeshes.has(m) && m.isEnabled() && m.isVisible,
    );
  feeds.addFeed("demo-0", room.feedCamera, renderList);
  feeds.addFeed(
    "demo-1",
    { position: { x: 2.5, y: 2.4, z: -1.2 }, target: { x: 0, y: 0.8, z: -4 } },
    renderList,
  );
  feeds.addFeed(
    "demo-2",
    {
      position: {
        x: room.bossDesk.position.x + 0.3,
        y: 2.6,
        z: room.origin.z + 3.5,
      },
      target: { x: room.origin.x - 1, y: 0.6, z: room.origin.z },
    },
    renderList,
  );
  const control = {
    origin: { x: -8, y: 0, z: 2 },
    size: { x: 4, y: 3, z: 4 },
    door: { x: -8, y: 0, z: 0 },
    spawn: { x: -6, y: 0, z: 2 },
    screenWall: {
      origin: { x: -8, y: 1.9, z: 2 },
      yaw: Math.PI / 2,
      cols: 2,
      rows: 2,
      cellW: 1.6,
      cellH: 0.92,
    },
  } satisfies BuildingLayout["controlRoom"];
  const wall = new ControlRoomWall(scene, control, feeds);
  wall.setSessions([
    { sessionId: "demo-0", label: "claude-office", status: "working" },
    { sessionId: "demo-1", label: "payments-api", status: "needs_you" },
    { sessionId: "demo-2", label: "docs-site", status: "done" },
  ]);
  for (const m of scene.meshes)
    if (m.name.startsWith("wall") || m.name.startsWith("controlWall"))
      wallMeshes.add(m);
  feeds.setActive(true);
  scene.onBeforeRenderObservable.add(() => feeds.update());

  // --- Loop ---------------------------------------------------------------------
  let frames = 0;
  let frozenApplied = false;
  const tick = () => {
    let dt = Math.min(0.05, engine.getDeltaTime() / 1000);
    if (freezeT !== null) {
      if (!frozenApplied) {
        // Advance to t in small sub-steps (actors clamp large dt), then hold.
        frozenApplied = true;
        const steps = Math.ceil(freezeT / 0.05);
        for (let k = 0; k < steps; k++) step(freezeT / steps);
      }
      dt = 0;
    }
    step(dt);
  };
  const step = (dt: number) => {
    const lod: Lod = "near";
    for (const r of rigs) r.update(dt, lod);
    walkerT += dt;
    const w = walker as CharacterActor | null;
    if (w) {
      if (walkerT > 9 && walkerT - dt <= 9)
        w.setAgent({
          ...mkAgent(6, "reporting"),
          id: `w${walkerCycle}`,
          name: "Courier",
        });
      if (walkerT > 19 && walkerT - dt <= 19)
        w.setAgent({
          ...mkAgent(6, "working"),
          id: `w${walkerCycle}`,
          name: "Courier",
        });
      if (walkerT > 24 && walkerT - dt <= 24) {
        w.depart(() => {
          actors.splice(actors.indexOf(w), 1);
          w.dispose();
          walkerCycle++;
          walkerT = 0;
          spawnWalker();
        });
      }
    }
    for (const a of [...actors]) a.update(dt, lod);
  };
  scene.onBeforeRenderObservable.add(tick);

  // Re-target the screen presets once screens exist (see below).
  void scene.whenReadyAsync().then(() => {
    engine.runRenderLoop(() => {
      scene.render();
      frames++;
      if (shot && frames === 40) document.title = "READY";
    });
  });

  const onResize = () => engine.resize();
  window.addEventListener("resize", onResize);
  return () => {
    window.removeEventListener("resize", onResize);
    for (const a of actors) a.dispose();
    bossMon.dispose();
    showBoss.dispose();
    showAgent.dispose();
    for (const m of agentMons) m.dispose();
    board.dispose();
    wall.dispose();
    feeds.dispose();
    labels.dispose();
    engine.dispose();
  };
}
