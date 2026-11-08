# 3D Software Factory — review and improvement plan

Branch `feat/3d-office`, reviewed at `50af07f` (dock platform walkable). Scope: `frontend/src/engine`,
`frontend/src/components/world`, `frontend/src/app/world-debug`, `frontend/src/app/factory-debug`, and the
backend `/ws/campus` feed. Read-only review: four parallel code audits (performance/lifecycle, geometry/colliders,
data/i18n/dead code, materials/lighting) plus a UX audit, 24 verification screenshots under
`~/.local/share/claude-office-shot/out/review/` (all read by the reviewer), and scripted walk tests through the real
player collider. Every finding below was verified by reading the code; file:line references are current at `50af07f`.

Conventions: yaw 0° looks +z (down the hall), +90° looks +x, positive pitch looks down; `cam=` takes the eye
position. The default demo (`n=6`) lays out a 6-bay hall (L = 28.8 m), the control room drum centred at z ≈ 37.9.

---

## 1. Executive summary

The world is architecturally ambitious and most of the engineering foundations are right: metric world-space UV
tiling with real ambientCG PBR sets, thin-instanced prefabs and pooled factory geometry (3 draws for conveyors, 7 for
stations, ≤ 8 for workpieces), a zone/portal visibility system, content-keyed screen redraws, a live quality governor
whose step-down bug was just fixed, and clean dispose paths. The control room interior is the best-looking space
(353 draws, SSR on the floor, legible dashboards).

What stops it being shippable today, in order of severity:

1. **Wrong data shown as real (P0).** When the backend sends `projects: []` — which it does whenever a live session
   is outside a git repo, or all sessions ended — the factory silently switches to *demo* PRs, failing CI runs and
   releases with no badge (`factorySync.ts:57-62,106`). A WebSocket drop leaves the last frame on screen as "live"
   with only a 2 px dot changing (`useCampusWebSocket.ts:99-115`), and one bad session throws the whole campus feed
   away (`event_processor.py:826-835`, no per-session guard).
2. **You can walk out of a team room and fall 6 m (P0).** Project-room end walls are thin-instanced prefabs with no
   colliders (`ProjectShell.ts:250-279`, `ProjectRoom.ts:126-187`). Spine-stair wells are cut on a fixed bay rhythm
   that can land on a room door and seal it (`factoryLayout.ts:293-308`). Factory equipment and the control-room
   decks have no colliders at all.
3. **Draw calls are 1.1–1.7× over budget at high.** Measured: 375 at spawn, 590 at the hall end facing the control
   room, 372 on the gallery, 353 inside the drum (budget ≤ 350). The multipliers are the G-buffer second pass
   (SSAO+SSR, 16 m reach), the 2-cascade CSM over every furniture part, un-merged AssetLibrary parts, and 17
   post-process passes. The control-room wall re-rasterises two ≤ 4096 px canvases every second for a seconds clock.
4. **The `A` key both strafes and opens the Agents panel** (`bindings.ts:15`, `panels.ts:67`, `useHudKeys.ts:52`),
   freezing movement for every WASD user on first contact. There is no first-run controls card, no in-world signage
   to the factory or control room, and no reduced-motion support.
5. **Photorealism is held back by a handful of systemic choices,** not by the models: screens are unlit
   `StandardMaterial`s that reflect nothing; glass has no probe reflections (effective env ≈ 0.13); eleven dielectric
   materials have metallic 0.1–0.85; the dock, truck, conveyors and stations are flat vertex-coloured white PBR with
   no normal/roughness; there is no contact shadow or vertex AO (furniture floats); no live fog so the exterior has a
   hard horizon seam; the interior HDRI is a 1k equirect converted on the CPU at startup and ~0.9 GB of uncompressed
   RGBA8 textures are resident at "high".

The plan below groups 60-odd findings into nine parallel workstreams with file-level ownership. The first three
(data integrity, traversal, render budget) are blocking; the materials/lighting workstream delivers most of the
visual gain for the least draw-call cost.

---

## 2. Evidence: screenshots and measurements

All frames 1280×800, SwiftShader (fps/ms figures are meaningless; draw counts are real). `__worldStats.draws` is
the Babylon draw-call counter for the frame.

| # | File | View | Draws | What it shows |
|---|------|------|-------|---------------|
| 01 | `01_spawn_high.png` | reception spawn, high | **375** | Over budget at the default view. Glass floor strip reads as a painted road (no reflection, no kerb). Sofa/plants have no contact shadow. Terrazzo floor has a hard seam band. Ring lamp floats without a drop rod. |
| 02 | `02_junction.png` | hall end → control room, high | **590** | Worst case. All 23 actors "near". Three floor finishes meet at the hall end (grating, oak threshold, flat beige slab) with no transition. Blank brown door panel on the left wall. |
| 03 | `03_junction_neck.png` | inside the drum, high | 353 | Best interior. Windows over the factory are blown out to white (no exposure match between drum and hall). No operators seated. |
| 04 | `04_stair_landing.png` | entrance stair mid-landing | 371 | Upper flight is visibly steep (36.9°, going 0.235 m). Plaster wall tiling repeats at 2 m. Open risers, no nosing contrast, no AO under the flight. Rails and guards close every edge (OK). |
| 05 | `05_stair_from_lobby.png` | ground lobby → east stair | 177 | Dusk sky through the glazing vs a bright sunlit interior (time-of-day mismatch). Mullions render teal-green. Card trees and box cars 20 m away. Jagged edge on the right-hand column (verify: TAA at 1 fps or cladding seam). No skirting. |
| 06 | `06_gallery_down.png` | gallery → factory through the glass strip | 372 | Glass strip is invisible (no fresnel highlight, no frame kerb). Hard terrazzo/concrete seam at z = 0. A far-LOD character impostor (magenta blob) visible at close range in the east room. SSR streak on the hall floor. |
| 07 | `07_gallery_down_w.png` | reception west → gallery | 368 | Hard-edged bright rectangle on the terrazzo (sun patch with no mullion shadows — the static sun map does not include the glazing mullions as casters). Desk and planters float. |
| 08 | `08_factory_up_slab.png` | cell floor → office slab underside | 359 | Good: concrete soffit, downstands, linear LEDs, columns with yellow bases, steel stair. Round duct passes *through* the cross beams; LED strips are bare emissive bars with no fixture body. `controlInt` (17) and `projEntry` (20) meshes still active from here (culling gap). |
| 09 | `09_mainline.png` | main line looking north | 361 | Strong composition. `floorEpoxy` blows out to white in patches (tint > 1). The main line conveyor dead-ends in open air 3 m south of the camera with nothing feeding it. Perimeter walls are flat white; no forklifts/people/dirt. Office/control meshes active from the floor (culling gap). |
| 10 | `10_low.png` | spawn, `quality=low` | 220 (8 pp) | Flat but brighter than high (ambient compensation over-corrects); FSR 0.75 is slightly soft; no AO so planters/sofa float more. Acceptable. |
| 11 | `11_medium.png` | spawn, `gfx=medium` | **369** (11 pp) | Visually indistinguishable from high at this view and only 6 draws cheaper: medium still carries the G-buffer SSAO pass, probes and 2048² CSM — it is "high minus TAA/SSR", not a mid tier. |
| 12 | `12_tier_roundtrip.png` | spawn, `tierStep=low@40,high@110`, 220 frames | 375 (17 pp) | No vanished walls (10ec624 holds) and the draw count returns to 375. **But the frame differs from 01:** the terrazzo is darker and carries diagonal façade-mullion shadows that 01 (60 frames at high) does not have. Either the static sun map is rendered before all casters exist and never re-rendered (timing), or the round trip changes lighting state. Disambiguated by `25_high_220.png` (§2.1). |
| 13 | `13_ctrl_lookback.png` | inside the drum → neck → hall | **489** | Junction is architecturally coherent (bulkhead, glazed neck, continuous ceiling). Drum wall is flat plaster with a lighter vertical panel band on the left; neck floor glass is matte grey; `entrance` (31) and `lobby` (15) meshes active from 40 m inside the drum. |
| 14 | `14_room_interior.png` | inside a team room (continuum) | **658** | Worst case: 6 near actors with shadows, 4 mid, live monitors, whiteboards, dividers. Room itself looks good. A nameplate label is drawn through the desk (`LabelLayer` occlusion miss). Windows to the factory are blown to flat grey. |
| 15 | `15_exterior.png` | forecourt → façade | 315 | Glass-box entrance reads well; the factory flank walls either side are an endless flat beige slab (no cladding texture, parapet, downpipes, signage, sawtooth roof silhouette). Two brand signs (reception + canopy). Daylight sky here is bright blue, so the dusk look in 05 is the baked cube seen through tinted glass. |
| 16 | `16_dock_from_floor.png` | main line → dock | 203 | Perimeter walls flat beige; drum underside a flat disc; dock door openings show sky with hard edges; shelving with red bars. The main line runs cleanly into the dock door. |
| 17 | `17_live_hall.png` | `live=1`, ops wall | 282 | Live feed renders: PROJECT MAP (continuum, claude-office), usage $, projects, alerts; console monitors mirror the wall. With 2 live projects the hall is 4 bays, so z = 24 is inside the drum. |
| 18 | `18_live_cell.png` | `live=1`, cell stations | 412 | Live stations ("BUILD" glyph plates, robot arms, belts) with the drum glazing above. Over budget on the factory floor with the office still active (P13). |
| 19 | `19_main_hud.png` | `/` main page, real HUD | 380 (auto → medium) | Spawn is *outside* the entrance doors facing the directory board. HUD overlaps: the N compass covers the `Tab Sessions` key hint; the Location chip covers the overview strip's "CONTINUUM · 2 SESSIONS" heading. 3D view is inset in a bordered panel under the app header. Directory board text ≈ 6 px at this distance. |
| 20 | `20_walk_endwall.png` | walk `8,0,1.5,180 → 8,-2` | — | Stopped at z = 0.31: the *lobby* wall at z = 0 has a collider, so this walk is inconclusive for inter-room end walls — see `26`/`27`. |
| 21 | `21_walk_entr_stair.png` | walk lobby → east stair → reception | — | Stuck at (11.10, −5.95, −6.80): approached the lower-flight foot from the west and hit the inter-flight divider guard. Route error in the test (the foot must be approached along the north wall, z ∈ (−6.6, −5.1)); re-run as `28`. The 1.5 m approach strip is itself a wayfinding smell. |
| 22 | `22_walk_spine_stair.png` | walk hall → east spine well → floor | — | **Pass:** reached 2/2, descended 0 → −5.93 in 6 s, ends at the stair foot on the main line. Hard white spot-light hotspot on the epoxy at low tier. |
| 23 | `23_soffit_zfight.png` | cell floor → gallery soffit | 336 | Still frame cannot show flicker; the coplanar bottoms (G8) are confirmed in code. Duct passes through the downstand (R14). Soffit/beam/LED detail is good. |
| 24 | `24_gallery_slit.png` | gallery SE corner | 166 | Factory south-wall inner face is a flat untextured beige plane filling half the frame; a thin bright seam line is visible at the wall/floor junction (G10). Balustrade + glass fine. |
| 25 | `25_high_220.png` | spawn, high, 220 frames (control for 12) | 375 | Identical to 01: bright floor, no mullion shadows. So the difference in 12 is caused by the high→low→high round trip, not by elapsed frames (finding L1). |
| 26 | `26_walk_endwall_east_far.png` | walk `8,0,22.5,0 → 8,27.5` | 123 (low) | **G1 confirmed:** reached 1/1 in 4 s with feet at (7.75, −5.85, 29.12) — walked through the east room's end wall and fell 6 m onto the factory floor under the drum; no respawn. |
| 27 | `27_walk_endwall_west.png` | walk `-8,0,13,0 → -8,17` | 206 (low) | Reached 1/1 at (−7.96, 0.03, 18.62): passed the z = 14.4 inter-room wall without stopping (walk-through into the neighbouring room). |
| 28 | `28_walk_entr_stair2.png` | walk lobby → stair foot along the north wall → landing → reception | 182 (low) | **Pass:** 4/5 waypoints, ends at (6.51, 0.07, −6.10) on the reception floor (final 0.5 m blocked by a planter). Both entrance flights and the landing are walkable. |

### 2.1 Second/third batch summary

- Draw calls at high by view: spawn 375 · hall end 590 · gallery 372/368 · drum 353 · drum look-back 489 · **room 658** ·
  factory floor 359–361 · dock 203 · exterior 315 · live cell 412 · main page 380 (auto→medium). Budget 350.
- Tiers: low 220 (8 pp), medium 369 (11 pp), high 375 (17 pp). Medium is not a mid tier.
- Round trip high→low→high: walls intact (10ec624 holds), draws return to 375, **but static lighting differs** (L1).
- Walks: spine stair pass; entrance stairs pass (when approached along the north wall); **room end walls fail (G1)**.
- Live feed: renders real projects on the ops wall and stations; the `[]`-projects demo fallback (D1) was not triggered
  because the live backend had two projects with CI data at the time.
| — | `../dock_top.png`, `../dock_stair_view.png` | dock platform (coordinator's shots) | 86 / 130 | Flat beige walls/floor/ceiling (single white PBR, vertex colours, no textures), blown-out exposure, box truck with red cubes, sky-cube roller-door openings with hard seams. |

### 2.1 Results of the second batch

---

## 3. Findings

Severity: **P0** = wrong data / fall-through / stuck / crash; **P1** = visible defect, perf over budget, or blocks
understanding; **P2** = polish or cleanup. Each finding names the workstream (WS) that owns the fix.

### 3.1 Data, sync and lifecycle

| ID | Sev | Finding | Evidence | Fix | WS |
|----|-----|---------|----------|-----|----|
| D1 | P0 | Factory shows demo PRs/CI/releases in production whenever the feed's `projects` is `[]`. Backend emits `[]` (never `null`) when no live session has a `project_id` or all sessions ended; sessions outside git still get client-side rooms and cells (`projectGroups.ts:28-36`), so demo lines appear with no badge. | `factorySync.ts:57-62` `noProjectData` treats `[]` as "no data"; `:106` `demo = !!input.demo \|\| noProjectData(...)`; `backend/app/models/campus.py:303-320`. | Demo only when `input.demo === true`, or `projects === undefined` *and* a dev flag. Render empty cells for `[]`. Add a `DEMO` chip to the cell header board and LinePanel when `stats.demo`. Test: `factorySync` with `projects: []` must not produce demo ids. | WS1 |
| D2 | P0 | Disconnect/backend failure shows stale data as live. On WS close only `connected=false`; store keeps sessions/stats/projects; `lastUpdated` is set only on session change and read by nobody. Backend `_flush_campus_broadcast` swallows any `build_campus` exception and sends nothing, so the socket stays "connected" with frozen data; `build_campus_session` has no per-session guard. | `hooks/useCampusWebSocket.ts:99-115`; `stores/campusStore.ts`; `backend/app/core/event_processor.py:826-835`; `backend/app/models/campus.py:~200-310`. | Frontend: on `!connected` or > 30 s without a frame, dim the HUD and show "Reconnecting — data from HH:MM:SS"; set `lastUpdated` on every accepted frame. Backend: try/except per session (log + skip), add `sentAt` to the frame. Tests for both. | WS1 |
| D3 | P1 | HUD factory panel builds a different model from the 3D scene: `lineFor` calls `buildFactoryModel([project], …)` without the cell's `lanesFor`/`prev`, so overflow pieces that are QUEUED in 3D get lanes in the panel; in demo mode the panel is empty (demo projects live only in `FactorySync.lastProjects`). | `hud/factory/factoryPanelModel.ts:101-104` vs `FactoryLines.ts:191`, `factorySync.ts:111`. | Expose the built `FactoryModel`/line per cell from `FactorySync` (store or world event) and have the panel read it instead of re-deriving. | WS1 |
| D4 | P1 | Two stale-PR thresholds: frontend hard-codes 7 d (`AGING Nd`) and ignores `pr.stale`; backend uses `CI_STALE_PR_DAYS=14`. | `factoryModel.ts:31,424`; `backend/app/config.py:49`; `ci_poller.py:360`. | Use `pr.stale ?? (now - updated > STALE_MS)`; send the threshold in the feed. | WS1 |
| D5 | P1 | CI health ranked two ways: `projectMap.ts` `CI_RANK` puts `cancelled` *after* success (healthier), `factoryModel.ts` `STATE_RANK` puts it worse; `projectMap.rollupCi` uses `pipelines[0]` and ignores `mainHealth`. | `projectMap.ts:133-155`; `factoryModel.ts:230-240,876`. | One exported `STATE_RANK`/`worseState` in `factoryModel.ts`; projectMap uses `mainHealth` for the trunk. | WS1 |
| D6 | P1 | Subagent "running" has two definitions: frontend `INACTIVE_AGENT={completed,leaving}`; backend also excludes `reporting_done`, `in_elevator`. Row sums and the total disagree. `stats.sessionsByStatus` is ignored. | `opsModel.ts:253,660-672`; `campus.py:67`. | Add the two states; or backend always sends `subagentsRunning`. | WS1 |
| D7 | P1 | `ciError`, `fetchedAt`, `headSha`, `unpushed`, `outputStyle` never reach the UI; a missing/unauthenticated `gh` just says "LOCAL · no CI". | `factoryModel.ts:930,948`. | LinePanel: show `ciError` beside the stale chip and `fetchedAt` as an age. | WS1 |
| D8 | P1 | `world-debug` live feed has no reconnect, hard-codes `status:"active"`, and the live branch never calls `setStats`. | `app/world-debug/liveFeed.ts`; `page.tsx:234-247`. | Reuse `useCampusWebSocket` (or add backoff + `setStats`). | WS1 |
| D9 | P1 | Backend close codes 4013 (cap 8 clients) / 4003 (origin) are retried forever and shown nowhere. | `backend/app/api/routes/websockets.py:28`. | Inspect `CloseEvent.code`; stop on 4003, show a message on 4013. | WS1 |
| D10 | P2 | `campusStore` compares whole payloads with `JSON.stringify` on every 100 ms frame. | `campusStore.ts` `sessionsEqual/setStats/setProjects`. | Compare a server-provided `rev`/`sentAt`, or hash per entity. | WS1 |
| D11 | P2 | Two store subscriptions push graphics to the world (`setGraphics` and `setQuality`), and anything that sets `graphicsQuality` clobbers a user's `custom`/`ultra`. Legacy `QualitySetting` (`auto\|high\|low`) cannot express `medium`, which the governor uses; `coarseTier` reports medium as "high"; `world-debug ?quality=medium` silently becomes `auto`. | `WorldCanvas.tsx:135,216-217`; `preferencesStore.ts:338-340`; `contracts.ts:725-726`; `Quality.ts:19-29`; `world-debug/page.tsx` `parseParams`. | Make `QualitySetting = "auto"\|"high"\|"medium"\|"low"` and `QualityTier` the concrete preset; drop the `setQuality` subscription in `WorldCanvas`; keep `setQuality` as a debug entry point; accept `quality=medium` in world-debug. | WS4 |
| D12 | P2 | `Lighting.loadInterior` does not check `scene.isDisposed` after the async HDR load (unlike `loadExterior`): one 256² `HDRCubeTexture` leaks if the world is disposed during init (HMR/StrictMode). | `Lighting.ts:242-257` vs `:267`. | Add the guard. | WS5 |
| D13 | P2 | `canvasKit.whenFontsReady` accumulates a callback per screen ever created until fonts resolve. | `screens/canvasKit.ts:45-54`. | Resolve `document.fonts.ready` once at module level. | WS4 |

### 3.2 Geometry and colliders

| ID | Sev | Finding | Evidence | Fix | WS |
|----|-----|---------|----------|-----|----|
| G1 | P0 | Project-room end walls have no colliders: walk through into the neighbouring room, or when the next bay is empty, into air and 6 m down onto the cell floor (no respawn: y = −6 > −10 fall net). | `ProjectShell.ts:250-279` end-wall prefab built with `cols=null`; `ProjectRoom.ts:126-187` registers floor, balustrade, glass front, pier only. **Walk tests 26 (fell to y −5.85) and 27 (walked into the next room).** | Two boxes per room at z0+0.05 / z1−0.05, size (ROOM_D, H, 0.1); or give `ShellModule` a static collider list per prefab. Walk test must stop at the wall. | WS2 |
| G2 | P0 | Spine-stair wells are placed on a fixed rhythm (bays 2, 6, 10… alternating sides, rect \|x\| 2.3–3.5, z ± 3.2) independent of slot allocation, so a west room with entry bay 5/6 (door z 26.0/30.8) or an east room with entry bay 9/10 has its door inside the well: hall rail at \|x\| 2.26 blocks from the hall, the flight's side guard sits in the door gap, and the drop beyond is 3.6 m onto the ramp. | `factoryLayout.ts:293-308`; doors `buildingLayout.ts:367-373,475-479`; rail `architecture.ts:853-869`; guard `FactoryHall.ts:1162-1204`. | Choose well bays from `building.projects` (never an entry bay on that side; prefer pod/empty bays). Add a layout test: no well rect intersects any door opening. | WS2 |
| G3 | P1 | Factory equipment has no colliders (conveyors at belt height 0.85, station housings, benches, boards): the player walks through everything on the floor. | grep of collider registrations: only Building, EntranceHall, ProjectRoom, Room, ControlRoom(+Shell), FactoryHall, Dock, AssetLibrary. | Per-lane boxes from `conveyorPaths`, per-station boxes from `stationPlan`, bench/board boxes from `cellPlan`, registered in a new `factory/factoryColliders.ts` called from `FactoryLines.applyModel` (one call). | WS2 |
| G4 | P1 | Control-room tier (0.25 m) and supervisor platform (0.3 m) have no floor colliders: the player sinks into the decks. | `controlRoomPlan.ts:166-168`; `ControlRoom.ts:881-920,972-979,1110-1114`. | Arc-strip floor colliders at deck height using the same chord approximation as the walls. | WS2 |
| G5 | P1 | Invisible forecourt fence 12–30 m before the visible one: colliders at z −46 / x ±34, fence drawn at z −58 / x ±64; the car park is cut in half. | `EntranceHall.ts:1110-1125`; `exteriorPlan.ts:220`. | Move the colliders to the fence/gates, and give trees/cars/sheds cheap box colliders. | WS2 |
| G6 | P1 | 0.20 × 2.4 m hole at the factory-door threshold: entrance quartz floor ends at z −5.0, factory epoxy starts at −4.8; the exterior ground is visible 4 cm lower under the opening. | `EntranceHall.ts:289,340-360`; `FactoryHall.ts:389-393`. | Extend the quartz box to zw+0.3 or lay a threshold plate. | WS3 |
| G7 | P1 | Reception floor lip pokes 0.24 m outside the building/gallery fascia (floor to ±13.6, walls/cladding end at 13.3–13.36): visible from the yard and from the factory under the gallery. | `Building.ts:292-302`; `EntranceHall.ts:325-327,1019-1024`. | Floor rect to ±(halfW+0.2) or fascia to 13.6. | WS3 |
| G8 | P1 | Z-fight under the reception gallery: soffit band and downstand beam share the bottom plane y = −0.45 over 0.3 × 26 m; edge beams at \|x\| 0.80–0.86 are coplanar inside the soffit. | `EntranceHall.ts:985-1002`; compare `FactoryHall.ts:1001-1009` (1 cm offset). | Beam bottoms to −0.75 (a real downstand) or soffit to −0.44. | WS3 |
| G9 | P1 | Hall ceiling (±3.7) overlaps the room ceilings (3.5–13.1) at y 3.2–3.3: coplanar strip 3.525–3.7 shimmers along every room front. | `Building.ts:792`; `ProjectShell.ts:113`. | Hall ceiling ±3.5 (the head track covers the joint). | WS3 |
| G10 | P2 | 5 cm daylight slit between the reception east wall (x 13.1–13.3) and the factory south wall (starts 13.35) at z −5.1…−4.8, y 0–6; 15 cm slot between reception ceiling top (6.1) and the lintel (6.25). | `Building.ts:518-524`; `FactoryHall.ts:82,637-638,313-317`. | Derive `HALL.ENTRANCE_OPENING.halfW` from halfW+T; close the slot. | WS3 |
| G11 | P2 | Dock front wall jogs 0.3 m against the factory north wall line. The stair-view shot also shows a stray black diagonal member crossing the ceiling at top-left (verify in `Dock.ts` rail/stringer extents). | `Dock.ts:547-556`; `FactoryLines.ts:378`; `FactoryHall.ts:642-645`; `dock_stair_view.png`. | Draw the dock wall at local 0..0.3; clip the stringer. | WS3 |
| G12 | P2 | Entrance stairs: drop 3.0 over run 4.0 → 17 risers, rise 0.176, **going 0.235 m, pitch 36.9°**, above the project's own unused `STAIR_MAX_DEG = 35`. Real: going ≥ 0.27. Cell switchback far landing 0.70 m deep for a 180° turn (real ≥ flight width 1.0). | `EntranceHall.ts:84,589-591`; `factoryLayout.ts:52-64`; `FactoryHall.ts:97,118`. | `ENTRANCE.FLIGHT_Z1 → −6.0` (going 0.27, 33°) and widen the cell landing to 1.0. | WS2 (constants) |
| G13 | P2 | Yard ground 2–4 cm below the collider top (feet float); `CellLayout.stair.rect` disagrees with the built stair (`stair.bottom` 17.2 vs `cellStairFoot` 18.4); `FactoryLayout.lobbyStair` written, never read. | `Exterior.ts:615,645-653`; `factoryLayout.ts:246-253,324`; `FactoryHall.ts:139-149`. | Align heights; single source for the cell stair rect. | WS3 |
| G14 | P2 | Visible finish gaps: hall end has three floor finishes meeting with no threshold (02); reception/hall terrazzo-to-concrete seam at z = 0 (06); no skirting anywhere; office roofs are bare ceiling boxes with no parapet (fly mode); the lift's open door is an invisible wall by design but unexplained. | screenshots 02, 05, 06. | Threshold strips (5 mm aluminium) at every finish change; 100 mm skirting on plaster walls via the ArtBatcher; parapet/upstand on roofs; lift prompt text. | WS3 / WS7 |
| G15 | P2 | Duplicated geometry code: `planMinus` = `rectMinusHoles`; two stair builders with separate rail constants (0.95 / 0.95 / `RAIL_H` 1.1); mirrored constants (`ENTR_WALL_T`, `HALL.SPINE_GLASS_W`…); `setEmptyBays` fascia buried inside the spine edge beam; stale comments/constants (`Building.ts:273` "10.5"; `lobby.size.y` 4.5 vs 6; `CONTROL_H` 4.5 vs 5.2). | `FactoryHall.ts:169-197`; `architecture.ts:755-786`; `EntranceHall.ts:90,1246`; `Building.ts:1114-1125`. | One `stairs.ts` helper (flight + ramp collider + rails) used by Entrance, FactoryHall, Dock; delete the copies; fix constants. | WS3 |

### 3.3 Performance

Measured at high: 375 (spawn) / 590 (hall end) / 372 (gallery) / 353 (drum) draws, 17 post-process passes, 255–259
textures resident. Budget ≤ 350.

| ID | Sev | Finding | Evidence | Fix | WS |
|----|-----|---------|----------|-----|----|
| P1 | P1 | G-buffer second pass (SSAO2 + SSR, `forceGeometryBuffer`) redraws every active mesh within 16 m (anything with radius ≥ 3.75 m at any range), and the 2-cascade CSM redraws every caster twice more. Composition at the hall end ≈ 200–300 main + 2×(20–50) CSM + 80–150 G-buffer + 15 pp quads + glow. | `PostFx.ts:242-304`; `fxPlan.ts:102,109-117`; `Lighting.ts:138-146`; `GraphicsController.ts:192-214`. | (1) G-buffer reach 10–12 m at high and skip `receiveShadows=false`/unlit screens from the G-buffer list; (2) drop `taskChair`/`chair`/`loungeTable` from `SHADOW_ROLES` (blob shadows suffice) and cap casting actors; (3) merge `AssetLibrary` parts per material per role (`Mesh.MergeMeshes`, `multiMaterial=false`) — today each role is N parts = N draws. Target: ≤ 300 spawn, ≤ 350 hall end. | WS4 |
| P2 | P1 | Control-room lower wall canvases (`lowL`/`lowR`, ≤ 4096 px wide, mipmapped) are fully redrawn and re-uploaded with mip regeneration every second because the content key includes a seconds clock. Same in `ControlRoomWall.drawOverlay` (dead path). | `ControlRoom.ts:544-553` + `drawLower` key; `ControlRoomWall.ts:318-354`. | Render the clock on its own 256×64 `DynamicTexture` quad; drop seconds from wall keys; `generateMipMaps=false` + `update(false,false)` for overlays. | WS4 |
| P3 | P1 | Workpiece hot path allocates and re-uploads all 7–9 thin-instance buffers every frame a belt moves: per-piece `PieceMotion` objects, closures (`lanePath`), string signatures per piece, `thinInstanceSetBuffer` for pallet + 4 bodies + band + ghost, `new Set`, `new Uint8Array`, tag uploads. | `FactoryLines.ts:512-563`; `factoryMotion.ts:247-257`; `Workpieces.ts:547-562,712-735`; `workpiecePlacement.ts:210-213`. | Numeric change test (typed array of `placed`), write matrices in place + `thinInstanceBufferUpdated("matrix")`, pooled `PieceMotion[]`, split colour/tag path from the matrix path. Target: ≤ 0.3 ms/frame `animMs` with 40 pieces moving. | WS4 |
| L1 | P1 | A live tier round trip changes the static lighting: `12_tier_roundtrip` (high→low@40→high@110, 220 frames) shows a darker terrazzo with façade-mullion shadows, while `01` and `25` (high, 60 and 220 frames) show a bright floor with none. Either the fresh run's static sun map is rendered before the entrance casters are registered and `staticDirty` is never raised again (so the "wrong" image is 01/25 and the first-run map is incomplete), or `rebuildShadows()` on the way back re-renders the map with a different caster set / `compensateAmbient` is not symmetrically undone. Same tier must give the same frame. | `Lighting.ts:219-226,405-412,473-513,631-635`; frames 01, 12, 25. | Make the static caster set and ambient compensation pure functions of the plan: raise `staticDirty` after the last `addStaticCasters` of `World.init` (and after every `sync` that adds rooms), re-render once per debounce; write a `tierStep` test in the perf gate that asserts mean luminance of 01 vs 12 within 3 %. | WS5 |
| P4 | P2 | Lighting starts at "high" (2048²×2 CSM + 4096² sun) before the plan is applied, then rebuilds and re-freezes every material for the real tier: ~48 MB of shadow maps allocated and discarded on low/mobile. | `Lighting.ts:168,174,353-360`; `World.ts:383,462`. | Pass the initial plan's `shadows`/`maxDynamicLights` to `Lighting` before `setCamera`. | WS5 |
| P5 | P2 | Static sun map (4096²) re-renders once per room arrival (`staticDirty` per `addStaticCasters`), not coalesced like the probes (1.5 s). | `Lighting.ts:219-226,503-513,839-851`. | Debounce `renderStaticShadows()` 1.5 s. | WS5 |
| P6 | P2 | Materials created after `freezeAll()` are never frozen: Conveyors (3), Stations (6), Workpieces (4), Truck, Dock, `sharedScreenMaterial`, per-pod DoorSign (2), Whiteboard, every `liveMat` — ≈ 12 unfrozen `StandardMaterial`s per pod. None change uniforms per frame. | `Materials.ts:951-956`; `Conveyors.ts:164-205`; `Stations.ts:178-221`; `Workpieces.ts:452-474`; `canvasKit.ts:181-218`; `DoorSign.ts:158,173`; `Monitor.ts:120,217,229`. | `freeze()` after construction; wrap texture swaps in `unfreeze()/freeze()` as `Lighting.buildProbe` does. Keep animated ones (`wallRim_needs_you`, `pulseMat`, LedPanel) unfrozen. | WS5 (definitions) |
| P7 | P2 | Per-frame allocations: `cam.getForwardRay(1)` (`World.ts:1034`); `visRoomsOfProjects` + `VisInput` built every frame before the 5 Hz gate (`:1040-1053`); `activeKinds()` regex+sort every 500 ms in production (`:1004-1017`); `new Set` ×2 and `filter().map().sort()` over all fixtures every frame at high (`Lighting.ts:653-654,731-734`); `ActorHub` order array + sort + `shadowMeshes()` + `Color3.FromHexString` per far actor per frame (`:236-285`); `Player` `new Vector3`×n and `new Ray` + `pickWithRay` over all meshes per frame in TP (`:415-419,504,523-528,587-599`); `ControlRoom` dots `new Matrix/Vector3/Quaternion` per dot per frame (`:1864-1877`). | as cited | Preallocate scratch objects; cache `VisRoom[]` with `visCacheKey`; gate stats behind `debug`; 400 ms cadence for fixture assignment; cache per-actor tint; restrict TP pick to the collider list. | WS4 (World, ActorHub, Player, ControlRoom dots) / WS5 (Lighting) |
| P8 | P2 | Feed RTT render lists include every AssetLibrary part in the building (`...allParts()`), so each 320×180 feed draws all furniture instances once per frame while near the control room. | `ProjectRoom.ts:369-376`; `FeedScheduler.ts:134-137`. | Per-room part/instance lookup in `AssetLibrary`, or `layerMask`-partition rooms. | WS4 |
| P9 | P2 | Workpiece tag atlas 1024×3200 RGBA (13 MB) uploaded whole on any single tag change (`maxTags=160`, tags visible within 10 m). | `Workpieces.ts:491-500,753-765`. | `maxTags ≈ 64` or `engine.updateTextureData` for the dirty cell. | WS4 |
| P10 | P2 | Several hundred invisible collider meshes are evaluated every frame and iterated by every `scene.pick` (`isPickable` default, `doNotSyncBoundingInfo=false`). | `Colliders.ts:157-191`; `Interaction.ts:101-119`; `Player.ts:599`. | `isPickable=false`, `doNotSyncBoundingInfo=true`; interaction/TP rays use `ray.intersectsMeshes(colliderList)` like `StaticOccluders`. | WS2 |
| P11 | P2 | 17 post-process passes at high (FSR off, but SSAO2 ×3 passes, SSR, TAA, bloom ×4, grading, sharpen, DoF when inspecting, glow). Medium carries MSAA2 + SSAO + probes; low carries FSR1 + FXAA + bloom. | `fxPlan.ts:296-319`; `PostFx.ts:242-410`. | At high: SSAO ratio 0.5 with the *cheap* blur, bloom `kernel 32`; drop sharpen when TAA is on. Target ≤ 12 passes at high, ≤ 6 at medium. | WS4 |
| P13 | P1 | Office interior is not culled from the factory floor: standing at y −6 under the slab (08, 09) `__worldStats.kinds` still lists `controlInt` 17, `projEntry` 20, `podZone` 10, `lobby` 11 — the control-room interior, room entries and pods are drawn through an opaque slab. Likewise from the gallery (06/07) the drum interior (`controlInt` 17) is active 35 m away behind the hall. | `__worldStats` from 06–09; `Visibility.ts` zone rules; `factoryVisibility.ts`. | Zone rule: when `zone.kind ∈ {factory, cell, dock, entrance}` hide `controlInt`, `podZone`, `projEntry` units (the slab is opaque; only room undersides, balconies and the glass strip grillage stay); when in the lobby/hall hide `controlInt` beyond 22 m (the `setFar` hook exists — extend it to the drum shell interior). Expect −40…−60 draws on the floor. | WS4 |
| P12 | P2 | ~0.9 GB uncompressed RGBA8 texture memory at "high" (18 sets × 2048² albedo+normal + 1024² ORM, WebP → RGBA8, no KTX2); both HDRIs converted equirect→cube on the CPU at startup (the sky at 1024³ float ≈ 75 MB). | `Materials.ts:544-548,867-898`; `Lighting.ts:242-266,882-910`. | KTX2 (UASTC normals, ETC1S albedo/ORM) via the fetch script; prefiltered `.env` IBLs (`CubeTexture.CreateFromPrefilteredData`). | WS5 |

### 3.4 Photorealism (materials, lighting, scale, dressing)

| ID | Sev | Finding | Evidence | Fix | WS |
|----|-----|---------|----------|-----|----|
| R1 | P1 | Screens, monitors, ops wall, LED panels are unlit `StandardMaterial`s (black diffuse, emissive only): they reflect nothing — the biggest "CG screen" tell. | `canvasKit.ts:160-172`; `LedPanel.ts:153-158`; `ControlRoom.ts:1339`. | `PBRMaterial` albedo (0.01,0.012,0.015), metallic 0, roughness 0.12 (0.3 for diffusers), `emissiveTexture`, `environmentIntensity 0.6`, bind the zone probe as `reflectionTexture`. Zero extra draws. | WS5 |
| R2 | P1 | Glass is alpha-blend only with effective env reflection ≈ 0.13 (0.3 × scene 0.42), no probe, excluded from SSR; interior glass therefore reads as "nothing there" (06: the floor strip is invisible). | `Materials.ts:435-438,695,705`; `PostFx.ts:196-199`; probes `Building.ts:232-258`, `FactoryHall.ts:305-319`. | Add `glass`/`glassTint`/structural glass to the zone probes' material lists; `environmentIntensity 0.3 → 0.7`; faint edge tint `#E4F0EC`, alpha 0.08 → 0.10; 40 mm structural glass gets a visible 60 mm aluminium kerb/frame. | WS5 (materials) / WS3 (kerb) |
| R3 | P1 | Non-physical metallic on dielectrics (reads as dull half-mirror grey): `galvanised` 0.85 flat, `steelPainted` 0.1, dock door 0.35, dock metal 0.5, truck body 0.25, `wpBody` 0.55, `wpPallet` 0.5, conveyor frame 0.72, guard 0.05, `stationPaint` 0.18, control plinth 0.35 / surround 0.2, brand plate 0.5, bezel 0.15. Albedo gains > 1 (`floorEpoxy` 1.43/1.37/1.53, `paving` 1.15, `charcoal` ×6.5–7 amplifying 8-bit noise). | `Materials.ts:366-374,473,516,525,531`; `Dock.ts:227,1049`; `Truck.ts:72`; `Workpieces.ts:454,458`; `Conveyors.ts:186,202`; `Stations.ts:178`; `ControlRoom.ts:609,612`; `BrandSign.ts:66`; `canvasKit.ts:197`. | Dielectric → metallic 0; real metals → metallic 1 with a real albedo (galvanised `#B4B8BB` + Metal011 brushed ORM; conveyor frame (0.55,0.56,0.58) rough 0.4). `floorEpoxy` tint ≤ 1 on Concrete046; `charcoal` → Metal028/030 solved from `MEAN_ALBEDO`. | WS5 |
| R4 | P1 | Dock, truck, conveyors, stations, workpieces, cells are flat white PBR with vertex colours only — no normal, roughness or AO variation, which is why `dock_top.png` reads as untextured beige and the exposure looks washed out (the single `matte` material is roughness 0.88, albedo white, env 0.55). | `Dock.ts:425-466,1039-1050`; `Truck.ts:69-92`; `Conveyors.ts:164-205`; `Stations.ts:178-221`. | Give the `matte`/`metal` dock materials the `concreteSoffit`/`steelPainted` texture roles (world-space UVs already work on merged meshes via `applyWorldUVs`); add a 4 m grime detail map with stronger roughness contrast (`roughnessBlendLevel 1.0`, `diffuseBlendLevel 0.8`); platform edge rubber bumpers/steel nosing already exist — add dock levellers, bollards, a wheel-chock, stacked pallets, a pallet jack, strip curtains in the door openings, and tyre marks on the apron. Truck: real cab/trailer proportions (cab 2.5 m, trailer 13.6 × 2.55 × 2.7 m), wheels, mudguards, a glossy `clearCoat` livery, interior light in the box. | WS5 (materials) / WS6 (dressing + truck) |
| R5 | P1 | No contact shadows and no vertex AO: SSAO is off on low, faint on medium; furniture, plants, sofas float (01, 02, 05). `csm.setDarkness(0.15)` further lifts the only dynamic shadow. | `Lighting.ts:444`; `AssetLibrary.ts` (no blob part); `art/geometry.ts:300-313`. | Thin-instanced `shadowBlob` part per `PropRole` (radial-gradient `RawTexture`, footprint × 1.15, y + 3 mm, `zOffset −2`) as `Exterior.ts:420-436` already does; vertex AO in `ArtBatcher.add` (0.8 + 0.8·y below 0.25 m, 0.9 at ceiling faces); `setDarkness 0`, key 0.55 → 0.8, fill 0.32 → 0.25. ≈ +12 draws. | WS5 |
| R6 | P1 | No live fog: EXP2 haze is applied only during the sky bake, so the near ground plane meets the baked far disc at a hard seam and trucks/trees pop; the sky HDR reads as dusk while the interior is noon-bright (05). | `Exterior.ts:1392-1460`; no `fogMode` elsewhere; `Lighting.ts:148-216,269-305`. | `scene.fogMode = LINEAR`, start 60, end 260, `fogColor = HAZE`; `applyFog=false` on interior/factory batches and `AssetLibrary` parts. Pick a sky HDR whose sun matches the directional light (or rotate `kloofendal` so its sun is at the `sun` azimuth and raise skybox `level` to match ACES exposure). | WS5 |
| R7 | P2 | Luminaires: `down` spots #FFE4C4 (~3200 K) read tungsten in an LED office; `lightPanel` #FFF1E0. Low tier loses the 3.4-intensity sun when shadows go "off" but `compensateAmbient` reacts only to `maxDynamicLights` → lobby darkens on step-down. | `Lighting.ts:115-122,405-412,631-635`; `Materials.ts:483`. | `down` → #FFEBD6 (3700 K), panel → #FFF4E8; when `shadows==="off"` raise fill ≥ 0.55, key ≥ 0.8. | WS5 |
| R8 | P2 | Clear coat only on the robot; sealed terrazzo/epoxy floors use a single GGX lobe. PCF HIGH on a render-once sun map where PCSS would be free. Vignette weight 1.6 is a heavy iris. | `Materials.ts:180,512`; `Lighting.ts:453-465`; `PostFx.ts:364`. | `clearCoat` 0.55 / rough 0.12 on `floorLobby`, `floorEpoxy`, `floorDark`; `useContactHardeningShadow` (UV ratio 0.012) on the static map at high/ultra; vignette 0.9. | WS5 |
| R9 | P2 | Texture scale: plaster `wall` tiles at 2 m with a strong detail blotch → visible repeat on the 6 m entrance walls (04, 05); terrazzo `floorLobby` reads as fine static noise at 1280 px (01, 06); exterior cladding atlas 42 px/m, ground tiles 32 px/m, trees 256² cards; exterior `tex()` decodes authored-linear RGB as sRGB. | `Materials.ts:229`; `exterior/textures.ts:44-64,82,188-189,278`. | Plaster tile 3.5 m + rotate the detail map; terrazzo tile 1.2 m with a 1024 albedo; cladding 1024², ground 512, trees 512 + 2 species; `gammaSpace=false`. | WS5 |
| R10 | P2 | Floor markings are 5 mm boxes (~150 in the factory, more on the dock); no decals, dirt, tyre marks, oil, chipped paint anywhere. | `FactoryHall.ts:331-337,377-383`; `Dock.ts:437-466`. | One 4096² marking/wear `DynamicTexture` over the hall footprint applied as `decalMap` on `floorEpoxy` (or a single alpha plane at +2 mm); paint wear and scuffs into it. | WS5 |
| R11 | P2 | Drum windows over the factory are blown out (03): the factory high bays (#F2F5FF ×1.35) + ACES exposure 1.05 saturate through 12 mm glass. | `FactoryHall.ts:1396-1401`; `PostFx.ts:362`. | Lower high-bay intensity to 1.0 and tint the drum glazing (`glassTint` alpha 0.42) on the factory side; or auto-exposure proxy: `exposure 0.9` while `zone==="control"`. | WS5 |
| R12 | P2 | Set dressing gaps: reception has no visitor chairs, mats, signage stand, badge reader, bins, cable management; hall has no fire extinguishers, exit signs, fire hose cabinets, thermostats, sockets; factory has no cable trays to the stations, no tool trolleys, bins, safety signage, eyewash, first-aid, fire points, charging stations, mezzanine ladders; lobby has no mat well, turnstiles, directory stand; no people at the reception or in the drum. | screenshots 01–06, dock shots. | New `world/dressing/{reception,hall,factory,dock}.ts` modules using existing `PropRole`s + 6–8 new procedural props, each thin-instanced (target +20 draws total); seat 2 operators and a receptionist from the cast. | WS6 |
| R15 | P1 | Factory perimeter walls, the gallery-side south wall and the façade flank walls are flat untextured beige planes at close range (16, 24, 15): one `paint`-class colour over 75 × 15 m faces with no cladding profile, dado, cable trays, sockets, fire points or dirt. Same family as the dock walls (R4). | `FactoryHall.ts` wall builder (`:600-660`), `Exterior.ts` cladding, `exterior/textures.ts:184-268`. | Give the inner walls a profiled-cladding role (vertical sandwich-panel normal map at 1 m pitch, `Metal030`-style powder-coat ORM) with a 1.2 m concrete dado and a 2 m-high impact-rail band; outer walls get the same profile plus parapet capping and downpipes every 12 m; add the sawtooth roof silhouette to the exterior. Texture-only, no new draws except parapet/downpipe batches (+2). | WS5 (materials) / WS3 (parapet, downpipes) |
| R16 | P2 | Hard white spot-light hotspot on the epoxy floor at low tier (22): the clustered `down` spots (intensity 5.5, `cos^2.2`) hit a 0.42-rough floor with no shadow/AO to break the disc. | `Lighting.ts:115-122`; `Materials.ts:512`. | Cap per-light intensity at 3.5 on low (`compensateAmbient` path) and raise `floorEpoxy` rough factor 0.42 → 0.6. | WS5 |
| R14 | P2 | Static sun map: the lobby sun patch is a hard-edged rectangle (07) — the glazing mullions/frames are not static casters, so sunlight through a curtain wall has no frame shadows; the main-line conveyor dead-ends in open air at its south end with no feeder/return (09); the round services duct under the slab passes through the downstand beams (08). | `Lighting.ts:503-513` static caster list; `conveyorPlan.ts` main line z0; `FactoryHall.ts` duct/beam y. | Register the entrance/lobby mullion batch as static casters; cap the main line with a return/terminal plate or start it under the gallery wall; hang the duct 0.15 m below the beam soffits. | WS5 (casters) / WS3 (duct, conveyor end) |
| R13 | P2 | Scale nits: ring pendant over the reception has no drop rod (01); far-LOD character impostor visible at 8 m as a magenta blob (06); open-riser oak treads with no nosing contrast; the glass strip over the main line has no kerb (06). | screenshots | Drop rods on pendants; impostor LOD distance ≥ 18 m or a cheaper mid LOD; 30 mm anodised nosings; 60 mm glass-strip kerb. | WS3 / WS4 (LOD) |

### 3.5 UX, HUD and i18n

| ID | Sev | Finding | Evidence | Fix | WS |
|----|-----|---------|----------|-----|----|
| U1 | P1 | `A` is bound to strafe-left *and* the Agents panel; both listeners fire (engine does not stop propagation), the panel opens and input is disabled — the player freezes on first WASD use. | `bindings.ts:15`; `panels.ts:67`; `useHudKeys.ts:52-55`; `Input.ts:167,176`. | Move Agents to `T`; make `useHudKeys` ignore engine-owned codes while input is enabled; fix the comment at `bindings.ts:3`. | WS7 |
| U2 | P1 | No first-run onboarding or controls card: only the click-to-look pill and a bottom-left hint bar (hidden on touch); `F`/`Enter` appear only when something is targeted; `N`, `B`, `R`, the lift and the factory are never explained; Help (`H`) never auto-opens. | `Overlays.tsx:207,262,275`; `en.ts:330`. | Dismissible controls/orientation card on first ready (localStorage flag like OverviewStrip), re-shown on pointer-lock loss until the first `H`; card text in §5. | WS7 |
| U3 | P1 | No directional or level signage: `drawWayfinding` is dead code; no "Control room →", "Factory ↓", "Level 1" anywhere except the ground-floor directory board; the `floor` teleport exists but nothing calls it; minimap office view omits stairs/lift. | `architecture.ts:671` (no caller); `World.ts:1159`; `contracts.ts:733`; `Minimap.tsx`. | Wire wayfinding signs at the reception stair head, hall ends, spine-well heads and factory stair feet (content from WS7, placement by WS3); minimap: stairs/lift icons on the office layer, a "Factory ↓" button bound to the `floor` teleport; `LocationChip` shows level + cell project. | WS7 (HUD/minimap) / WS3 (3D signs) |
| U4 | P1 | Tokens/cost exist only on the Ops dashboard; StationPanel has no run/log URL and LinePanel no PR links; the 3D workpiece tag is only `#N · title`; nothing explains the colour semantics (green = done *and* passed; amber = needs-you *and* queued). | `OpsDashboard.tsx:395-403`; `StationPanel.tsx`; `LinePanel.tsx`; `factoryModel.ts:588,245-257`; `contracts.ts:587-591`. | Cost/tokens on the DoorSign and InspectPanel; `GithubLink` per run row and per PR row; a legend chip in LinePanel/Minimap; separate CI palette from session palette (CI: pass ✓ green, fail ✗ red, running ◌ blue, queued ○ grey). | WS7 (StationPanel/PrPanel/legend) / WS1 (LinePanel) |
| U5 | P2 | Pointer-lock: one `pointerlockerror` sets `lockFailed` forever (browsers refuse re-lock for ~1 s after Esc) → click-to-look silently dies. No pause menu. `Tab` is stolen globally so keyboard focus navigation of the HUD is impossible; KeyHints buttons are `tabIndex=-1`; minimap SVG has `role=button` groups with no key handlers. | `Input.ts:99,140`; `useHudKeys.ts:36`; `Overlays.tsx`; `Minimap.tsx`. | Retry lock after 1.2 s with a "click again" hint; move Sessions to `Tab` only while locked, otherwise leave Tab alone; focusable minimap rooms. | WS7 |
| U6 | P2 | No reduced-motion support: head bob, `hud-pulse`, sign flicker ignore `prefers-reduced-motion`. HUD text floors at 9–11 px (Keycap 10, OpsCharts 7 px) with a fixed 420 px panel and no HUD scale. Touch labels "Enter/Camera/F/Menu" are hard-coded English; touch controls overlap the overview strip at small heights. | `graphicsSettings.ts:117,256`; `Player.ts:577`; `glass.ts:8`; `Keycap.tsx:11`; `OpsCharts.tsx:165`; `TouchControls.tsx:122-135`; `WorldHud.tsx:160-172`. | `matchMedia('(prefers-reduced-motion)')` → headBob off, flicker off, pulse off; 12 px floor + `--hud-scale` option; i18n touch labels. | WS7 |
| U7 | P2 | Status naming/colour drift: RoomSign uses #F5A524/#5B9DFF vs `STATUS_COLORS` #f59e0b/#3b82f6; "done" is IDLE on the LED sign, DONE on the DoorSign, Done in the HUD; CI "cancelled" has three different greys (`opsCanvas` #64748B, `dockModel` #8b93a1, `stateColor` → ended colour, `Stations.ts:487`); factory minimap palette (blue cells, amber line, orange dock) carries no health. | `RoomSign.ts:128-148`; `DoorSign.ts:73`; `opsCanvas.ts:1327-1341`; `dockModel.ts:121`; `factoryModel.ts:245-257`; `Minimap.tsx`. | One `statusPalette.ts` (session + CI) imported everywhere; minimap cells tinted by rolled-up CI. | WS7 |
| U8 | P2 | i18n gaps: factory stamps (`DRAFT`, `REWORK`, `AGING 3d`, `STALE`…) and headers (`${n} PR${s}`, `LOCAL · no CI`) are English literals rendered verbatim in LinePanel; `opsCanvas` wall text, `PHASE_LABEL_EN`; hand-rolled number/date formatting (`opsModel.ts:46-80`, `projectInfo.ts:48-53`, `fmtClock`, `formatDuration`). | `factoryModel.ts:436-530,933-936`; `opsCanvas.ts:461,753,1277,1334-1341`; `sessionInfo.ts:32-46`. | Stamps become keys + params; `Intl.NumberFormat` (compact, currency) and `Intl.DateTimeFormat`; canvas screens take a `t` in `setData`. | WS7 (HUD) / WS8 (canvas + logic strings) |
| U10 | P2 | HUD overlaps on the real page (19): the N compass covers the first key hint (`Tab Sessions`); the Location chip covers the overview strip heading. The ground-floor directory board — the only factory pointer — is ≈ 6 px tall from the spawn point. A nameplate label is drawn through a desk inside a room (14): `LabelLayer` occlusion misses furniture because `StaticOccluders` only samples walls. | `WorldHud.tsx:160-175`; `Overlays.tsx` KeyHints/LocationChip; `EntranceHall.ts:1252-1283`; `screens/LabelLayer.ts`, `World.ts:1021-1023`. | Reserve a left gutter for the compass or move it; stack chip/strip in one flex column; directory board 2× size with the "Factory floor →" row in accent; include `AssetLibrary` big parts in the occluder sampler or depth-test labels against the G-buffer depth. | WS7 (HUD) / WS4 (labels) |
| U9 | P2 | Teleports are instant with no fade/banner; opening any panel releases the pointer and disables movement; factory F-panels replace rather than stack. | `World.ts:1154-1208`; `WorldCanvas.tsx:96-104`. | 150 ms fade + `EnterBanner` on teleport; allow "peek" panels that keep the lock (read-only) until clicked. | WS7 |

### 3.6 Dead code, duplicated systems, docs

| ID | Sev | Finding | Evidence | Fix | WS |
|----|-----|---------|----------|-----|----|
| C1 | P2 | Three control-room implementations: `ControlRoom.ts` (+`opsCanvas.ts`, production), `ControlRoomWall.ts` (+`wallModel.ts`, imported only by `app/actors-debug/actorsScene.ts`), and the DOM `hud/ops/*`. They re-implement CI colours and labels independently. | `screens/ControlRoomWall.ts` (535 lines); `wallModel.ts`. | Delete `ControlRoomWall.ts` + `wallModel.ts` (+ their tests), point actors-debug at `ControlRoom`. | WS8 |
| C2 | P2 | Exports with zero importers: `opsCanvas.drawTicker/ciColor`; `architecture.ceilingPanels/drawWayfinding/drawNameplate/DOOR_BAND_FACE` (wayfinding gets wired by WS3 — keep that one); `RoomSign.roomSignData/ledContent`; `Visibility.visRoomsOf`; `MeshBatcher.toVector3`; `projectMap.MAP_STATUS_COLORS`; `monitorText.MONITOR_LINES`; `identity.AGENT_PALETTE`; `manifest.characterPath/texturePath`; `actions.OPEN_GITHUB` (+ the unreachable `github` handler in `WorldCanvas.tsx:120`); 3 consts in `charactersMpfb.ts`; `campusStore.selectCampus*`; ~14 `preferencesStore.select*`; `hooks/useFloorSessions.ts`, `hooks/useRoomSessions.ts`; `useWebSocketEvents.resetFrontendState`; `FactoryHall.STAIR_MAX_DEG`; `FactoryLayout.lobbyStair`. | as listed | Delete; `knip` or `ts-prune` in `make checkall`. | WS8 |
| C3 | P2 | Unused assets: `public/assets/textures/` (8 Poly Haven sets, ~13 MB, `texturePath` has no caller), `hdri/canary_wharf_2k.hdr` (6.6 MB), 19 of 37 `materials2/` sets unreferenced. | `manifest.ts:173`; `Materials.ts` `SURFACES`. | Remove from the repo/fetch script (−20 MB+). | WS8 |
| C4 | P2 | Stale comments: `DoorSign.ts:1-30` "not wired yet" (it is, `Room.ts:138`); `OpsOverlay.tsx:19-21` cast "once the store carries it"; `Building.ts:273` "10.5"; `bindings.ts:3` HUD key list. `ControlRoom.ts:1736` `{spark: []} as unknown as OpsRow` hides a missing-row case. `catch {}` in `useCampusWebSocket.ts:89`, `liveFeed.ts:50`. | as cited | Fix comments; type the missing row; `console.warn` in the catches. | WS8 |
| C5 | P2 | `docs/architecture/ARCHITECTURE.md` still describes the PixiJS office; the 3D engine appears only in one paragraph about `/ws/campus` (line 834). | `docs/architecture/ARCHITECTURE.md` | Add a "3D world" section: module map (layout → world → screens → fx), sync pipeline, quality tiers, debug URL params, screenshot/walk-test workflow. | WS8 |
| C6 | P2 | No tests for: `useCampusWebSocket` reconnect/stale, `liveFeed`, the demo-fallback decision with `[]`, `opsCanvas`/`ControlRoom` rendering, HUD panels, `contracts.ts` vs the backend schema (hand-written; drift undetected), a backend "one bad session" test, the stale-PR threshold agreement. | `frontend/tests` (61 files, 736 passing); `backend/tests`. | See WS9. | WS9 |

---

## 4. Workstreams

Ordered by impact. **Ownership is by file; where two workstreams must touch one file the line regions are named and
a landing order is given** (the later one rebases). Models: *haiku* for mechanical edits, *sonnet* for standard
engineering, *opus* for 3D geometry, rendering or visual judgement. Every workstream runs `make checkall` and the
listed screenshots/walk tests before it reports; screenshots go to `~/.local/share/claude-office-shot/out/<ws>/`.

### WS1 — Data integrity and the live feed  (sonnet) — blocking
**Findings:** D1–D10, U4 (LinePanel part).
**Owns:** `engine/world/factory/factorySync.ts`, `engine/logic/factoryModel.ts`, `engine/logic/projectMap.ts`,
`engine/logic/opsModel.ts`, `components/world/hud/factory/factoryPanelModel.ts`,
`components/world/hud/factory/LinePanel.tsx`, `hooks/useCampusWebSocket.ts`, `stores/campusStore.ts`,
`app/world-debug/liveFeed.ts`, `app/world-debug/page.tsx` (the `feed()` live branch only),
`components/world/hud/Overlays.tsx` (new `ConnectionBanner` only; WS7 owns the rest — WS1 lands first),
`backend/app/models/campus.py`, `backend/app/core/event_processor.py`, `backend/app/api/routes/websockets.py`,
`backend/app/config.py`, their tests.
**Acceptance:**
- `factorySync.update({projects: [], demo: false})` yields zero pieces and no demo ids (new test); `?live=1` with the
  backend running shows only real repos (`17_live_hall.png`, `18_live_cell.png` re-shot, no `acme/*` ids).
- Kill the backend while `/` is open: within 5 s a "Reconnecting — data from HH:MM:SS" banner appears and the HUD dims;
  restart: banner clears, `lastUpdated` advances every frame (test on the hook with a fake socket).
- Backend test: a session whose `build_campus_session` raises is skipped and the frame still broadcasts.
- `lineFor()` and the 3D model agree on `lane`/`queuePosition` for every piece (property test over demo campuses).
- One `STATE_RANK`; `pr.stale` honoured; `ciError` + `fetchedAt` visible in LinePanel; PR rows link to GitHub.
- 4013/4003 close codes surface a message and stop retrying on 4003.

### WS2 — Traversal and colliders  (opus) — blocking
**Findings:** G1–G5, G12 (constants), P10.
**Owns:** `engine/world/ProjectRoom.ts` (collider block `:126-190` — WS4 later touches only `getRenderList`),
`engine/layout/factoryLayout.ts` (stair-well selection `:293-308` and `ENTRANCE.FLIGHT_Z1`), new
`engine/world/factory/factoryColliders.ts` + a single call in `FactoryLines.applyModel` (WS4 owns `stepPieces`),
`engine/world/ControlRoom.ts` collider block (`:670-690`, `:972-979`, `:1110-1114`; lands before WS4/WS5 touch the
file), `engine/physics/Colliders.ts`, `engine/world/EntranceHall.ts` forecourt colliders (`:1110-1125` only; WS3 owns
the rest and lands after), `engine/interaction/Interaction.ts` (ray over the collider list), `engine/world/Exterior.ts`
(prop colliders only), `tests/dockColliders.test.ts`-style layout tests.
**Acceptance (scripted walks via `?walk=`; each must end on the expected floor, `__worldStats.walk.done=true`):**
- End wall: `walk=8,0,1.5,180;8,-2` stops at z ≈ 0.1 (feet y = 0, `reached` = 0). Repeat at the far end of the east
  room (`walk=8,0,22.5,0;8,27`) — no drop, feet y stays 0.
- Layout test: for every demo campus `n=1..12` and 200 random session sets, no spine-well rect intersects any door
  opening ± 0.7 m; add the `e′` repro camera (`cam=0.5,1.65,23.5,-35,8`) with a west room at entry bay 5 to a layout
  fixture and screenshot it.
- Factory: `walk=20,-6,10,-90;15,10` from a cell intake toward the spine stops at the first conveyor (feet x within
  0.4 m of the belt edge). Station and bench walks likewise.
- Control room: `walk=0,0,30,0;0,38` ends with feet y = 0.25 on the tier, not 0.
- Forecourt: `walk=0,-6,-20,180;0,-56` reaches z ≤ −55 (fence line).
- Entrance stair pitch ≤ 35°, going ≥ 0.27 (unit test on the computed flight); `21_walk_entr_stair` still reaches the
  reception with feet y = 0 at z = −6.3.
- Draw count unchanged ± 2 at the four reference cameras (colliders are invisible).

### WS3 — Geometry seams, scale and finish  (opus)
**Findings:** G6–G11, G13–G15, R2 (glass kerb), R13 (pendant rods, nosings), U3 (3D signs).
**Owns:** `engine/world/EntranceHall.ts` (all but `:1110-1125`), `engine/world/Building.ts`,
`engine/world/ProjectShell.ts`, `engine/world/FactoryHall.ts` (geometry; WS5 owns its material/light constants
`:157`, `:807-826`, `:1396-1401`), `engine/world/architecture.ts`, `engine/world/factory/Dock.ts` geometry
(`:425-700`; WS5 owns `:225-228`, `:1039-1050`), `engine/world/ControlRoomShell.ts`, `engine/world/Exterior.ts` ground
heights, new `engine/world/stairs.ts`. Lands after WS2 on shared files.
**Acceptance:**
- `cam=0,-4.35,-8,0,25` with the slider open: no ground visible at the threshold. `cam=6,-4.35,9,180,-50`
  (`23_soffit_zfight`) and `cam=12.2,1.65,-3.2,90,20` (`24_gallery_slit`): no shimmer, no daylight slit, no floor lip.
- From inside a room (`cam=5.5,1.65,8,90,3`) no shimmer line along the room front at the ceiling.
- `02_junction` re-shot: one threshold strip where the grating meets the slab; skirting visible at wall bases in
  01/04/05.
- Dock: wall flush with the factory north wall (`cam=0,-4.35,34,0,0`), no stray member in `dock_stair_view`.
- Wayfinding: signs readable at 6 m at the reception stair head ("Factory floor ↓ · Offices →"), hall end
  ("Control room"), each spine-well head ("Factory ↓") and factory stair feet ("Offices ↑ / Reception"); 1 draw each
  (merged into the LedPanel/DoorSign batch or a single atlas).
- `rectMinusHoles` has one implementation; stair flights/rails/ramp colliders come from `stairs.ts`; the four stale
  constants fixed; vitest green.
- Draw count at the four reference cameras not above WS4's targets (+ ≤ 6 for signs/thresholds).

### WS4 — Render budget and hot paths  (opus) — blocking
**Findings:** P1–P3, P7 (World/ActorHub/Player/ControlRoom dots), P8, P9, P11, D11, D13, R13 (impostor LOD).
**Owns:** `engine/world/World.ts`, `engine/fx/fxPlan.ts`, `engine/fx/GraphicsController.ts`, `engine/fx/Quality.ts`,
`engine/fx/PostFx.ts` pass composition (WS5 owns the tone-map/vignette/colour values `:350-410` — WS4 lands first),
`engine/fx/graphicsSettings.ts`, `engine/contracts.ts` (`QualitySetting` only), `app/world-debug/page.tsx`
(`parseParams` only), `components/world/WorldCanvas.tsx` (graphics subscriptions), `engine/world/ControlRoom.ts`
screen/redraw region (`:440-560`, `:1320-1345`, `:1860-1880`), `engine/world/factory/FactoryLines.ts` `stepPieces`,
`engine/world/factory/Workpieces.ts` (`:480-770`; WS5 owns `:452-474`), `engine/world/factory/workpiecePlacement.ts`,
`engine/logic/factoryMotion.ts`, `engine/characters/ActorHub.ts`, `engine/player/Player.ts`,
`engine/assets/AssetLibrary.ts` (part merging + per-room lookup), `engine/screens/FeedScheduler.ts`,
`engine/screens/canvasKit.ts` `whenFontsReady` only, `engine/world/ProjectRoom.ts` `getRenderList` only.
**Acceptance (SwiftShader draw counts via `shot.sh`, `__worldStats.draws`, high tier, `n=6&demoFactory=1`):**
- spawn `≤ 300` (was 375); hall end `cam=0,1.65,24,0,0` `≤ 350` (was 590); gallery `cam=1.5,1.65,-3,0,30` `≤ 320`
  (was 372); drum `cam=-2.5,1.65,29.5,35,5` `≤ 330` (was 353); **room interior `cam=5.5,1.65,8,90,3` `≤ 350`
  (was 658)**; drum look-back `cam=0,1.65,34,180,2` `≤ 350` (was 489); factory floor `cam=0,-4.35,-3,0,5` `≤ 280`
  (was 361, office meshes culled per P13); `postProcesses ≤ 12` at high, `≤ 6` at medium. Medium must be ≥ 25 %
  cheaper than high at the spawn view (today 369 vs 375).
- Control room near: `scene.textures` count stable and no `update()` on the lower wall canvases between clock ticks
  (instrument with a counter in a vitest of the key function; and `__worldStats` gains `screenUploads/s` ≤ 2 while idle).
- `__worldStats.factory.animMs ≤ 0.3` with 40 moving pieces and `bufferWrites.workpieces` ≤ 2 per frame while moving
  (was 440 over the capture); no per-frame `new Vector3` in `World.update`/`Player.update` (grep + a Chrome
  allocation sample noted in the PR).
- `quality=medium` accepted in world-debug; `__worldStats`/HUD report `medium` as its own tier; a `tierStep`
  round trip `high→medium→low→high` shows no stale shadow or dark materials (re-shoot `12_tier_roundtrip`; the
  luminance match against `25_high_220` is WS5's L1 criterion).
- Impostor blob not visible inside 15 m (`06_gallery_down` re-shot).

### WS5 — Materials, lighting and post  (opus)
**Findings:** R1–R11, P4–P6, P12, D12, P7 (Lighting part).
**Owns:** `engine/materials/Materials.ts`, `engine/assets/materials2.ts`, `engine/assets/manifest.ts`,
`engine/art/proceduralTextures.ts`, `engine/art/geometry.ts` (vertex AO in `ArtBatcher.add`),
`engine/world/exterior/textures.ts`, `engine/fx/Lighting.ts` (entire file), `engine/fx/PostFx.ts` values
(`:350-410`), `engine/screens/canvasKit.ts` materials (`:160-220`), `engine/world/LedPanel.ts` material,
`engine/world/BrandSign.ts:66`, material definitions in `Conveyors.ts:164-205`, `Stations.ts:178-221`,
`Workpieces.ts:452-474`, `Truck.ts:69-92`, `Dock.ts:225-228,1039-1050`, `ControlRoom.ts:600-615`,
`FactoryHall.ts:157,807-826,1396-1401`, `Exterior.ts` fog/sky setup, `scripts/fetch-materials.ts` (KTX2 + `.env`
generation), `public/assets/materials2`, `public/assets/hdri`. Lands after WS4 on `PostFx.ts`; after WS2/WS4 on
`ControlRoom.ts`; after WS3 on `FactoryHall.ts`/`Dock.ts`.
**Acceptance:**
- Reference set re-shot at high and medium: 01, 03, 05, 06, 14 (room), 15 (exterior), 16 + `dock_top` (dock), 08
  (slab underside). Reviewer checks: monitors show the room's reflection; glass fronts/strip show the ceiling lights;
  no metallic-grey plastics; furniture has a contact shadow; dock walls/floor show concrete/steel texture and the
  exposure holds detail in both the lit apron and the shaded platform; horizon seam gone; drum windows not clipped.
- Material audit test: every `PBRMaterial` in the scene has `metallic ∈ {0, 1}` unless whitelisted (brushed/galvanised
  ORM-driven); no `albedoColor` channel > 1 on textured surfaces.
- All non-animated materials are `isFrozen` after init (scene walk in a vitest with NullEngine): list of exceptions
  ≤ 8.
- Startup: no `HDRCubeTexture` construction (both IBLs are `.env`); resident texture memory at high ≤ 300 MB
  (`engine.getGlInfo`/`scene.textures` sizes summed in `__worldStats.textureMB`); first-frame time down ≥ 30 % on
  the shot pipeline (log `ready` timestamp).
- Low tier: lobby luminance at spawn within 15 % of high (compare mean pixel value of 01 vs 10).
- L1: `tierStep=low@40,high@110` at 220 frames matches a plain 220-frame high run (`25_high_220`) within 3 % mean
  luminance and shows the same static shadows; the first-run static map includes the entrance mullion casters.
- Draw count: + ≤ 12 vs WS4 targets at the four reference cameras.

### WS6 — Set dressing, people and the truck  (sonnet; opus for the truck model)
**Findings:** R4 (dressing + truck), R12.
**Owns (new files only):** `engine/world/dressing/reception.ts`, `hall.ts`, `factory.ts`, `dock.ts`, `index.ts`
(single call site added in `World.init` after `building` — one line, coordinated with WS4), new procedural props in
`engine/assets/proceduralProps.ts` (append-only: `fireExtinguisher`, `exitSign`, `cableTray`, `pallet`, `palletJack`,
`toolTrolley`, `bollard`, `stripCurtain`, `binIndustrial`, `visitorChair`), `engine/world/factory/Truck.ts` geometry
(`:95-340`; WS5 owns its materials), `engine/characters` cast seating hooks (`ActorHub.seat(...)` already exists —
feature-detect).
**Acceptance:**
- Re-shoot 01 (receptionist seated, visitor chairs, mat well, directory stand), 02/14 (extinguishers, exit signs,
  sockets), 09/18 (cable trays, trolleys, bins, signage along a lane), `dock_top` (pallets, jack, bollards, curtains,
  levellers, a truck with wheels/cab/trailer at real proportions, two operators in the drum).
- Every new prop is a thin-instanced `PropRole` or merged into an existing batch: + ≤ 20 draws total at the four
  reference cameras; no new materials beyond WS5's roles.

### WS7 — Controls, onboarding, wayfinding HUD and accessibility  (sonnet)
**Findings:** U1–U9 (except the 3D signs and LinePanel), U4 (StationPanel/PrPanel/legend), U7, U8 (HUD part).
**Owns:** `engine/input/bindings.ts`, `engine/input/Input.ts`, `components/world/hud/panels.ts`, `useHudKeys.ts`,
`Overlays.tsx` (after WS1's banner lands), new `ControlsCard.tsx`, `Minimap.tsx`, `TouchControls.tsx`,
`hud/factory/StationPanel.tsx`, `PrPanel.tsx`, `parts.tsx`, `hud/GlanceParts.tsx`, `hud/InspectPanel.tsx`,
`engine/world/RoomSign.ts` / `engine/screens/DoorSign.ts` (status palette + cost line), new
`engine/logic/statusPalette.ts`, `stores/worldUiStore.ts`, `components/world/WorldCanvas.tsx` (panel/lock
behaviour; WS4 owns the graphics subscriptions — WS4 lands first), `src/i18n/{en,es,pt-BR}.ts`, `glass.ts`,
`Keycap.tsx`, `engine/fx/graphicsSettings.ts` `headBob` default only (after WS4).
**Acceptance:**
- Pressing `A` with the pointer locked strafes and opens nothing (Playwright-free: unit test on `useHudKeys` with a
  synthetic `KeyboardEvent` + a `pointerLocked` flag).
- First load shows the controls card (`19_main_hud` re-shot); it is dismissable, persists, and reappears on
  pointer-lock loss until `H` is pressed once. Card content = §5.
- Minimap office layer shows stairs/lift; "Factory ↓" button calls `teleport({kind:"floor"})`; `LocationChip` shows
  "Level 1 · Offices" / "Ground · Factory · <project>" / "Ground · Dock".
- StationPanel run rows and LinePanel/PrPanel PR rows have `GithubLink`s; DoorSign shows cost + tokens; legend chip
  explains the CI palette; one palette module imported by RoomSign, DoorSign, opsCanvas, dockModel, Stations,
  Minimap (grep: no other hex status literals).
- `prefers-reduced-motion`: head bob, pulse, flicker off (unit test on the media-query hook); HUD text ≥ 12 px
  (stylelint/grep); touch labels via `t()`; no English literal in `components/world/**` (i18n test extended).
- Keyboard: Tab moves focus through HUD when the pointer is not locked; minimap rooms focusable + Enter teleports.
- `19_main_hud` re-shot at 1280×800 and 390×844 (portrait): no HUD element overlaps another (compass, key hints,
  Location chip, overview strip, touch controls); directory board legible from the spawn point.

### WS8 — Dead code, assets, docs and canvas i18n  (haiku; sonnet for the canvas `t()` plumbing)
**Findings:** C1–C5, U8 (canvas/logic strings), C4.
**Owns:** delete `engine/screens/ControlRoomWall.ts`, `engine/screens/wallModel.ts` (+ tests),
`app/actors-debug/actorsScene.ts` import swap, every zero-importer export in C2 (except `drawWayfinding`, which WS3
wires), `public/assets/textures/`, `hdri/canary_wharf_2k.hdr`, unreferenced `materials2/` sets (coordinate the list
with WS5 before deleting), `engine/screens/opsCanvas.ts` strings + `setData(t)`, `engine/logic/sessionInfo.ts`
labels, `engine/logic/projectInfo.ts` formatting, stale comments in C4, `docs/architecture/ARCHITECTURE.md`,
`docs/design/software-factory.md` status table, `Makefile`/`package.json` (`knip` target in `checkall`).
**Acceptance:** `knip`/`ts-prune` reports zero unused exports under `src/engine` and `src/components/world`;
repo `public/assets` shrinks ≥ 20 MB; ARCHITECTURE.md has a "3D world" section covering the module map, sync
pipeline, tiers, URL params and the screenshot/walk-test workflow; `make checkall` green; no visual change
(reference screenshots pixel-identical except the drum wall text when the locale changes).

### WS9 — Test coverage and perf gate  (sonnet)
**Findings:** C6, plus the measurement harness the other workstreams' acceptance criteria rely on.
**Owns (new files only):** `frontend/tests/contractsDrift.test.ts` (compare `contracts.ts` field names/enums with
`backend` JSON schema exported via a new `backend/tests/export_campus_schema.py`), `frontend/tests/useCampusWebSocket.test.ts`
(fake socket: reconnect, stale, close codes), `backend/tests/test_campus_bad_session.py`,
`frontend/tests/stalePrThreshold.test.ts`, `scripts/perf-gate.sh` (runs `shot.sh` at the four reference cameras +
`quality=low`/`gfx=medium`, parses `__worldStats`, fails over the per-camera budgets; `make perf-gate`),
`scripts/walk-gate.sh` (the WS2 walk list; fails if any walk ends on the wrong floor), `__worldStats` additions
documented in `world-debug/page.tsx` header (coordinate the two new fields `screenUploads`, `textureMB` with WS4/WS5).
**Acceptance:** all new tests green locally; `make perf-gate` and `make walk-gate` run under
`flock ~/.local/share/claude-office-shot/.heavy.lock` and print a table; CI job added (allowed to be manual/nightly
given SwiftShader cost).

### Dependency order

```
WS1 (data)  ─┐
WS2 (colliders) ─┬─► WS3 (geometry seams, signs) ─┐
WS4 (render budget) ─┬─► WS5 (materials/lighting) ─┼─► WS6 (dressing) 
                     └─► WS7 (HUD/controls)        │
WS8 (dead code/docs) — anytime, rebases last       │
WS9 (gates) — harness first (day 1), tests anytime ┘
```

WS1, WS2, WS4, WS8 and WS9's harness can start immediately and never share a file. WS3 waits for WS2 only on
`factoryLayout.ts`/`EntranceHall.ts`/`ControlRoom.ts`; WS5 waits for WS4 on `PostFx.ts` and for WS2/WS4 on
`ControlRoom.ts`; WS6 and WS7 land last because they add on top. Suggested commit cadence: one commit per acceptance
bullet; re-shoot the reference set after each workstream lands and keep the PNGs under `out/<ws>/`.

---

## 5. Controls card (for WS7)

```
MOVE   W A S D / arrows        LOOK   mouse (click the scene to capture · Esc releases)
RUN    Shift                   JUMP   Space
LOOK AT   F   inspect what the crosshair is on (session, PR, station, line, dock)
ENTER     ⏎   open the session you are looking at
CAMERA    V   first / third person      FLY   N (Shift+N lands)  ·  E / Ctrl up / down
MAP       M   office + factory levels, click to travel     OPS   B   control-room dashboard
PANELS    Tab sessions · G git · C chat · L events · T agents · O options · H help · P overview
UNSTUCK   hold R → reception
WHERE TO GO   Offices ↑ stairs or lift · Factory floor ↓ spine stairs · Control room at the hall end
```

---

## 6. Already good (do not re-flag)

MeshBatcher merges per material with frozen matrices; ShellModule thin-instances whole pod/bay prefabs; MonitorBatch
and ScreenHub (live planes only within 8 m with hysteresis); every screen redraws only on a content key and releases
its texture at far LOD; factory pools (conveyors 3 draws, stations 7, workpieces ≤ 8) with partial buffer updates and
allocation-free `factoryAnim`; zone/portal visibility at 5 Hz with a hide grace; G-buffer custom render list; sky,
probes and static shadows render once; GlowLayer included-only; dispose paths complete and HMR-safe; `syncDiff` is
O(n); metric world-space UV tiling with correct sRGB/linear flags, specular AA and horizon occlusion on every PBR
material; backend CI poller keeps last-good data with `stale`/`error`; timestamps and durations are unit-consistent
end to end; the tier step-down re-freeze fix (10ec624) is correct.
