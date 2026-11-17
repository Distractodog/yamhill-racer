# AGENTS.md — Yamhill Racer

Read this file first. It is written so you can work without reading the whole codebase. Your tool has its own brief in
`docs/agents/` (`CURSOR.md`, `CLAUDE.md`, `CHATGPT.md`, `GROK.md`; index: `docs/HANDOFF.md`) with your pieces, the exact
files to open, git rules and a report template; the owner points you at it and a piece ID.

## 1. The game

Yamhill Racer is a low-poly, open-world driving/flying game in the browser, set on the real Delphian School campus
(Sheridan, Oregon) and surrounding Yamhill County roads (Willamina → Sheridan → Bellevue → McMinnville, Hwy 18).
Vehicles: car, dirt bike, jet; a glider wing (key G) for the car and bike. Timed races with checkpoint arches, jump
ramps and invisible walls; a map with zoom and a pin.

- Live: https://distractodog.github.io/yamhill-racer/ (GitHub Pages) — repo: https://github.com/Distractodog/yamhill-racer
- Tech: **three.js 0.170 in the browser, plain ES modules, no bundler, no build step** for the game (`game/`).
  World data is baked offline by **Python tools** in `tools/` (virtualenv `.venv`, git-ignored). Tests are Node scripts
  using `puppeteer-core` and headless Chrome (`npm install` once).
- The map is a set of **2 km tiles** (51 today, ~384 MB of assets). The project owner does not write code; everything
  is done by agents. Handling feel and "does it look right" are judged by the owner's playtests, not by you.

### Run it
```bash
npm install                              # once (puppeteer-core, three)
python3 tools/serve.py 8173 game         # no-cache static server for game/  -> http://127.0.0.1:8173
```
(`tools/serve.py [port] [root]`; root defaults to the current directory, so pass `game` or run it from `game/`.
Use `127.0.0.1`, not `localhost`: `localhost` can serve stale cached files.) Any static server works, but this one
sends `Cache-Control: no-store` so edits always load.

### Tests (all must keep passing; none needs a build)
| Command | Needs server? | What it checks |
|---|---|---|
| `npm run drive` (= `node tools/drive.mjs`) | no | Headless physics on the real world data (no rendering). Sections: accel, turn, slalom, drift, drop, hills, slope, water, **ramps**, **walls**, **glider**, **bike**, **jet**, **bikeglider**, and race bots finishing every race. Prints numbers; look for 0 flips, no NaN, bots finish. |
| `node tools/drive.mjs <section>` | no | One section only, e.g. `walls`, `ramps`, `glider`, `bike`, `bikeglider`, `jet`. `V=1` prints per-step numbers; `TUNE='{"grip":1.6}'` tries settings; `NO_CAMPUS=1` runs without campus buildings. |
| `node tools/wet_grip_test.mjs` | no | All car/bike types: dry/half-wet/wet corners at 100/200 km/h, braking, straight stability, surface classes, aircraft runway isolation, 75 s drying and host moisture follow. Run through the heavy gate. `tools/wet_grip_shots.mjs --out <dir>` (server needed): dry/rain/drying views, help notes, frame times and page errors; review PNGs. |
| `node tools/water_test.mjs [words]` | no | Car + bike into a campus pond and the South Yamhill at 30/80/150 km/h, sitting/driving out of shallow water, drop-in, glider splashdown, a flat test pool: every run really enters the water; no NaN, oscillation < 0.1 m over ≥ 1.5 s of settled samples, deep → back on a dry bank, above skimSpeed tyres plane ≥ 0.5 s, glider closes as 'water'. `V=1` prints timelines. |
| `node tools/water_shots.mjs --out <dir>` (`--sites` = no browser) | yes | Car + bike into the same pond and river in the real game: screenshots of entry spray, floating, sinking, bank respawn, skimming, wading, with HUD text, frame times and page errors; requires visual review. |
| `node tools/campus_test.mjs` | no | Campus building geometry, collision heights, road clearance, road colours. |
| `node tools/roof_test.mjs [words]` (`--v`, `--trace=<s>`, `--src=<dir>/game/src`) | no | Car, bike, fighter/prop and helicopter on real roofs (McMinnville flat + pitched houses, campus Gym/Barn/Heron/Main, Space Museum): landing, resting, edges, roof-to-roof jump, driving off, steep slide, low pass. Reference = the drawn building meshes ray-cast from above: contacts within 5 cm, no NaN, no > 2 m step, never inside a building. ~1 min, 3 tiles: use the heavy gate. `node tools/roof_landing_test.mjs`: flat-world unit checks. `node tools/roof_rules_test.mjs`: aircraft ledge rules on made-up worlds (roof edges only; terrain step, ramp side, ramp jump and bridge-deck edge keep the old behaviour; helicopter slide-off direction independent of position). |
| `node tools/roof_shots.mjs --out <dir>` | yes | Car parked on a flat roof, car on a pitched roof, helicopter landed on a roof, car jumping roof to roof: screenshots + state checks (wheels on the drawn roof, chase camera above the roof); requires visual review. |
| `node tools/air_brake_test.mjs` / `node tools/air_brake_shots.mjs --out <dir>` | shots only | Fixed-wing air-brake deceleration, stall margin, spoiler landing roll, moving model panels and multiplayer flag; browser shots require visual review. |
| `node tools/jet_camera_test.mjs`, `jet_boundary_test.mjs`, `jet_wreck_test.mjs` | no | Jet camera follow at 600–1750 km/h, flight at tile/map edges, crash tumble + respawn. |
| `node tools/stream_test.mjs [km/h]` | yes | Flies across the whole map at speed (default 1000); counts frames **with no ground under the car** (must be 0), frames drawn with a road block's near level missing within its drawing distance (must be 0; `roadnear.js`), road near levels built at once, and slow frames. Exits 1 on a failure. Headless Chrome is slower than real browsers: ~8–12% slow frames is normal. |
| `node tools/fly_lag_test.mjs [--before <url>] [--full] [--only w1,w2] [--out f.json]` | yes | Fighter / stealth flown along straight lines, 360° circles and S-turns (5 g) at 600 / 1000 / top speed (`--full`: both jets at every speed), 150 and 800 m up, over McMinnville, Sheridan, forest, farmland; per run median / p95 / worst frame (each frame's interval with its own timings), % over 33 ms, what ran in the slow frames (render, tile build steps, road near levels, shadows, minimap, GC), triangles, draw calls, road near levels built at once and frames with one late (must be 0); before → after table with `--before` (a second server on the old code), also for one run. `--only`: comma-separated words every picked run's name contains. The default list includes the stealth at top speed (2170 km/h) 150 m up. Fails on page errors, frames with no ground under the jet, late road levels, or a flight that did not complete. Use the heavy gate. |
| `node tools/fly_lag_sim.mjs [--src <dir>/game/src] [--out f.json]` / `--compare a.json b.json` | no | The same flights through the real tile streaming in Node (stub renderer): per-frame main-thread ms of `updateLOD` + `updateShadows`, build-step labels, tiles built / dropped / built again, frames with no ground, road near levels built (at once / late: must be 0), an estimate of what the camera draws. `--stream` = stream_test's run. Heavy gate (`--expose-gc --max-old-space-size=8192`). `node tools/stream_plan_test.mjs`: unit checks of `streamplan.js`. |
| `node tools/map_lag_test.mjs [--before <url>] [--scale 5] [--only pan,pinch] [--out dir] [--dpr 2] [--scenarios spawn,game]` | yes | `--dpr 2` = a Retina screen. `spawn`: a fresh load, the same gestures on the "Where do you want to start?" map the moment it shows (game still starting), and how long it took to show. `game`: the full map (M) in the real game: 20 wheel notches in / out, a 5 s drag at zoom 1.6 / 4 / 30 / 200, trackpad pinch at zoom 4 / 60 (gestures in `tools/lib/maplag.mjs`); per gesture frame interval median / p95 / worst, % over 16.7 ms, map main-thread ms (update + handlers) and the whole frame's, what ran (big drawImage, paths, createImageBitmap), main-thread long tasks (> 50 ms) and frames over 20 ms per gesture (target: none at DPR 2). Then still views at zoom 1 / 40 / 164 saved as PNG; with `--before` compared pixel by pixel (car masked), FAIL if > 2 % of pixels are off by > 32. Use the heavy gate. `tools/map_lag_bench.html` runs the same gestures on the map alone (`argus browse`, results as console warnings; `?dpr=2`). |
| `node tools/mapmip_test.mjs` | no | Map picture levels (½ ¼ ⅛ tiles from `mapimageworker.js`: cover once, which level per zoom, zoomed out never the 9600² original, only tiles in view), missing patches in one worker job with the ½ copy under them, `load:false` requests nothing, worker failure fallbacks; `mapview.js` still/moving and the moved old drawing; `minimapdetail.js` `load:false`; levels ready promise, no first upload / original mid-gesture, level warm-up; eased zoom, wheel kinds, quiet timer. `node tools/map_gesture_test.mjs`: the real `minimap.js` under a fake DOM (eased notch around the cursor, ratio 1 while moving then sharp, drag exact through the switch, pinch at once). Also `mapimage_test.mjs`, `minimap_detail_test.mjs`, `mapdetail_test.mjs`. |
| `node tools/road_near_test.mjs` | no | `roadnear.js` rules and scheduler, and on real tiles a road near level built later is identical to the one built with the tile. |
| `node tools/visual_parity_shots.mjs --out <dir> [--before <url>] [--only w]` | yes | Before / after screenshots from fixed camera poses (a table: position above the ground, heading, pitch, field of view) after the car at 150 km/h on McMinnville NE 3rd St and a forest track, or the fighter at 150 / 800 m over forest and McMinnville, has been driven / flown there and stopped (vehicle and its effects hidden, clock fixed); midday, dusk, misty morning; compared in the browser (% pixels differing, `<shot>.diff.png`); also road levels built at once / late. Fails on page errors, late road levels, unfinished runs, pairs differing in > `--tolerance` % (0.05). Heavy gate; review the PNGs. |
| `node tools/glider_stuck_test.mjs --out /tmp/yr-glider-stress` | yes | BUG-1 bank recovery: 50 car + 50 bike browser trials, repeated/layout keys, CPU throttle and frame stalls; JSON samples and nonzero exit on failed/incomplete coverage. `--runs N` is per vehicle; `--workers 1` reduces load. |
| `node tools/glider_race_test.mjs --node` (omit `--node` for browser) | browser only | Race glider refusal, preexisting wing cancellation, corridor containment and free roam. |
| `node tools/jet_visual_test.mjs --out <dir>` | yes | Jet takeoff, speed passes, bank, stall, landing, crash/respawn screenshots and measured frame times; requires visual review. |
| `node tools/rim_test.mjs` | no | Optional circular boundary for all vehicles, safe respawns, challenge interplay and Node cost benchmark. |
| `node tools/rimring_test.mjs` / `node tools/rimring_visual_test.mjs <dir>` | visual only | Optional ring geometry/fade/disposal; browser distance screenshots and performance comparison. |
| `node tools/ghost_test.mjs` / `node tools/ghost_visual_test.mjs <dir>` | visual only | Ghost recording, replay, storage, challenge lifecycle; browser appearance/performance evidence. |
| `node tools/checkpoint_respawn_test.mjs --node` (omit `--node` for browser) | browser only | Checkpoint R reset, wrong-way hint, jet/free-roam preservation and stale-load cancellation. |
| `python tools/footprints_test.py` / `python tools/fetch_buildings_test.py` | no | Supplementary footprint merge and clipping/provenance checks; requires numpy, shapely, pillow. |
| `node tools/wheel_colour_test.mjs` | no | Clean saved Garage wheel colour on every car/bike type: load, warm-up, cached type changes, vehicle switches, resets, previews and remote models; checks rims, spokes, spare wheels, every wheel-style disc and spinning-rim blur (local and batched remote paint, wet/wash, mixed players). `tools/wheel_colour_preview.html[?speed=0][&remote]`: offline visual sheet plus the real speed-unit CSS. |
| `node tools/vehicle_types_test.mjs` | no | Car/bike type acceleration and top speed, campus/gravel routes, finite states and zero flips; model, paint, tuning and storage checks. |
| `node tools/road_spawn_test.mjs` | no | Real-tile road placement for ground vehicle switches, right lane and heading, stationary settling, Garage changes and unloaded-road hold. Use the heavy gate. |
| `node tools/vehicle_switch_test.mjs` / `node tools/vehicle_switch_matrix.mjs` | matrix only | Fast Node regressions for Garage activation, picker policy and V during H loading; browser switch matrix across saved aircraft, respawns, races, menu, roofs, water and multiplayer (requires a game server and relay; run through the heavy gate). |
| `node tools/wheel_clip_test.mjs` | no | All car/bike types and remote puppets: drawn tyre bounds below arch limits at 0–1000 km/h, braking and ramp landings; drawing preserves physics state. Run through the heavy gate. |
| `node tools/body_clip_test.mjs [types] [flat\|hwy\|ramp]` | no | Every car/bike type's drawn body (all faces, both LOD levels, rider) never under `heightAt`: flat asphalt (steady, slalom, braking, standing start), Hwy 18 Sheridan→Bellevue crests/dips and whole road, the Hwy 18 ramp, at 100/300/600/1000 km/h; bikes' drawn tyres within 1.5 cm of the road; the guard (`bodyclearance.js`) on a pitched car on 0.2/0.4 slopes; prints the physics chassis (ground box) and car tyres too. `REPORT=1` prints without failing. Run through the heavy gate (several minutes). |
| `node tools/vehicle_types_shots.mjs --out <dir>` | yes | Every type in Garage and driving, reload persistence, page errors and frame samples; review PNGs. |
| `node tools/vehicles_test.mjs <dir>` | yes | V picker mid-race, bike race, jet ring race, crash + respawn; writes screenshots to `<dir>`. |
| `node tools/picker_test.mjs` | no | V picker logic: stat bars, `vehicles.choose` (ground, in flight, helicopter slot, refused, respawn hold), thumbnail paint. |
| `node tools/picker_shots.mjs --out <dir>` | yes | V picker in the game: pictures, keyboard / mouse / menu / number keys, close paths, single-player pause, types locked in a race, focus never left on the ☰ Menu, in-flight type swap, small screen; review PNGs. `tools/picker_preview.html` shows it without the game. |
| `node tools/medals_test.mjs` / `node tools/race_presentation_test.mjs` | no | Medal rules, `yr-medals-1` storage, every race's targets from its bot time (top-speed races: the race car's time); finish screen (medal, personal best, Next race) and race menu gating on a DOM shim. |
| `node tools/race_fast_time.mjs <race id> [capKmh] [v]` | no | The walls bot without its 260 km/h cap on one race (only that route's tiles): the race car's real pace, for `challenge_routes.py` `FAST_TIMES` (top-speed races' medals). Seconds. |
| `node tools/racemenu_shots.mjs --out <dir>` | yes | J race menu cards / filters / keys / mouse, finish screen with a medal, start ring in free roam opening its card; review PNGs. |
| `node tools/welcome_test.mjs <dir>` | yes | Welcome card shows, blocks game keys, closes with button/Enter/Esc/Space, "don't show again". |
| `node tools/shot.mjs out.png [x z surfaceClass cam]` | yes | One headless screenshot at a spot (also prints fps). Use it to **look** at your work. |
| `node tools/lights_test.mjs` / `node tools/lights_shots.mjs <dir>` | screenshots only | Vehicle light logic/anchors, every type's lit lenses on its drawn lamps (ray-cast), the low-beam shape (`lights.js` patches three's spot cone: road even ~5–25 m, gone by 60 m, cut-off above the lamps); director night views and McMinnville night A/B/A benchmark (use heavy gate). |
| `node tools/headlight_shots.mjs --out <dir> [--only race,dirt] [--no-bench]` | yes | Night, every car / bike type and the landing-light aircraft parked on a McMinnville road: from behind, front 3/4 of the lamps, low side view of the beam; no new shader programs over type switches; A/B/A beam cost (≤ 1 ms). Heavy gate; review the PNGs. |
| `node tools/daynight_test.mjs` / `node tools/daynight_shots.mjs --out <dir> [--speed 60]` | shots only | Day/night cycle + random rain (`daycycle.js`, `atmosphere.js`): 50-min clock and phases, keyframe looks and smooth blending, sun/moon/light paths, headlights at dusk, seeded shower scheduler, multiplayer follow, saved settings + migration, per-frame cost. Shots (heavy gate): starts at morning; morning, midday, golden hour, dusk, night, rain; Settings section; ☰ Menu without Atmosphere; one cycle at `?daySpeed` checking no new shader programs; review PNGs. |
| `node tools/wind_test.mjs` / `node tools/wind_shots.mjs --out <dir>` | shots only | Seeded wind, altitude/strength bounds, thermal field/weather/race exclusions, real aircraft drift and ground isolation, multiplayer seed/clock; `wind_test.mjs --real` checks four real tiles (heavy gate). Shots (heavy gate): sunny gliders/props/helicopter with birds + HUD, rain/night, disabled wind, race calm; review PNGs. |
| `node tools/engine_sound_test.mjs` | no | Engine sounds on a fake AudioContext: every type's gears / rpm (shift points, no hunting, revs on the spot / in the air / wheelspin), loop crossfade and pitch, the loop files (format, size), lazy loading and buffers shared by every voice, volume sliders (saved, buses), shift clunk + dip, crackle, turbo, jet afterburner, propeller beat, helicopter, per-frame cost. `node tools/sound_check.mjs [--out dir]` (server needed): each type in the browser, logs which loops loaded, their sizes and errors, and a Settings → Sound screenshot. |
| `node tools/graphics_unit_test.mjs` / `node tools/graphics_test.mjs --out <dir> [--seconds 15] [--dpr 2] [--only campus] [--no-auto]` | test only | Settings → Graphics: levels (High = the game before the setting), Auto's guess and measured pick, fps meter, saved `yr-graphics-2`, applying a level to renderer / sun / camera / fog / world / effects, particle cap, prop radius, the Settings section on a stand-in DOM. Browser (heavy gate): the same drive at campus and McMinnville at Low / Medium / High switched in the running game: median / p95 frame ms, triangles, calls, switch cost (new shader programs), start + end screenshots, the Settings section, Auto on a fresh browser; review the PNGs. `tools/graphics_settings_preview.html` shows the section without the game. |
| `node --max-old-space-size=1024 tools/world_features_test.mjs` | no | Builds one real campus tile through `world.js` with a stub renderer: terrain seam geometry, water mesh, tree-break attachment/warm-up, Low/Medium/High detail, night uniform and placed surfaces together. Use the heavy gate; does not validate GPU rendering. |
| `node tools/bench.mjs` | yes | 20 s at four fixed spots (McMinnville NE 3rd, Sheridan Main, Willamina Main, campus Main Building). Prints triangles, draw calls, median and p95 frame time, and % of frames over 20 ms. |

Browser tests launch Chrome at `/Applications/Google Chrome.app/...` (macOS); edit the `executablePath` at the top
of a script if your machine differs (keep that edit out of unrelated commits).

### Deploy
Push to `main` → `.github/workflows/pages.yml` publishes the `game/` folder to GitHub Pages. **A push goes live.**
Browsers cache files ~10 min, so a hard refresh may be needed to see a change.

## 2. Architecture map

Everything the browser loads is in `game/` (`index.html`, `src/*.js`, `assets/`). World space: **metres, x east,
z south, y up**, origin = centre of the original satellite image (the campus area). Tile (tx,tz) covers
x∈[tx·2000−1000, tx·2000+1000], z likewise.

### `game/src` (browser, ES modules)
| File | What it does / key exports / who uses it |
|---|---|
| `main.js` | Entry point. Creates renderer, camera, input (`keys` set of physical `e.code`s + `letters` map for AZERTY/Dvorak), HUD, tuning panel; owns the frame loop: fixed **120 Hz** physics loop (`while (acc >= STEP) { car.step(...); challenges.constrain(); }`), then `challenges.update`, camera (`updateCamera`, `updateJetCamera`), world streaming (`world.updateLOD`, `updateShadows`), effects, audio. Functions: `readInput`, `goHome`, `flipUpright`, `frame`. Sets `window.game`. Calls everything else. |
| `world.js` | `loadWorld(renderer, onProgress)`: **streams tiles** (loads within ~1.3 km of the camera, plus look-ahead points up to 5 s / 1.2 km ahead at speed, following the turn being flown; beyond 2.6 km tiles are hidden and kept, up to 12 built tiles, dropped past 4.6 km; the rules are in `streamplan.js`). Builds meshes per tile in small time slices (5 ms a frame driving; ~4 ms above ~250 km/h unless ground near the camera is missing): terrain chunks with 4 distance detail levels (`updateLOD`: <420 m, <850, <1500, else, by true distance from the camera, so a high jet sees far detail), trees (2 levels, instanced), buildings (extruded OSM footprints, plain grey), road strips (near level only once the camera comes near: `roadnear.js`), junctions, ponds (water shader), campus meshes. `pendingTiles()` / `loadedTiles()`. Returns the object from `makeWorld` (data.js) plus rendering helpers. `SURFACES` names the surface classes. Used by main.js. |
| `roadnear.js` | Road blocks' near level (markings, all samples: ~2/3 of the road build) built only when the camera will come within its drawing distance: with the tile if within show + 250 m of the camera's next 10 s at its velocity, else later in budget slices (due ones first), or at once in the frame it would be drawn (never late). A jet ~900 m up builds none. Tested by `tools/road_near_test.mjs`. |
| `streamplan.js` | Pure tile-streaming rules for world.js: `lookAhead` (along the turn: velocity + turn rate from `createTurnTracker`), `needDist` (load / build order), `urgentDist` (missing ground near the camera: full budget), `buildBudget` (ms per frame), `planKeep` (show / keep hidden / drop). Tested by `tools/stream_plan_test.mjs`. |
| `data.js` | **Pure world data and queries, no rendering** (so the headless tests use it). `makeTileData(W, tx, tz, {hbuf,sbuf,tbuf,pbuf,tile})` builds one tile's queryable data (terrain heights, surface raster, trees, buildings, road strips, ponds, spatial grids) and calls `applyCampus`. `makeWorld(W)` routes queries to the tile under the point: `heightAt`, `terrainAt`, `groundAt`, `surfaceAt`, `normalAt`, `waterLevelAt`, `treesNear`, `buildingsNear`, `rampAt`, `setRamps` (challenge ramps), `setFixedRamps` (map ramps), `loadedAt`, `has`, `add`/`remove` tile, `placeOn`, `extent`, `mapContains`. Also `PATH_KINDS` (asphalt→surface 3, gravel→4, trail→2), `RAMP` shape, `prepRoad` (strip samples every ≤1.5 m with left normals, baked heights and cross slopes), `trunkRadius`. Used by every vehicle, world.js, tests. |
| `vehicle.js` | Base class `Vehicle` + `activeProxy`. The **vehicle interface** (see section 4). |
| `roofs.js` | Roofs as solid, **drawn** surfaces: every vehicle's `world` is `createVehicleWorld(world, vehicle)`, whose `heightAt/surfaceAt/normalAt` add the roof under a point when the vehicle comes from above (flat, gable/hip faces as drawn, rooftop boxes, porch canopies; town buildings planned by `townbuild.js` exactly like the mesh). `collideBuilding` = walls up to the drawn roof (+ walls between a building's blocks; parapets solid from both sides: a stop, never a ramp); `onRoof()` (no respawn spots on roofs), `roofUnder()` (camera clamp), `roofGrip()` (roofs > 25° slip), `roofLedge()` (aircraft ledge rules, roof edges only). |
| `vehicles.js` | The garage: `createVehicles` builds car/bike/jet, `switchTo`, `choose(kind, type)` (type + switch in one go), `player` proxy that always points at the current vehicle; reads the V picker's keys. `VEHICLES`, `vehicleInfo`. |
| `vehiclepicker.js` (+ `.css`), `vehiclethumbs.js`, `vehiclestats.js` | The V picker (also ☰ Menu → Vehicles): Car/Bike/Aircraft cards and a type row with pictures drawn offscreen in idle time with the real models in the player's paint (cached, redrawn on a paint change), 1–5 stat bars from the type numbers. |
| `car.js` | `Car extends Vehicle`: arcade car on the heightfield (4 suspension rays, yaw-rate steering, grip alignment, drifts, handbrake, water skimming). `TUNING_DEFAULTS` (top speed 1000 km/h, accel 30, brakes 60, gravity 24). Keeps its own older copies of collision helpers so its handling is unchanged — don't "deduplicate" them. |
| `carmodel.js` | The race car mesh (`buildCarModel`, built in `models/racecar.js`: modern open-wheeler, near/far LOD, suspension arms that follow the wheels via `userData.linkage`) and `WHEEL_POS` (also the physics' wheel layout). Checks: `node tools/racecar_model_test.mjs`. |
| `bike.js` | `Bike`: dirt bike (two suspension rays, yaw+pitch body, auto-balanced lean, wheelies, stoppies, bail on bad landing). `BIKE` tuning, `buildBikeModel`. |
| `water.js` | Water for the car and bike (ponds and rivers alike): tyres ride the bed, planing lift ∝ speed² (skims above `skimSpeed`), wading drag, a buoyant body that floods nose-first and sinks; `nearestBank` respawn after ~3 s fully under. Pure physics (world queries only). |
| `jet.js` | `Jet`: ground mode (3 wheels) and flight (lift/drag, stall, landing/crash, wreck tumble 4.5 s then respawn). `JET` tuning, `buildJetModel`. Top ~1733 km/h. No glider. |
| `glider.js` | `Glider` (G key) for car and bike: when open, the vehicle's `step` hands over to `vehicle.glide.step`. `GLIDER` + `BIKE_GLIDER` tuning, `buildGliderModel`. Vehicle hooks used if present: `wheelReach()`, `afterGlide()`, `bail()`. |
| `challenges.js` | Timed races: countdown, start/checkpoint/finish arches, timer + splits HUD, finish screen (time, medal, personal best, splits, Race again / Next race), best times (localStorage). Reads `assets/challenges.json`. Fixed map ramps (`assets/ramps.json`) are created here too. `createChallenges`, `fmtTime`. `constrain()` (after every physics step) applies walls. |
| `racemenu.js` (+ `.css`), `racemarkers.js`, `medals.js` | The J race menu (V picker style: a card per race with its route drawn on the map picture, distance, vehicle, ramps, best + medal; Car / Bike / Aircraft / All tabs; Start; "Invite players" in multiplayer via `mp/races.js`). Glowing start rings in free roam (drive in under 30 km/h → that race's card). Medal logic: gold / silver / bronze targets per race (`challenges.json` `medals`, from the race bot's time) and the best medal saved per browser. `tools/racemenu_preview.html` shows the menu without the game. |
| `track.js` | `makeTrack(points)`: invisible walls for a race (centre line every ~4 m + half-width, from `challenges.json` `track`). No rendering. |
| `roads.js` | Meshes for road/trail strips and junction pieces: `buildRoads`, `buildJunctions`, `roadBatches` (slices work across frames), `campusRoad` (school drives are asphalt without yellow lines). No kerbs (owner's choice). |
| `campus.js` | **Hand-authored Delphian campus buildings** as data (parts: footprint, wall height, colours, roof type/pitch, window rows, doors, porches, boxes). `CAMPUS`, `applyCampus(td)` (called by `makeTileData`): swaps OSM blocks under campus footprints for campus physics footprints `{pts, top, campusPart}`. No three.js. Colours sRGB; heights above `floorAt` ground. |
| `campusmodel.js` | `buildCampusGeometry(b, ground)`: flat-shaded vertex-coloured mesh per campus building (one merged mesh named `campus` per tile). Vertex colours are **linear** — it converts from sRGB. |
| `minimap.js` | Corner map + full map (M), zoom/pan, labels, route lines, pin (`minimap.pin`, `setPin`, `onPin`). Picture is `assets/minimap.jpg` (+ `minimap.json`), baked by `tools/build_minimap.py`; drawn by `mapimage.js` (zoomed out from ½ ¼ ⅛ copies, zoomed in from 512 px patches, both cut in `mapimageworker.js`). The picture and its levels are preloaded (`preloadMinimap`, before the world loads) and the spawn map waits for the levels. While the full map is zoomed / dragged only the picture is drawn, at pixel ratio 1, plus the last still roads layer moved (`mapview.js`); detail is redrawn sharp / requested 150 ms after it stops. Wheel notches and + − ease (~120 ms) around the cursor; trackpad pinch applies at once. `minimap.busy` (a gesture or input in the last 300 ms): `main.js` pauses world building and the vehicle warm-up, street detail parsing waits. While the full map is open `main.js` does not render the 3D view (it holds its last frame), except mid-game in multiplayer: ~4 times a second, not while busy (`mapview.js` `draw3D`). |
| `pin.js` | `createPinGuide`: ribbon toward the pin, beacon, top-of-screen arrow + distance, "You made it". |
| `effects.js` | `Effects`: tyre marks, dust/smoke particles, splashes, contact shadows. |
| `audio.js` | `CarAudio` (your vehicle; `mp/remotes.js` gives the 4 nearest other players one each): engine via `audio/engines.js`, plus synthesised tyre/gravel/wind/impact; `setVolumes`, `engineBus`. |
| `audio/engines.js`, `audio/engineloops.js`, `audio/mixer.js` | Engine sound per vehicle type: `ENGINES` profiles (idle/redline, gearbox, shift dip + clunk, lift-off crackle, turbo), `stepEngine` (speed → gear → rpm), loops (`engineloops.js`, generated by `tools/make_engine_sounds.py`) loaded on first use per type, decoded once per audio context and shared; jets / helicopter / propeller synthesised. `mixer.js`: Master / Engines / Effects buses + saved levels (Settings → Sound). |
| `atmosphere.js`, `daycycle.js` | Light, sky, fog, stars, sun/moon discs and rain. `daycycle.js` (pure, no three.js) holds every cycle constant (morning 5 → day 20 → dusk 5 → night 20 min), the preset looks, keyframe blending, sun/moon arcs, the shower scheduler and multiplayer follow; `atmosphere.js` applies it each frame (values only: no lights, fog type or meshes added). `?daySpeed=60` runs the clock 60× faster. Settings → Time of day & weather. |
| `graphics.js`, `graphicsapply.js`, `graphicsui.js` | Settings → Graphics: Auto (default) / Low / Medium / High. `graphics.js` (pure): each level's numbers, `hardwareGuess` (cores, phone), `autoPick` from ~5 s of measured play, `createFpsMeter`, saved `yr-graphics-2`. `graphicsapply.js` `createGraphics`: pixel ratio, sun shadows + map size, camera far, fog (scaled every frame after the atmosphere), `world.setDetail` (load radius, terrain / tree / town / campus / prop / scenery distances, still water), `effects.setCaps` and `vehicleLights.setDetail` (Low: shorter, slightly dimmer headlight beam, never removed), all in one call; `frame(dt, playing)` measures Auto. `graphicsui.js`: the Settings buttons. `window.game.graphics`. |
| `settings.js` | `createSettings`: Settings / How to play panels, welcome card, keyboard focus + UI input filtering (game keys are blocked while a panel is open: `settings.open`). |
| `index.html` | HUD markup, panels, welcome card (`#welcome`), credits line (`#credits`), all page CSS. |

### `tools/` (Python = offline data; Node = tests)
| File | What it does |
|---|---|
| `fetch_tiles.py` | Defines `TILE_SET` (which 2 km tiles exist: base block + Hwy 18 band + McMinnville), constants (`TILE`, `HSTEP`, `MARGIN`, projection `K`, `R`), and downloads raw per-tile data to `data/raw/tiles/` (~35 s/tile): satellite, lidar DEM, tree heights; OSM for the whole bounding box (`data/raw/osm_region.json`). |
| `build_tiles.py` | **The big baker** (~5 min, ~3.5 GB RAM for 51 tiles). Builds global grids (heights, path smoothing, ponds, road carving) then cuts tiles. Writes `game/assets/tiles/<tx>_<tz>/*` and `game/assets/world.json`. `YR_ASSETS=<dir>` writes elsewhere (build there, then swap in). `rdp()` simplifier — closed loops must be measured from the start point. |
| `roadnet.py` | Road network for build_tiles: junctions from shared OSM points, dead ends joined, junction pieces (curved corners/end caps), per-road height profiles, terrain carved under every road. Read its docstring before touching roads. |
| `build_minimap.py` | Bakes `game/assets/minimap.jpg` + `minimap.json` (~10 s). |
| `challenge_routes.py` | Plans race routes along the built road/trail strips (shortest path, surface-weighted), checkpoints, ramps, walls `track`, jet ring courses; keeps routes and opened-out walls off water deeper than 0.3 m; writes `game/assets/challenges.json` (~8 s). **Re-run after any tile rebuild.** Edit `CHALLENGES` to add a race. |
| `build_world.py`, `align.py`, `check_align.py`, `mapdata.py`, `fetch_chm.py` | Old single-campus map builder and the trail-map → satellite alignment (6 landmarks, ~5–14 m error); trails are extracted from `reference/Delphiantrailsmap.png`. Mostly historical; `align`/`mapdata` are imported by build_tiles. |
| `make_engine_sound.py` | Builds the hatchback's `game/assets/audio/engine_*.wav` from the CC0 recordings. |
| `make_engine_sounds.py` | Synthesises every other ground / piston engine's loops (`game/assets/audio/engines/`) and writes `game/src/audio/engineloops.js` (~10 s). Credits: `game/assets/audio/CREDITS.md`. |
| `serve.py` | No-cache dev server (port 8173). |
| `drive.mjs` | Headless physics test drives (see test table). Imports `game/src/*` directly and the real tile files. |
| `shot.mjs`, `stream_test.mjs`, `vehicles_test.mjs`, `welcome_test.mjs`, `campus_test.mjs`, `jet_*_test.mjs` | See test table. |

## 3. Data flow

```
data/raw (git-ignored: NAIP satellite, 3DEP lidar, tree heights, OSM json, trail map)
   │  tools/fetch_tiles.py  (TILE_SET)
   ▼
tools/build_tiles.py  ←  tools/roadnet.py, align.py, mapdata.py
   ▼
game/assets/tiles/<tx>_<tz>/   + game/assets/world.json
   ▼  (tools/build_minimap.py → minimap.jpg ; tools/challenge_routes.py → challenges.json)
game/src/world.js fetches a tile's files → data.js makeTileData → world queries
   ├─ physics (car/bike/jet/glider/track) uses ONLY the world queries
   └─ rendering (world.js, roads.js, campusmodel.js) builds meshes from the same data
```

**`world.json`**: `tile` (2000), `hstep` (4.0 m), `hn` (501 vertices per tile side), `hm` (8 margin vertices),
`surfN` (2000), `tiles` (list of [tx,tz] that exist — the source of truth for what exists), `extent` (bounding box
only), `spawn`, `ponds` (levels).

**Per tile `game/assets/tiles/<tx>_<tz>/`:**
| File | Format / content |
|---|---|
| `height.bin` | float32 little-endian, (hn+2·hm)² = 517² heights on a 4 m grid: the tile's 501² vertices plus an 8-vertex margin so neighbours match (no seams). Already carved under roads. |
| `surface.bin` | uint8, 2000×2000 at 1 m, row = z, col = x. Classes: 0 grass, 1 forest floor, 2 dirt trail, 3 asphalt, 4 gravel, 5 water/pond bed, 6 concrete/building pad, 7 running track (names in `SURFACES`, world.js). |
| `ponds.bin` | uint16, same 517² padded grid as `height.bin`: pond id per vertex (0 = none), ids match `tile.json` `ponds` keys. |
| `trees.bin` | float32 records `[x, z, height, broadleaf]` (broadleaf 0/1), world coordinates. |
| `ground.png` | 2048² stylised ground colour picture (one per tile; textured on the terrain). |
| `tile.json` | `tx`, `tz`; `buildings`: `[{pts:[[x,z],…], h}]` (OSM footprints, `h` = height m); `paths`: render strips `[{kind:'asphalt'|'gravel'|'trail', w (width m), pts:[[x,z],…], yc:[[y, crossSlope],…]}]` where `yc[i]` = baked centre-line height and cross slope (height change per metre toward the left) for point i; `physPaths`: same for physics (can differ slightly from `paths`: includes pieces the renderer merges/skips); `junctions` / `physJunctions`: `[{kind, c:[x,z,y], ring:[[x,z,y,flag],…]}]` (road ends joined by curved corners, ring flag 1 = open corner edge needing a skirt); `ponds`: `{id: waterLevel_m}`. |

**`data.js` → world queries** (these are the physics contract): `heightAt(x,z)` = height of the drivable ground at that
point (terrain, plus road strips with their baked cross slope and any active ramps on top; see `data.js` for the exact rule), `terrainAt` raw ground,
`surfaceAt(x,z)` class number (road strips override the raster), `normalAt`, `waterLevelAt`, `treesNear` /
`buildingsNear` (callbacks with colliders; trees include height + broadleaf args), `rampAt`. Tiles that aren't
loaded return nothing; the vehicles hold the last loaded ground.

## 4. Conventions

- **Coordinates:** metres; x east, z south, y up. Vehicle local axes: +z forward, +y up, +x left. Vehicles' `yaw`
  convention: forward direction `fx = sin(yaw)`, `fz = cos(yaw)`.
- **Physics:** fixed **120 Hz** step (`STEP`), rendering interpolates (`interpolate`/`renderPos`). Never tie physics to
  frame time. Game **gravity is 24 m/s²** (arcade), not 9.8 — "× g" limits in game units are ≈2.5 real g.
- **Vehicle interface** (`game/src/vehicle.js`): `pos`, `quat`, `vel`, `ang`, `renderPos`, `renderQuat`, `mesh`,
  `step(dt, input)`, `reset(x, z, yaw)`, `resetToSafe()`, `syncMesh(dt)`, plus read-outs other code uses: `grounded`,
  `surface`, `airTime`, `hit`, `landing`, `slip`, `drifting`, `latAcc`, `lonAcc`, `wheels` (tyre marks/dust). New
  vehicles must implement it. Code that was handed "the car" once should use the `player`/`activeProxy`.
- **Physics only through the world queries** `heightAt / surfaceAt / normalAt / treesNear / buildingsNear /
  waterLevelAt` (+ `terrainAt / loadedAt / extent` for bookkeeping). Never read tile arrays or meshes from physics —
  the headless tests have no meshes.
- **Rendering vs data:** `data.js`, `campus.js`, `track.js` must stay free of three.js/DOM (the Node tests import
  them). Meshes live in `world.js`, `roads.js`, `campusmodel.js`.
- **Colours:** vertex colours are linear; convert sRGB hex (as `campusmodel.js` does) or things look washed-out.
- **Debug hooks:** `window.game` = `{scene, sun, effects, setCam(m), teleport(x,z,cls), car, world, input, keys,
  tuning, camera, renderer, minimap, challenges, pinGuide, glider, bikeGlider, vehicles}`. `?debug` or **F8** shows an
  input/gamepad/saved-settings readout. Browser tests drive the game through these.
- **Key bindings already taken** (don't reuse): W/A/S/D + arrows (drive; jet: W/S throttle, ↑/↓ pitch, ←/→ roll,
  A/D rudder), Space (handbrake / jet brakes / bike slide), Shift (bike wheelie), R (reset to safe spot), F (flip
  upright), H (home to campus), C (camera), G (glider), T (settings/tuning), Tab (panel focus), V (vehicle picker;
  1/2/3, ←→/A-D, ↑↓/W-S, Enter, Esc inside it), J (race menu; ←→↑↓ 1–4 Enter Esc inside; Backspace restarts a race, Esc quits; N next race on the finish screen), M (full
  map; Esc closes), P (remove pin), + / − / 0 (map zoom), F8 (debug), Enter/Esc/Space (welcome card). Letter keys
  also match by the letter printed on the key (AZERTY/Dvorak) via `e.key`.
- **localStorage keys:** `yr-tuning-2` (car), `yr-tuning-bike-1`, `yr-tuning-jet-1` (only known keys with real
  numbers are loaded, clamped to the menu range), `yr-best-1` (race best times + splits), `yr-medals-1` (best race medal per race), `yr-pin-1`,
  `yr-welcome-hidden-1`, `yr-sound-1` (Master / Engines / Effects volumes, 0–1), `yr-atmo-2` (day/night cycle on/off, fixed look, weather; replaces `yr-atmosphere-1`), `yr-graphics-2` (Graphics mode + Auto's measured pick). Bump the suffix if you change a stored format.
- **Surfaces / widths:** trails are drawn 3× real width (~7–12 m) so they're drivable at speed; trees are cleared
  from trails and roads; roads are 12–17 m wide; no kerbs.
- **Fixed jump ramps** are listed in `assets/ramps.json` (`{name,x,z,yaw,w}`); they survive tile rebuilds as plain
  x/z, but check the road under them is still straight afterwards.

## 5. Rules for agents

1. **Verify, don't assume.** A task is done only when every item of its "done when" checklist is proven: run the
   physics tests (`npm run drive`) after touching `car.js`, `data.js`, `campus.js`, `track.js` or world data; take
   **headless screenshots** (`tools/shot.mjs`) and look at them for anything visual; check **page errors** (the
   scripts print `PAGE ERROR`) and **fps/slow frames** after anything that adds per-frame work. Report each item with
   its evidence; say plainly what you could not verify. Never tick an item you didn't run.
2. **Do not push.** Commit locally if asked, but **never push to `main`** (it deploys live) unless the project owner
   says so in your task. Don't force-push, rewrite history, or switch someone else's branch.
3. **Commit identity:** use the repo's public identity (user name `Distractodog`, the GitHub noreply email the owner
   gives you) — never a personal name or email. Check with `git config user.name` before committing.
4. **Keep it public-safe:** this repo is public. No personal names/emails, no absolute local paths, no secrets or API
   keys, in code, comments, docs or commit messages. Use relative paths.
5. **Private files:** `CLAUDE.md` and `PLAN.md` (if present) are git-ignored private notes — don't commit, quote or
   publish them. `data/raw/`, `.venv/`, `node_modules/`, `__pycache__/` are also git-ignored.
6. **Several agents may work at once.** Stay inside the files your task names; put new code in **new small files**
   rather than growing `main.js`, `world.js`, `data.js` or `build_tiles.py`; don't reformat or reorganise files you
   don't own; make small, targeted edits to shared files and say which lines. Don't touch tile assets
   (`game/assets/tiles/**`) unless your task is a tile-rebuild package.
7. **Don't rebuild tiles for nothing.** A rebuild rewrites ~384 MB and every rebuild re-commits all tiles, growing git
   history by that much. Tile-rebuild work is batched into one agreed rebuild.
8. **Size budget:** GitHub Pages limit ~1 GB; assets are ~384 MB now. Don't add big files casually.
9. **Performance budget:** the game targets 60 fps. Everything new needs a cheap far version and must not make
   any measured spot slower than its baseline (see the task's budget).
10. **The owner's decisions win:** no kerbs, 1000 km/h top speed, arcade physics, low-poly flat shading. Ask before
    reversing one.

## 6. Gotchas

- **Server/port:** use `http://127.0.0.1:8173`, not `localhost` (stale cached files). If the port is taken, a
  server from another session may already be serving the same folder — reuse it.
- **Hidden browser tab = ~12 fps**, tiles barely load. Measure speed in **headless Chrome**, which is itself slower
  than a real browser (8–12% slow frames is normal there); judge changes by before/after at the same spot.
- Headless Chrome 404s on `/favicon.ico` — harmless.
- `npm run drive`'s accel test hits trees after ~9 s, so it can't measure top speed. For top speed, stub the world
  flat (heightAt/terrainAt constant, surfaceAt = 3 asphalt, no trees/buildings) and start at x = −4900 heading east.
- **Teleporting** the car to a spot that hasn't streamed in: the game pulls it back to the last loaded ground. Hold
  it there (set pos, `car._lastLoaded = null`, repeat every 100 ms until `world.loadedAt(x,z)`) like `goHome()` in
  `main.js`; `game.teleport(x, z)` does this for simple cases.
- Gravity is 24 m/s²: a glider drag cap written in "g" would crush a fast glide (opening at 1200 km/h once dropped
  to 300 in 0.5 s). The cap is a fixed 9.8 m/s².
- `rdp()` in `build_tiles.py`: a closed polyline (start = end) must be measured from its start point or the whole loop
  collapses to zero length (this once made roundabouts/cul-de-sacs vanish and 3-way junctions look 4-way).
- Pond rims are protected from road carving only down to 0.15 m above that pond's water; pond beds are never carved.
- **Road clip check:** terrain poking above the road surface must stay ~0.02% of road-strip area (0.019% now). Re-measure
  after any change to road carving.
- After rebuilding tiles: run `build_minimap.py` and `challenge_routes.py`, or race arches end up off the roads.
- OSM is fetched for the whole bounding box; to add tiles add them to `TILE_SET`, delete `data/raw/osm_region.json`,
  run `fetch_tiles.py`, then rebuild.
- Campus: a footprint whose wall lies exactly on another part's wall z-fights (flickers) — end the part at the other
  part's back face. Colours are sRGB in `campus.js` and linear in meshes. Heights are above the building's `floorAt`.
- Input: `game.keys` holds physical codes (tests add to it directly); `main.js` also checks `letters`. A non-standard
  or never-touched gamepad is ignored; W/S beat the pad triggers. To repro keyboard-layout bugs, dispatch CDP
  `Input.dispatchKeyEvent` with `code` and `key` set separately and stub `navigator.getGamepads`.
- Saved tuning from older versions is migrated/clamped; a saved `null` or `throttleRate: 0` once froze the game —
  load only known keys with real numbers.
- Camera: the jet camera carries the vehicle's rendered displacement before smoothing (avoids speed-triggered snaps);
  test the real camera function with `jet_camera_test.mjs`.
- Jet flight turns at actual manifest tile edges (`world.json` `tiles`), not the bounding rectangle — the map is a
  band, not a rectangle.
- Open known bugs are listed in the owner's work packages (rare glider stuck-bank glitch, glider not blocked during
  challenges, jet visual verification gap).
- Data credits (OSM ODbL, USGS public domain, Meta/WRI CC BY 4.0, CC0 engine sound) live in the `#credits` line of
  `game/index.html` and `README.md`; update both if you add a data source.
