# Brief for Cursor — Yamhill Racer

**Start here:** read `AGENTS.md` (repo root) completely, then this file. You don't need to read the rest of the code:
each piece below names the exact files and functions to open. The owner pastes one line such as
*"Read docs/agents/CURSOR.md and do piece TW-0a"*. Do only that piece, then stop.

## Your role and your limits
You do the **hands-on visual work**: town buildings, campus detail, street props, landmarks, round minimaps, and the
McMinnville speed work. The owner watches the result in the browser and iterates with you, so keep each change small and
visible. You are on a ~$20/month plan whose usage is **limited (check your plan; don't assume numbers)**, so:
- **Pieces are sized S / M / L** (S = under an hour, M = one sitting, L = split it). Each ends at a **committed, tested
  state**: if you run out of usage mid-piece, nothing is lost. Commit after every working step.
- **Don't read the code to "get oriented"** — `AGENTS.md` is the map. Open only the files named. Use search, not reading whole files.
- **Model choice:** a cheaper/faster model is fine for docs, test scripts, renames, colour/palette tweaks, small fixes.
  Use the strongest model only for: TW-0b (profiling decisions), TW-1a/1b (building generator), CD-1a (facade geometry).
- Never start a long job (tile download/build) yourself in the chat; those run on the owner's Mac as plain commands (not your job).

## Git (every piece)
- Branch from `main`, named after the piece in lower case: `git switch -c tw-0a main`.
- Commit identity: user name `Distractodog` and the GitHub **noreply** email the owner gives you
  (`git config user.name Distractodog`; `git config user.email <noreply email from the owner>`; repo-local only).
  Never use a personal name or email, in commits or files.
- **Never push `main`. Never push at all unless the owner says so.** Never force-push, rebase others' branches, or
  stash/reset another branch's work.
- Public repo: no personal names, emails, absolute local paths or secrets in any file or commit message.
- `CLAUDE.md` and `PLAN.md` are private, git-ignored; don't copy from them into committed files beyond what this brief says.
- Merging branches into `main` is **your job too** (you're the merger because Claude's usage is the tightest): when the owner says
  *"merge <branch>"*: `git switch main && git merge --no-ff <branch>`, run `npm run drive` (must pass, same numbers) and the
  piece's checks, report, and **wait for the owner's OK before any push**.

## Standard checks (named in "done when")
- **DRIVE** = `npm run drive` exits 0, 0 flips, no NaN, all race bots finish.
- **PAGEERR** = the game loads in headless Chrome with no `PAGE ERROR` (`node tools/shot.mjs out.png`). Needs the server: `python3 tools/serve.py 8173 game` then use `http://127.0.0.1:8173`.
- **STREAM** = `node tools/stream_test.mjs 1000` → 0 frames with no ground.
- **BENCH** = `node tools/bench.mjs` (you create it in TW-0a): median ms, % frames > 20 ms, triangles, draw calls at fixed spots.
- **SHOT** = `node tools/shot.mjs out.png x z surfaceClass cam` at the named spot; open the PNG and actually look.
- Browser tests launch Chrome from `/Applications/Google Chrome.app/...`; don't commit changes to that path.

## Baselines (headless Chrome, 2026-11-13; re-measure first)
McMinnville downtown ~2.3 M triangles, 18.3 ms median, ~25% slow frames. Sheridan 16.7 ms / 0% slow. Willamina 16.7 ms / 0%.
Campus 16.7 ms / 0%. STREAM at 1000 km/h: 0 frames with no ground. **Nothing you add may make these worse** (TW-0b should make McMinnville better).

## Waiting on others
- You own: `game/src/townbuild.js`, `townmodel.js`, `props.js`, `propsmodel.js`, `landmarks*.js`, `campus.js`, `campusmodel.js`, `campusprops.js`, `perf.js`, `tools/bench.mjs`, `minimap.js` (RM-6).
- **Claude owns** `tools/build_tiles.py`, `tools/roadnet.py`, `game/src/roads.js`, and everything under `game/assets/tiles/`. **Never edit these.** If you need a change there, write it in your report.
- **ChatGPT owns** `game/src/rim.js` (round-map wall) and the glider/challenge bug fixes in `glider.js` / `challenges.js`. Don't edit those files.
- Hooks you share with others in `game/src/world.js`: keep each hook to 1–3 lines calling your own new file. Order of hook edits: TW-0b → (Claude's RM-1b tile loader) → TW-1b → TW-3p → ChatGPT's RM-5. If your branch conflicts at merge time, re-do your hook on top of `main`.
- Wait for: **TW-1b waits for TW-0b merged** (it uses the merged-mesh technique and the benchmark). **TW-3p waits for TW-1b**. **TW-5 waits for Grok's `docs/research/landmarks-*.md`.** **CD-* pieces wait for Grok's `docs/research/campus-*.md` if it exists; otherwise use the satellite + comments in `campus.js`, and ask the owner for photos.** **RM-6 waits for Claude's RM-4** (the new tiles) for the final bake; the JS side can start earlier.
- Campus pieces **run one at a time** (they all edit `campus.js`).

## Pieces, in order

### TW-0a — benchmark script (S, cheap model)
- **Goal:** one command that measures speed at fixed spots so every later change is judged the same way.
- **Edit/create:** `tools/bench.mjs` (new). Copy the Chrome-launch + `window.game` pattern from `tools/stream_test.mjs` and `tools/shot.mjs` (read those two, ~40 lines). Don't touch game code.
- **Tasks:** for each spot [McMinnville downtown NE 3rd St, Sheridan Main St, Willamina Main St, campus Main Building]: `game.teleport(x, z)` (see `main.js` bottom for `window.game`; hold position until `game.world.loadedAt(x,z)` and `world.pendingTiles()===0`), camera mode fixed via `game.setCam(0)`, wait, then sample 20 s of `requestAnimationFrame` deltas. Print `renderer.info.render.{triangles,calls}`, median, p95, % over 20 ms. Choose the McMinnville spot by looking at screenshots until you're on a downtown street; **write all four spots (x, z, camera) at the top of the script**. Run it 3× and show the spread. Add a row for it in the `AGENTS.md` test table (one line).
- **Done when:** [ ] `node tools/bench.mjs` prints the table for 4 spots (paste output); [ ] three runs agree within ~1–2 ms median; [ ] spots documented in the script header; [ ] AGENTS.md test table has the row.
- **Budget:** n/a. **Pitfall:** hidden browser tabs run at ~12 fps — use headless Chrome as the other scripts do. Headless is slower than a real browser; compare before/after only.
- **Open question for owner:** none.

### TW-0b — profile McMinnville and fix its biggest cost (M, strongest model)
- **Goal:** McMinnville downtown runs **faster than today**. Target: median ≤ 16.7 ms and < 10% slow frames; at minimum 5 ms better or no worse than baseline with fewer draw calls.
- **Background:** most of McMinnville's cost is road strips (~1,400 strips per town tile, each its own mesh). Buildings are plain extruded OSM blocks.
- **Edit:** `game/src/world.js` (the per-tile mesh building: search for where `buildRoads`/`roadBatches` and buildings are called in `buildTile`-style code; the road mesh code is `game/src/roads.js` `buildRoads`, `roadBatches` — **Claude owns roads.js data logic, but merging the *meshes* is yours: do it in a new file `game/src/meshmerge.js`** and call it from world.js), new `game/src/perf.js` (optional `?perf` overlay).  **Leave alone:** physics, tile assets, `data.js`, campus files, `build_tiles.py`.
- **Tasks:**
  1. Cost breakdown at the McMinnville spot: hide each group (terrain, trees, buildings, road strips, junctions, water) via `game.scene` traversal and re-run BENCH; table of ms and draw calls per group. Commit the table as a comment in `perf.js` or in your report.
  2. Fix the biggest: typical fixes, in order: merge the road strips of a tile into **per-block merged meshes** (e.g. 250 m cells, one `BufferGeometry` per cell with a bounding sphere so off-screen cells are culled by three.js frustum culling); drop markings/points for far cells (distance LOD: swap to a simpler mesh past ~300 m); buildings as per-block merged meshes; shadows only within ~100 m. Do one change at a time and re-run BENCH after each.
  3. Stop when the next fix isn't worth it. List what you tried and its effect.
- **Done when:** [ ] cost table before/after; [ ] McMinnville median and slow-frame % better than baseline (BENCH output); [ ] Sheridan/Willamina/campus not worse; [ ] SHOT before/after identical-looking (look); [ ] DRIVE same numbers; PAGEERR clean; STREAM 0 frames with no ground; [ ] tile build time on STREAM not worse (no new hitch).
- **Budget:** fewer draw calls than today; no new per-frame allocation.
- **Pitfalls:** merged geometry must keep vertex colours and the existing road material (`groundMat`); don't merge across tiles (tiles unload); dispose geometries when a tile drops (look at how world.js disposes today); `data.js` physics must remain untouched.
- **Open question:** none.

### TW-1a — building rules (M, strongest model)
- **Goal:** pure rules that turn an OSM footprint into building parts, deterministic.
- **Create:** `game/src/townbuild.js` — **no three.js, no DOM** (Node tests import it). Export `planBuilding(footprint, context)` → `{kind, parts:[{pts, wallH, roof:{type,pitch}, colour, windows, doors, awnings, ...}], top}` and a `hash(x,z)` seeded RNG from the footprint centroid. Model the data shape on `game/src/campus.js` (read its header and `CAMPUS` entries, ~100 lines; mirror part fields so the same mesh builder logic applies) and `rectPts`/`inPoly` helpers there (import, don't copy). Also `tools/townbuild_test.mjs` (new): classifies a sample of real footprints from 3 tiles, prints counts by kind, checks determinism (same input → identical output), roofs inside walls, `top` consistent.
- **Classes/looks:** houses (~60–350 m²): gable or hip roof 20–35°, 1–2 storeys, Oregon house palette (greys, tans, sage, blue-grey, white trim), dark/brown/grey roofs, window row per storey, front door + small porch facing the nearest road (pass road polylines in `context`), attached garage on some. L-shaped/odd footprints: split into rectangles, else low hip or flat roof. Outbuildings < 40 m²: single storey, shed/gable, no windows. Commercial/downtown (> 600 m² or tagged retail/commercial or on main street): flat roof + parapet, brick/stucco colours, shop-window band + door on street side, awnings, 1–3 storeys. Warehouses > 1,500 m² away from downtown: metal-sided, low gable, roll-up doors. Schools, churches (steep gable + steeple), apartments (2–3 storeys).
- **Done when:** [ ] `node tools/townbuild_test.mjs` passes and prints class counts for McMinnville/Sheridan/Willamina tiles; [ ] determinism check passes; [ ] `top` for each building = roof height (used by physics later, TW-1b); [ ] no file in `game/` other than the new one changed.
- **Pitfall:** don't change collision data yet. Sheridan has few OSM buildings (TW-4 will add more) — the generator must cope with 0–225 per tile.
- **Open question for owner:** which look first, houses or downtown? **Default:** do both classes in this order: houses, then downtown, then the rest.

### TW-1b — building meshes + hook (M, strongest model)
- **Waits for:** TW-0b merged.
- **Create:** `game/src/townmodel.js`: `buildTownGeometry(planned, ground)` → one merged vertex-coloured `BufferGeometry` **per block** (200 m cells) for near LOD and a simplified one for far LOD. Mirror `campusmodel.js` `buildCampusGeometry` (read its 180 lines: window rows, doors, roofs, linear-colour conversion `srgb→linear` — vertex colours are linear!).
- **Edit:** `game/src/world.js`: where OSM building meshes are made, call your builder instead (hook ≤ 3 lines); `game/src/data.js` only if collision `top` changes — keep footprints identical, set `top` from `planBuilding(...).top`; **campus tiles:** skip footprints that `applyCampus` already replaced (`campusPart` flag). **Leave alone:** `campus.js`, `campusmodel.js`, vehicles, tile assets.
- **Tasks:** near LOD (windows, doors, porches) within ~300 m, far LOD past it; texture-painted windows if triangle counts demand it (small atlas/shader stripes on walls instead of window quads); generation sliced over frames like the rest of tile building (a few ms/frame, never one big hitch); buildings cast shadows only within ~100 m.
- **Done when:** [ ] SHOT before/after at street level and from the air in McMinnville NE 3rd St, Sheridan Main St, Willamina Main St (look at each); [ ] same building identical after reload; [ ] roofs don't poke outside walls (spot check 20 odd shapes); [ ] triangles per town tile reported before/after; [ ] DRIVE same numbers; STREAM 0 frames with no ground; PAGEERR clean; [ ] BENCH within budget at all 4 spots (McMinnville ≤ TW-0b result + 1 ms); [ ] **(owner)** do the towns look like towns?
- **Budget:** McMinnville frame time ≤ after-TW-0b + 1 ms; no hitch while a tile builds.

### TW-1c — LODs, shadow range, auto quality (S–M)
- **Edit:** `game/src/townmodel.js`, `perf.js`. **Tasks:** far-LOD tuning distances (300/900 m), shadow range, and an **auto quality fallback**: if the moving average frame time stays > 22 ms for 3 s, reduce near-LOD distance and shadow range one step (and restore when < 15 ms for 10 s); shown in the `?perf` readout.
- **Done when:** [ ] BENCH at all spots, before/after; [ ] fallback triggers when the page is throttled (use `Emulation.setCPUThrottlingRate` in a script) and recovers; [ ] PAGEERR clean.

### TW-3p — street props (M)
- **Waits for:** TW-1b merged; **and** Claude's TW-2a for road classes (if not yet merged, place props by `kind` asphalt + width only).
- **Create:** `game/src/props.js` (placement rules from `tile.json` `paths`/`junctions`, seeded), `game/src/propsmodel.js` (instanced meshes: street lights, power poles + lines, stop signs at junctions, mailboxes, some fence runs on lot edges). One draw call per prop type per tile (`InstancedMesh`), drawn only within ~250 m. **Leave alone:** road generation.
- **Done when:** [ ] SHOT each prop in the three towns; [ ] `renderer.info` draw calls: +1 per prop type per loaded tile only; [ ] props only within ~250 m; [ ] collisions: **default = drive-through (skipped)** unless the owner says solid; DRIVE same numbers; [ ] BENCH budget (≤ 0.5 ms in McMinnville), PAGEERR clean; [ ] **(owner)** looks right.
- **Open question for owner:** solid or drive-through? **Default: drive-through.**

### CD-1a — Main Building facade (M, strongest model; campus pieces run one at a time)
- **Goal:** the Main Building front reads as the real Art Deco brick building.
- **Edit:** `game/src/campus.js` (the Main Building entry in `CAMPUS`: front range, centre block, tower; read only that entry plus `partTop`, `applyCampus` signatures), `game/src/campusmodel.js` (`buildCampusGeometry`: add a bay/pier/spandrel generator). New `tools/…` none. **Leave alone:** everything else.
- **Tasks:** windows in vertical bays separated by brick piers, lighter stone spandrels + sills, stone coping line, stepped Art Deco tower top; far version (> ~250 m) = today's simple windows.
- **Done when:** [ ] SHOT front aerial, from the road, close-up (look; compare with the school's public photos if the owner provides, or Grok's notes); [ ] `node tools/campus_test.mjs` passes (geometry, collision tops); [ ] DRIVE same numbers; [ ] BENCH campus spot: 0 slow frames (measure with campus on/off); PAGEERR clean; [ ] **(owner)** looks right.
- **Pitfalls:** sRGB vs linear colours; a part whose wall lies exactly on another part's wall z-fights — end it at the other part's back face; heights are above `floorAt` ground; the north kitchen (48×11 m, 3.6 m walls) must stay separate.

### CD-1b — entrance, paths, flagpole, lamp posts (M)
- **Edit:** `campus.js`, `campusmodel.js`, new `game/src/campusprops.js` (instanced lamp posts, flagpole, benches). **Tasks:** stone surround, double doors, steps + cheeks, "THE DELPHIAN SCHOOL" lettering (low-poly letters or a small canvas texture), curved concrete walks + entrance plaza from the satellite (flat quads just above ground, polygon offset to avoid z-fighting, drivable). Steps/lamp posts: **default solid for steps/flagpole, lamp posts drive-through** unless the owner says otherwise.
- **Done when:** [ ] SHOT entrance close-up + plaza from above; [ ] `campus_test.mjs`, DRIVE pass; driving over the plaza at 50 and 200 km/h: no flip; [ ] BENCH, PAGEERR; [ ] **(owner)**.

### CD-1c — front lawn smoothing (S–M)
- **Goal:** remove the jagged ground "teeth" and the dark embankment wall hiding the entrance.
- **Approach:** a **game-side ground patch**: in `data.js` `makeTileData` the terrain is the height grid; you may flatten/smooth a rectangle in front of the entrance **without a tile rebuild** by adjusting heights at tile load (small function in a new file `game/src/campuspatch.js`, called from `applyCampus`; touches data.js by ≤ 3 lines; the ground mesh must use the same patched heights — check how `world.js` builds terrain from `H`). If that's not possible without a rebuild, **stop** and write the exact fix needed in `tools/roadnet.py` in your report for Claude's rebuild batch.
- **Done when:** [ ] SHOT from the road before/after; [ ] driving across at 50/200 km/h: no flip, no stuck; [ ] terrain mesh and physics agree (drop a car at 3 spots: wheels touch); [ ] DRIVE same numbers; [ ] **(owner)**.

### CD-2 — rest of the Main Building (M) · CD-3a — track, courts, parking paint (M) · CD-3b — campus props (M) · CD-4 — other buildings (M each) · CD-5 — missing buildings (S per building)
Same files and checks as CD-1 (one at a time, in this order). Specifics:
- **CD-2:** back + courtyard (tall arched chapel windows, loading dock, courtyard paving, fountain, planters, fire stair), west wing/parking side doors, rooftop vents/skylights/dark roof patch. Keep the kitchen separation. Needs the owner's courtyard/back photos (or Grok's R-1).
- **CD-3a:** track lanes/start lines/infield markings/goals; tennis courts, east-lawn basketball court, playground, archery range, RC car track, parking bays — **painted flat quads with polygon offset**, no ground-texture edits; surface class 7 (running track) must still drive right (DRIVE). No new kerbs (owner dislikes kerbs).
- **CD-3b:** instanced lamp posts along walks, benches, signs, fences, hedges, planted trees near buildings, one draw call per type per tile, within ~250 m.
- **CD-4:** Larson Hall/Heron Books HQ, Dragon Hall + Student Lounge, the building by the parking; staff houses (individual colours, porches, chimneys, varied roofs; reuse `townbuild.js` house rules if merged); barns/equestrian centre (big doors, trim, arena).
- **CD-5:** model each missing building the owner confirms (greenhouse/lath house, houses NE of the gym, equestrian arena, pond campground shelter, bus parking, ECDC/Lower School).
- **Done when (each):** [ ] SHOT before/after of each item; [ ] `campus_test.mjs` + DRIVE pass; [ ] BENCH campus 0 slow frames; PAGEERR clean; [ ] **(owner)**.
- **Open questions for owner (all CD):** which spots matter most (**default: Main Building front → courtyard → gym/track → staff houses**); photos (Main Building front/entrance, courtyard, back/kitchen, Larson, Dragon, gym entrance); what's missing; solid vs drive-through props (**default above**).

### TW-5 — landmarks (M per landmark; waits for Grok's `docs/research/landmarks-*.md`)
- **Create:** `game/src/landmarks.js` (data like `campus.js`), `game/src/landmarksmodel.js` (reuse `buildCampusGeometry` by import; don't edit campus files). Suppress the generated/OSM building under a landmark the way `applyCampus` does. Owner picks the first 3 (**default:** McMinnville Third Street downtown blocks, Evergreen museum, Sheridan grain elevator).
- **Done when:** per landmark: [ ] SHOT vs reference photo/satellite; [ ] collisions OK, DRIVE same; [ ] BENCH budget; [ ] **(owner)**.

### RM-6 — round minimaps (M; JS can start early, final bake waits for Claude's RM-4)
- **Edit:** `tools/build_minimap.py` (extent covers the circle centre (9000, −5000) radius 17.2 km ± border; picture ≤ ~2–3 MB; it already honours `YR_ASSETS`), `game/src/minimap.js` (`LABELS`: add Amity, Ballston, Perrydale…; round clip of the full map; draw the rim circle; corner-map rim line; `minimap.json` fields), `game/index.html` map CSS only if the frame becomes round. **Leave alone:** pin logic except coordinates.
- **Done when:** [ ] full map shows the whole circle, rim line, outside dark; zoom/pan/pin/labels work (script clicks, 0 page errors); [ ] corner map follows the car and shows the rim near it; [ ] SHOT of both maps; picture file size reported; [ ] **(owner)** sharpness.
- **Open question for owner:** sharper picture vs file size? **Default:** ≤ 5 m/px, ≤ 3 MB.

## Report back (send the owner this, filled in)
```
Piece: <ID>   Branch: <name>   Commits: <short hashes>
Changed files: <list>
Checklist: [x]/[ ] each item — evidence (command output or screenshot path); anything NOT verified: <say so>
Numbers: BENCH before → after (McMinnville, Sheridan, Willamina, campus); triangles/draw calls if relevant
For the owner to try / decide: <list>
Add to AGENTS.md: <new commands/files/conventions, or "nothing">
Left over / found while working (not fixed): <list>
Usage note: <did you hit limits? where did you stop?>
```
