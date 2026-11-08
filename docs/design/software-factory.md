# Claude Office → "The Software Factory": revised design + implementation plan (v2)

## 0. Framing (what changed since v1)

User decisions folded in: robots + one technician per project cell; GitHub v1 = PRs, checks, runs, releases; branding on dock doors and trucks; **no forced symmetry, offices on both sides, offices sit above the production lines, multiple parallel lanes per project**.

Grounded in the current tree: Phase 0 is done (`frontend/src/engine/contracts.ts` CI types incl. `CheckKind`, `PrLabel`, `ReleaseInfo`; `frontend/src/engine/logic/factoryModel.ts` with 45 tests, stations sorted by kind then name; `backend/app/core/ci_poller.py` + `models/ci.py` in progress). The rooms agent's layout is now a **bay grid along the hall**: `LAYOUT.ROOM_W = 4.8` m per pod bay, `ROOM_D = 9.6` m room depth from the glass line, `HALL_W = 7`, `MIN_BAYS = 4`, rooms on both sides (`LayoutOptions.sides`), a room = 1 entry bay + N pod bays (`standard` 2, `large` 4, `wing` ≥ 6), `ProjectRoomLayout { projectId, slot: {index, side, bay}, sizeClass, capacity, … }`, `BuildingLayout.projects[]` + `emptySlots: ProjectSlot[]`. This fits the "offices above their cell" direction directly: **a project's cell on the factory floor is the room's footprint extended outward to the outer wall**, and the building grows along the spine exactly as the rooms do.

---

## 1. Concept & spatial design (revised)

**The building is a modern software plant with an elevated office spine.** The hall is a bridge at y = 0 running the length of the factory; project team rooms hang off both sides of it as glazed office boxes on steel columns, each standing directly above its own **production cell** on the floor at y = −6. The lobby is at the south end (street level entrance + stairs down), the control room is a glazed tower at the north end over the dock.

**Decisions (and why):**
- **Spine + rooms on both sides, cells under rooms.** Zero conflict with the rooms agent (both sides, bay grid); the cell footprint is derived from the room footprint, so the factory grows with the offices and nothing is symmetric by force (a `wing` on the east can face a `standard` on the west; an empty slot is an empty, daylit floor patch).
- **Lanes run INWARD, toward the spine.** Intake at the outer wall, inspection stations progressing inward, QA desk and merge gate under the room's outer edge, the project trunk under the room, feeding the **main line that runs directly under the spine** to the dock. Why: the business end (QA/merge/trunk) is right below the room's outer glazing and balcony; the spine's glass floor strip looks down on the main line (merges riding to the dock); the control tower sees every cell plus the main line arriving. The under-room shade falls on the gate/trunk zone, which is machine-lit anyway.
- **Offices at y = 0, floor at y = −6.** No churn in existing layout, lighting or spawn code; room slabs and columns are what you see from below.

**Scale (metres, X across the spine, Z along it, side sign s = ±1):**
- Spine (hall) x ∈ [−3.5, 3.5], y 0, with a 1.6 m **structural glass strip** down the centre; main line below it at x 0, y −6; floor aisles either side.
- Room: x from s·3.5 (glass front) to s·13.1 (outer glazing), z = its bays. **Balcony** 1.2 m outside the outer glazing (x to s·14.3) with a glass balustrade; a **glass floor strip** 1.0 m wide just inside the outer glazing.
- Cell: same z extents as the room (span × 4.8), x from s·3.5 to s·34 (outer wall). Lane pitch 2.4 m, **2 lanes per pod bay**, lane centres at bay z0 + 1.2 and z0 + 3.6, so lanes thread between columns on the bay grid. Visible lane cap `min(6, 2 × podBays)`: standard 4, large 6, wing 6; overflow queues at the intake.
- Along a lane (|x|): intake rack + local bench 30.5–33; rework bay 29; stations at 28, 25.5, 23, 20.5, 18, 15.5 (≤ 6, 2.5 m pitch, under skylights); QA desk 13.5 (under the balcony edge); merge gate 11 (under the room); project trunk along z at x = s·8.5 (under the room), feeder to the main line at the cell's entry bay.
- The cell's **entry bay** (the room's lobby-end bay, no lanes) carries: the per-cell stair (balcony → floor, two flights along the outer glazing line), the holding rack, the scrap bin, the trunk feeder, the technician's station.
- Factory envelope: 75 m across, length = lobby 12 + hall + control 10 + dock 14. Floor y −6, roof y +9 (sawtooth north-light with skylights over the outer 20 m of each cell; the inner 10 m is under the rooms).
- Control tower at z ≥ L: existing control room plan at y 0, plus a glazed bay cantilevered 4 m south over the main line; dock below/behind it at z L+10 → L+24 at y −6 with roller doors on the north wall.

```
 x: -34      -14.3 -13.1        -3.5  0  3.5         13.1 14.3        34
     ┌─────────────────────────────────────────────────────────────────┐ z = L+24
     │                 D O C K  (y -6): packaging ▣ shelves ▤ doors ▭▭ │  trucks →
     ├────────────────────────┬─────────┬──────────────────────────────┤ z = L+10
     │        CONTROL TOWER (y 0, glazed bay over the main line) ▓▓▓▓  │
     ├────────────────────────┴────┬────┴──────────────────────────────┤ z = L
     │ cell W2 (empty slot:       ║glass║  ROOM E2 (wing, 6 lanes)      │
     │ daylit RESERVED floor)     ║strip║  balcony │ 6 lanes ▸▸▸ intake │
     ├─────────────────────────   ║  ▲  ║  ─────────────────────────────┤
     │ intake ◂◂◂ 4 lanes │balcony  main  ROOM E1 (standard, 4 lanes)   │
     │   ROOM W1 (large, 6 lanes) ║ line║  QA·gate under room ──trunk──┤
     │ stations ◂ QA · gate ·trunk║  ▲  ║  stair ↓ at entry bay         │
     ├────────────────────────────╫─────╫───────────────────────────────┤ z = 0
     │              L O B B Y  (y 0)  ▓ stairs ↓ + goods lift           │
     └─────────────────────────────────────────────────────────────────┘ z = -12
        ║ = spine bridge (y 0) with glass floor strip over the main line (y -6)
```

**Sight lines.**
- *From a room:* through the outer glazing (x = s·13.1) you look outward and down at the stations receding to the intake at the outer wall (eye y 1.65, intake 18 m out and 7.6 m down ≈ 23° — comfortably in view); through the glass floor strip and from the balcony you look straight down on the QA desk, merge gate and the lane ends (the "where is it at" zone); the session lead's desk (`POD.bossZ ≈ 7.65`, near the outer wall) faces the glazing, so the lead "oversees the line".
- *From the spine:* the glass strip shows the main line below; the cells are only glimpsed through two glass planes, so they are impostor-level there (culling, §6).
- *From the control tower bay:* the whole floor plus the main line arriving at the dock; the ops wall remains on the north wall.
- *From the floor looking up:* room undersides (0.4 m slab, cable trays, ducts, linear LEDs), columns, lit room fronts through the glass; the rooms are `impostor` from below (no live screens/characters), which is right at 6+ m.

**Scaling 1 → ~10 repos.** `bays` is whatever the rooms layout produces (≥ `MIN_BAYS` 4 → hall ≥ 19.2 m); 10 projects of mixed size ≈ 60–80 m of spine. Empty slots become daylit "RESERVED" floor patches (no room above = a skylight gap, a nice rhythm). Cells beyond the current `projects[]` do not exist; nothing to cap.

**Cell size vs activity.** Rooms are sized by session count; cells inherit the width. To let busy repos (many PRs, few sessions) get a wider cell, the rooms layout should accept a per-project *span demand* `max(sessions, ceil(activePRs / 2))` (see §6 "what the rooms layout must expose"). Default: on, capped at `wing`.

---

## 2. Metaphor mapping (revised rows only; the rest of the v1 table stands)

| Software thing | Physical thing | Signals |
|---|---|---|
| Repository | One **production cell** under its project room: N parallel lanes, one header board, one project trunk | Header LED above the intake wall, facing the room: `REPO · main ● · 7 PRs · 2 running · 1 failing · 3 queued` |
| Concurrent PRs | **Parallel lanes**, one PR per lane, side by side | Lane number plate at the intake; lane belt runs while its PR's checks run; concurrency = how many lanes are lit |
| PR beyond the lane cap | Queued on the **intake rack** (stacked pallets), amber "QUEUED" stamp | Takes the next freed lane in priority order (§5 lane rules) |
| Each CI check | One inspection station **per lane** (lanes are identical copies of the cell's station row) | Beacon per station; the cell's header rolls up per check name |
| Failure | Piece reverses to the lane's **rework bay** (between intake and station 1), red beacon, lane belt stops | Re-queued checks → re-enters the same lane |
| Merge | Gate opens, piece drops onto the **project trunk** under the room, rides to the **main line under the spine**, north to the dock | Purple "MERGED" tag; visible from the spine's glass strip |
| Workflow run on main | **Main line QC gate** just before the dock | beacon rules as stations |
| Deploy / release | Packaging cell + roller door + truck (branded) | as v1 |
| Session ↔ PR | Session's pod LED shows `#412 · lane 3`; the workpiece carries the session light bar | `Enter` on either enters the session |
| Subagents / staff | Office staff stay upstairs; **one technician per cell** at the entry bay, walks to the active lane's station | robots are the inspectors |

---

## 3. Visual language (unchanged from v1, plus)

Columns: 300 mm square hollow sections, RAL 7016, on the bay grid at the glass-front line and the outer-glazing line; room undersides as painted slab with galvanised cable trays and a continuous linear LED under each room edge (fixture kind `"accent"`), so the shaded gate/trunk zone is lit from the machines and the slab edge, not from nowhere. Lane number plates and station glyphs share one atlas. Balcony balustrades are low-iron glass with a brushed-aluminium handrail (existing `aluminium`, `glass`). Colour stays on beacons, bands, tags, yellow walkway lines and the brand mark on doors/trucks.

---

## 4. Interaction (unchanged from v1, plus)

Walk-down paths: (a) lobby stairs + goods lift (teleport "floor"); (b) **spine-node stairs** every 4 bays, a 1.2 m stair cut-out along the hall edge with a balustrade, two flights to the floor; (c) **per-cell stair** from the room balcony (balcony door at the entry bay) down the outer glazing line to the cell floor; (d) control-tower stair to the dock. Minimap: level badge MEZZ/FLOOR, lanes as thin bars, fast-travel to cell intake / dock / spine node. `F` on a lane plate opens the PR panel of that lane; `F` on the header board opens the Line panel (PRs with lane numbers and the queue). Control room gains the FLOOR panel (`floorBoard` now has `lanesLit/lanes`) and line cams aimed down each cell's trunk from under the room.

---

## 5. Data & GitHub integration (v1 stands; model change for lanes)

Fetch/poll/caching/offline exactly as v1 (gh CLI, adaptive 20/60/180 s, last-good + `stale`, pinned repos, local git intake/bench). The backend contract is already landed; one addition: `CampusProject.activePrs?: number` is unnecessary (derivable), nothing else needed server-side for lanes.

**`factoryModel.ts` lane extension (specification):**
- Types: `Workpiece.lane: number | null` (0-based; `null` = not on a lane: rack/queued/holding/scrap/trunk); `LineModel.lanes: number` (capacity), `LineModel.queued: number`, `LineModel.laneBusy: boolean[]` (belt running per lane), `FloorRow.lanesLit`, `FloorRow.lanes`.
- Signature: `buildFactoryModel(projects, sessions, nowMs, opts?: { lanesFor?: (projectId: string) => number; prev?: FactoryModel })`, default `lanesFor = () => MAX_LANES (6)`. The World passes `lanesFor` from `FactoryLayout` and its previous model.
- Eligibility: segments `belt | station | qa | gate | rework` need a lane; `rack | holding | scrap | trunk` never do. Drafts stay on the rack (no lane).
- `assignLanes(pieces, lanes, prevLanes: Map<string, number>)` (exported, pure): (1) keep the previous lane for every still-eligible piece whose lane < capacity; (2) remaining eligible pieces in priority order — running/queued checks first, then `updatedAt` desc, then PR number — take the lowest free lane; (3) the rest become `segment: "rack", stamp: "QUEUED", lane: null`. Pieces are **never evicted**; a lane frees only when its piece leaves eligibility. Without `prev`, step 2 alone is deterministic. Bot batch pallet counts as one piece.
- `factoryKey` includes `lane` and `laneBusy`; `floorBoard` adds `lanesLit`. Tests to add (≈ 12): stability across updates with `prev`, no double occupancy, overflow queue order, freed lane reuse, capacity shrink (lanes ≥ capacity go to queue, lowest first), determinism without `prev`, bots as one lane.

---

## 6. Architecture (revised)

**Pure modules:** `logic/factoryModel.ts` (lanes as above); new `layout/factoryLayout.ts` → `FactoryLayout { floorY: -6, bounds, cells: CellLayout[], mainLine: {x: 0, z0, z1, qc}, dock, spineStairs[], lobbyStair, liftSpots }` with `CellLayout { projectId, side, z0, z1, entryBay, lanes: LaneLayout[] (z, stationX[], qaX, gateX, reworkX, intakeX), trunk: {x, z0, z1, feederZ}, board, bench, holding, scrap, stair, columns: Vec3[] (floor-level) }`; `zoneAt(layout, p)` extended with y (`p.y < -1.5` → `factory | cell(projectId) | dock | stair`), `{kind:"balcony", projectId}` for the balcony. New `world/factoryVisibility.ts` (`computeCellVisibility`): from a room → own cell `full`, same-side neighbours within the outer-glazing cone `impostor`, opposite side `hidden`; from the spine → main line `full`, cells `impostor` ≤ 2 bays else `hidden`; from floor zones → cone + distance (IMPOSTOR 35 m, MAX 70 m); from the tower → cone, IMPOSTOR 35. Rooms from the floor: `impostor` when their underside/front is in the cone, else `hidden` (one extra rule in `Visibility.ts`).

**What the rooms agent's layout must expose** (additive fields on `ProjectRoomLayout`, all pure data, so the factory can be generated from it without reading room internals):
1. `footprint: { x0, x1, z0, z1 }` world extents of the room slab (x0/x1 = glass-front line s·3.5 and outer-glazing line s·13.1; z = span × 4.8 on the bay grid).
2. `outer: { x: number; yaw: number; z0; z1 }` the outer glazing wall (the cell's "overlook" side) — a `Panel`-like record.
3. `balcony: { x0, x1, z0, z1, door: Vec3, doorYaw }` 1.2 m outside the outer glazing, door at the **entry bay**; `balconyDoor` must be a real opening in the outer glazing.
4. `glassFloor: { x0, x1, z0, z1 }` the 1.0 m strip inside the outer glazing (Room.ts renders structural glass there; FactoryHall renders no slab underside under it).
5. `columns: Vec3[]` floor-level (y 0) column positions: bay-grid points on the glass-front line and the outer line, plus the slab corners (the factory extends them to y −6 and keeps lanes clear of them).
6. `entryBay: number` (bay index of the entry bay) and `span`.
7. `spanDemand` support: `generateLayout(slots, opts)` where `LayoutOptions.spanFor?: (projectId, sessions) => number` or a `demand: Map<projectId, number>` so the World can pass `max(sessions, ceil(activePRs/2))`.
8. `emptySlots` keep `{ side, bay, span }` so empty cells get their daylit floor patch.
9. Meshes: room floor slabs and the hall floor tagged `metadata.probe` (they already are via `tagStatic`) and **no underside geometry** (FactoryHall draws the slab soffit, trays and LEDs); the hall floor leaves the 1.6 m centre strip to a glass mesh with `seeThrough` collider. `Zone room` already carries `projectId`.

**Engine modules (`engine/world/factory/`):** `FactoryHall.ts` (floor, outer walls, roof trusses + skylight portals, room soffits + trays + edge LEDs, columns, spine glass strip, balconies + balustrades, stairs with hidden ramp colliders, probe `"factory"`, empty-cell stencils), `Cell.ts` (per project: header board `LedPanel`, QA desks, gates, racks, bench, technician anchor; applies `LineModel`), `Conveyors.ts` (ONE thin-instanced pool of 1 m belt / frame / guard segments for every lane, trunk and the main line — 3 draws for the whole plant, UV scroll on the shared rubber material), `Stations.ts` (pool: housing, hood, arm ×3, beacon with per-instance colour, glyph plate — 7 draws for 360 stations), `Workpieces.ts` (pool: pallet, 4 bodies, band, tag plate — 7 draws), `Dock.ts` (packaging, shelving + release boxes, roller doors with brand mark, truck with brand livery, sequences), `Technicians.ts` (≤ 1 `CharacterActor` per cell, ActorHub tiers), `FactoryCams.ts`. `World.ts` seams as v1 (build after `Building.build`, `factory.sync(model)`, `update(dt, eye, zone)`, visibility fan-out, teleports, y-aware zone).

**Exterior:** as v1 (`Skyline.ts` → `Exterior.ts` industrial park, `GROUND_Y → −6`), lobby glazing to the yard, dock doors open to the apron.

**Lighting under the rooms:** rooms shade the inner 10 m of each cell; the existing render-once sun shadow map includes the slabs, so daylight patches fall only where skylights are; under-room zones get the edge LEDs + gate hood lights as clustered fixtures; probe `"factory"` plus the existing `"hall"` probe sees the glass strip. No bake needed; vertex AO on soffits/columns is a phase-6 nicety.

**Draw-call budget (high, 10 projects, 6 lanes):** shell ≈ 18, conveyors 3, stations 7, workpieces 7, boards 10, cell furniture pool (QA desks, gates, racks, bench) 6, dock 12, truck 2, technicians ≤ 3 impostor + ≤ 4 × 3 skinned, labels 2, exterior 3 → **≈ 85–105** in the worst view (control tower). From a room the own cell + 1–2 neighbours are `full` and the hall/rooms view is the existing one, so ≤ 350 holds; from the floor the rooms above are impostor/hidden. Acceptance is measured with `/world-debug?projects=1&n=10&cam=…&shot=1` → `__worldStats.draws` (median of 5) at four fixed cameras (room glazing, spine glass strip, tower bay, floor under a room).

---

## 7. Phased implementation plan (revised; Phase 0 done)

### Implementation status (updated with the review, see `review-plan.md`)

| Phase | Item | Status |
|---|---|---|
| 0 | P0.1-P0.9 model, lanes, layout contract, demo with queue overflow | Done |
| 1 | P1.1 spine/rooms as elevated boxes, P1.2 `FactoryHall`, P1.3 `Exterior`, P1.4 visibility + minimap level layer | Done (seams and colliders under review: WS2/WS3) |
| 2 | P2.1 conveyors, P2.2 stations, P2.3 workpieces, P2.4 cell dressing/header boards, P2.5 factory sync | Done (render budget: WS4) |
| 3 | P3.1 motion logic, P3.2 arms/beacons/belts, P3.3 dock + truck + release shelves | Done (truck model: WS6) |
| 3 | P3.4 technicians | Cell plan and layout exist; no skinned technicians in the scene yet (WS6) |
| 4 | P4.1 targets/actions/i18n, P4.2 panels | Done |
| 4 | P4.3 FLOOR panel + line cams, P4.4 minimap lanes and zone names | Partial: floor teleports exist; signage and minimap levels pending (WS3/WS7) |
| 5 | P5.1 CI poller hardening, P5.4 perf gate (`make perf-gate`, `make walk-gate`) + docs | Poller done; gates added; architecture doc has a "3D World" section |
| 5 | P5.2 local-git intake/bench, P5.3 flaky/bot/stale polish, P5.5 pinned-repos UI + branding to doors/trucks | Open |
| 6 | Vertex AO / lightmaps | Not started |


Tiers: **Opus** art/engine judgement, **Sonnet** well-specified implementation, **Haiku** plumbing. "∥" = no shared files with its siblings.

### Phase 0b — Lanes + layout contract (demo: tests green; `FactoryLayout` printed in `/world-debug`)
- **P0.6 Lanes in `factoryModel.ts` (Sonnet)** — `logic/factoryModel.ts`, `tests/factoryModel.test.ts`. Spec §5. Acceptance: 45 existing + ≈ 12 lane tests pass; `factoryKey` stable when nothing visible changes.
- **P0.7 Rooms layout exposure (Sonnet, owned by the rooms agent, ∥)** — `contracts.ts` (`ProjectRoomLayout` fields 1–8 of §6), `layout/buildingLayout.ts`, `tests/worldLayout.test.ts`. Acceptance: every room exposes footprint/outer/balcony/glassFloor/columns/entryBay; `spanFor` honoured; existing tests pass.
- **P0.8 `factoryLayout.ts` + y-aware zones (Sonnet, after P0.7 types exist — can start from the spec)** — `layout/factoryLayout.ts`, `tests/factoryLayout.test.ts`, `contracts.ts` (`FactoryLayout`, new `Zone` kinds, `BuildingLayout.factory`). Acceptance: lanes never intersect columns; cells never overlap; stairs land inside walkable floor; every point maps to one zone.
- **P0.9 Demo projects with ≥ 8 concurrent PRs on one repo (Haiku, ∥)** — `demo/demoCampus.ts`, `tests/demoCampus.test.ts`, `app/world-debug/page.tsx`. Acceptance: queue overflow visible in demo.

### Phase 1 — Plant shell under the offices (demo: walk lobby → floor, look up at rooms on columns; walk a spine stair; stand on a balcony)
- **P1.1 Spine + rooms as elevated boxes (Opus, with the rooms agent)** — `world/Building.ts` (hall floor glass strip + balustrades + spine-node stair cut-outs, lobby stair opening, tower bay), `world/Room.ts` (outer glazing full height, balcony door, glass floor strip — rooms agent), `world/architecture.ts`. Acceptance: office view draw calls ± 10 of today; glass strip see-through collider.
- **P1.2 `FactoryHall.ts` (Opus)** — soffits/trays/edge LEDs under every room footprint, columns, floor, walls, trusses, skylights, balconies, stairs (+ `Colliders.addBox` pitch), probes, empty-cell stencils; `materials/Materials.ts` + `assets/materials2.ts` new surfaces; `World.ts` seam. Acceptance: all four walk-down paths work; shell ≤ 20 draws; sun patches only under skylights.
- **P1.3 Exterior swap (Sonnet, ∥)** — `Skyline.ts` → `Exterior.ts`, `fx/Lighting.ts` (`GROUND_Y`, portals). Acceptance: bake ≤ 2 s, 3 draws.
- **P1.4 Visibility (Sonnet, ∥)** — `world/factoryVisibility.ts`, `world/Visibility.ts` (floor-zone rule), `tests/visibility.test.ts`, `Minimap.tsx` level layer + fast travel. Acceptance: from the floor rooms ≤ impostor; from a room only own cell `full`.

### Phase 2 — Cells, lanes, stations, workpieces (static) (demo: 6 cells, lanes with pieces at the right stations, queue at the intake)
- **P2.1 `Conveyors.ts` pool (Opus)** — lanes, trunks, main line from `FactoryLayout`. Acceptance: 3 draws for all belts; rebuild only when the cell set changes.
- **P2.2 `Stations.ts` pool (Opus, ∥)** — Acceptance: 360 stations ≤ 8 draws; beacon colours = `CHECK_COLORS`.
- **P2.3 `Workpieces.ts` pool + tags (Sonnet, ∥)** — lane-aware placement (`lane`, `segment`, `t` → lane spline). Acceptance: 150 pieces ≤ 8 draws; tags within 10 m only.
- **P2.4 `Cell.ts` + header boards + cell furniture pool (Sonnet, after P2.1–P2.3 interfaces)** — Acceptance: ≤ 2 draws per cell beyond the pools; board text = `LineModel.header`.
- **P2.5 Factory sync in `World.ts` (Sonnet)** — `prev` model handed back for lane stability; zero buffer writes when `factoryKey` is unchanged (debug counter).

### Phase 3 — Motion and life (demo: demo clock moves pieces along lanes, a failure reverses to rework, a merge rides trunk → main line → dock, a branded truck leaves)
- **P3.1 Tweening along lane splines + rework/queue moves (Sonnet)**; **P3.2 arms/beacons/belt scroll per lane (Opus, ∥)**; **P3.3 `Dock.ts` + truck + release shelves + brand livery (Opus, ∥)**; **P3.4 Technicians (Sonnet, ∥)**. Acceptance as v1 (animation CPU ≤ 0.5 ms/frame at 360 stations; ≤ 4 skinned technicians).

### Phase 4 — Interaction, HUD, control room (demo: F on lane plate/station/piece/board/dock opens the right panel; Enter enters the linked session; FLOOR panel on the ops wall)
- **P4.1 Targets + actions + i18n (Haiku)**; **P4.2 Panels `PrPanel/StationPanel/LinePanel/DeployPanel` with lane numbers and the queue (Sonnet, ∥)**; **P4.3 FLOOR panel + line cams (Sonnet, after the control-room redesign lands)**; **P4.4 Minimap lanes + zone names (Haiku, ∥)**.

### Phase 5 — Data hardening, offline, perf gate, docs
- **P5.1 Backend polling hardening/pinned repos/releases (Sonnet)**; **P5.2 local-git intake/bench (Sonnet, ∥)**; **P5.3 flaky/bot/stale/conflict polish (Sonnet, ∥)**; **P5.4 perf gate script at four cameras + `docs/architecture/ARCHITECTURE.md` + README (Haiku)**; **P5.5 pinned-repos settings UI + branding plumbing to doors/trucks via `BrandingOptions` (Haiku, ∥)**.

### Phase 6 (optional) — vertex AO on soffits/columns, lightmap for the cell module if `tools/lightmaps` runtime lands.

---

## 8. Risks & open questions (decision-shaped, with defaults)

1. **Couple cell width to PR activity** (`spanDemand = max(sessions, ceil(activePRs/2))`, so a busy repo gets a wider room *and* cell) vs rooms sized by sessions only (cells queue overflow). *Default: couple, capped at `wing`.*
2. **Lane direction inward (intake at the outer wall, merge under the room)** vs outward. *Default: inward* — puts QA/merge/trunk under the balcony and the main line under the spine's glass strip.
3. **Lanes per pod bay = 2 (standard rooms get 4 lanes, not 6).** *Default: accept*; the alternative (1.6 m pitch, 3 per bay) is cramped and reads worse from above.
4. **Stairs: per-cell balcony stair + spine-node stairs every 4 bays + lobby/tower.** *Default: all four*; the balcony door is the one requirement on the rooms agent that touches room geometry.
5. **Merged pieces ride the main line for 24 h (fading), then vanish.** *Default: yes.*

Technical risks: (a) coordination with the rooms agent on `ProjectRoomLayout` fields and the balcony door — mitigated by the explicit list in §6 and by P0.7 being theirs; (b) two glass planes (room front + outer glazing) between the spine and the cells make transparency sorting delicate — mitigated by the existing `alphaIndex` ordering (exterior 0, tint 5, room glass 10; add balcony/strip glass at 7); (c) under-room darkness looking gloomy — mitigated by slab-edge LEDs and hood lights as clustered fixtures, verified in the P1.2 screenshot.

### Critical Files for Implementation
- /home/zio/git/claude-office/frontend/src/engine/logic/factoryModel.ts (lane assignment, `lanesFor`/`prev` options, key/board updates)
- /home/zio/git/claude-office/frontend/src/engine/layout/buildingLayout.ts and /home/zio/git/claude-office/frontend/src/engine/contracts.ts (`ProjectRoomLayout` exposure fields, `FactoryLayout`, zones)
- /home/zio/git/claude-office/frontend/src/engine/layout/factoryLayout.ts (new: cells, lanes, trunks, main line, stairs from the rooms layout)
- /home/zio/git/claude-office/frontend/src/engine/world/World.ts (factory construction/sync/update/visibility/teleport seams)
- /home/zio/git/claude-office/frontend/src/engine/world/Building.ts + /home/zio/git/claude-office/frontend/src/engine/world/Visibility.ts (spine glass strip, stairs, tower bay; floor-zone culling rules; companion factoryVisibility.ts)
