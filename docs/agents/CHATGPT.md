# Brief for ChatGPT (Codex / agent) — Yamhill Racer

**Start here:** read `AGENTS.md` (repo root) completely, then this file. Don't read the rest of the code: each piece names
the files and functions to open. The owner pastes one line such as *"Read docs/agents/CHATGPT.md and do piece BUG-1"*.
Do only that piece, then stop.

## Your role and your limits
You take **well-specified, self-contained packages with clear tests**: bug fixes, test scripts, data import, the rim wall,
small features. You are on a ~$20/month plan whose usage is **limited (check your plan; don't assume numbers)**:
- Pieces are sized **S / M / L** and each ends at a **committed, tested state**: commit after each working step so running out
  mid-piece loses nothing. If you stop early, write the state in your report.
- **Model choice:** a cheaper/smaller model is fine for: test scripts, docs, `RM-2`, `RM-3`, BUG-3's script, `fetch_buildings` downloading
  code. Use the strongest model for: BUG-1 (finding the cause), BUG-2 (design touches physics), RM-5a/5b (physics edges), TW-4b (merge logic).
- **Long jobs run outside you.** Downloads and builds are plain terminal commands the owner runs; you edit files, start the command
  if you can run a terminal, and later read the tail of its log. Never wait on or poll a job.
- Don't read big files whole. `tools/drive.mjs` is 600 lines, `build_tiles.py` 524: open only the ranges named.

## Git (every piece)
- Branch from `main`, lower-case piece name: `git switch -c bug-1 main`.
- Identity: user name `Distractodog` + the GitHub **noreply** email the owner gives you; repo-local config only.
  No personal names/emails/absolute local paths in files, comments or commit messages.
- **Never push `main`; push nothing unless the owner says so.** No force-push; don't touch other branches.
- Commit only the files your piece names. Tile assets (`game/assets/tiles/**`) are never committed by you.

## Standard checks
- **DRIVE** = `npm run drive` exits 0, 0 flips, no NaN, all race bots finish. Save the output on `main` before you start (`drive-before.txt`, outside the repo) and diff it.
- **PAGEERR** = headless load prints no `PAGE ERROR` (`python3 tools/serve.py 8173 game`, then `node tools/shot.mjs out.png`; use `http://127.0.0.1:8173`, not localhost).
- **STREAM** = `node tools/stream_test.mjs 1000` → 0 frames with no ground. **SHOT** = `node tools/shot.mjs out.png x z surfaceClass cam` and look at it.
- Single sections: `node tools/drive.mjs glider|bikeglider|walls|ramps|jet|bike`.

## Waiting on others
- You own: `game/src/rim.js` (new), `tools/footprints.py` + `tools/fetch_buildings.py` (new), new test files under `tools/`, `game/src/glider.js` and the glider/bank code, `game/src/challenges.js` `constrain()` for BUG-2, `tools/fetch_tiles.py` `TILE_SET` (RM-3), the RNG seeding lines in `tools/build_tiles.py` (RM-2 only).
- **Claude owns** `tools/build_tiles.py` otherwise, `roadnet.py`, `roads.js`, tile assets. **Cursor owns** town/campus/prop files, `minimap.js`.
- `build_tiles.py` edit order (one agent at a time, merge before the next starts): Claude's RM-1a → **your RM-2** → Claude's TW-2a → TW-3g → **your TW-4b hook**. If your branch is older than the last merge, rebase onto `main` before editing it.
- RM-5a/5b wait for Claude's RM-4 only for the final full-map test; develop and test on today's map with a fake circle (same code, different radius/centre).

## Pieces, in order

### BUG-1 — glider "stuck bank" (S–M, strongest model)
- **Background:** 2026-11-13, bike glider, headless Chrome: of 14 runs, 2 crashed; in the logged one the bike stayed at full left bank ~9 s after A was released as if A were still held. Never seen in 56 other headless sweeps. Already known: `main.js` clears keys on `blur` and `visibilitychange` (lines ~152–154), so a lost keyup on blur is covered — look for other causes.
- **Read only:** `game/src/glider.js` (the bank/roll update in `Glider.step`; ~318 lines total — search `bank`), `game/src/main.js` lines 130–200 (`keys`, `letters`, `readInput`), `game/src/bike.js` `afterGlide`. **Edit:** `glider.js` (and `main.js` input only if the cause is a stuck key); **create** `tools/glider_stuck_test.mjs`. **Leave alone:** `GLIDER`/`BIKE_GLIDER` numbers unless the cause needs it.
- **Tasks:** write a headless-browser test (pattern: `tools/vehicles_test.mjs`, 70 lines): open the glider in the air (car, then bike), hold A for 2 s, release, sample the bank angle every 100 ms for 12 s; 30 runs per vehicle; add CPU throttling (`Emulation.setCPUThrottlingRate`, rate 4) and injected 200 ms stalls to reproduce a slow frame. Find whether bank can stay non-zero after key-up; check dt-dependence of the self-levelling (frame `dt` is clamped to 0.1 s and physics runs at 120 Hz) and whether a keyup is lost when a key is pressed again with `e.repeat`.
- **Done when:** [ ] the cause is explained in 3–5 sentences, or "not reproducible in N runs" with the method; [ ] 100 consecutive stress runs: 0 stuck banks; [ ] `node tools/drive.mjs glider` and `bikeglider` outputs identical to before (diff); [ ] PAGEERR clean.
- **Pitfall:** headless Chrome is slower than a real browser; don't "fix" frame-time noise by changing physics.
- **Open question for owner:** none.

### BUG-2 — glider during challenges (S–M, strongest model)
- **Background:** race walls (`game/src/track.js`, called via `challenges.constrain()` after every physics step, `challenges.js` line ~336) stop road shortcuts for ground vehicles; the glider isn't blocked.
- **Read only:** `challenges.js` lines 320–350 (`constrain`, `holdInput`), `glider.js` `toggle` + `step` entry, `track.js` (73 lines). **Edit:** `glider.js` and/or `challenges.js` (≤ ~20 lines). **Leave alone:** challenge routes.
- **Options (owner decides; default = A):** **A** G is refused during a race with a hint ("no glider in races"); **B** walls also apply in the air; **C** glider only in races that opt in. Implement the chosen one.
- **Done when:** [ ] headless test `tools/glider_race_test.mjs`: during countdown + run, G in the air and on the ground at 150 km/h behaves as chosen; a bot that tries to glide straight across a bend can't get > 1.5 m outside the corridor; [ ] all race bots still finish (DRIVE); [ ] free-roam glider unchanged (`drive.mjs glider` identical); PAGEERR clean; [ ] **(owner)** OK.
- **Open question for owner:** A, B or C? **Default: A.**

### BUG-3 — jet visual verification script (M, cheap model for the script; look at images yourself)
- **Background:** jet physics tests pass, but a full visual flight/crash + fps check was never done (headless Chrome couldn't launch in that environment).
- **Create:** `tools/jet_visual_test.mjs` (pattern: `vehicles_test.mjs`; V to switch vehicle via `game.vehicles`). **Edit** nothing else, except minimal fixes if a screenshot shows something clearly broken (each fix a separate commit, in `jet.js`/`main.js` camera).
- **Tasks:** screenshots + frame times through: take-off on Hwy 18, passes at 600/1000/1700 km/h, a banked turn, a stall, landing, crash + respawn; output a table of fps/slow frames per phase.
- **Done when:** [ ] each screenshot opened and given a one-line verdict in the report; [ ] fps/slow frames per phase; [ ] no page errors; [ ] STREAM at jet speed (`jet_boundary_test.mjs` passes); [ ] **(owner)** flies it.
- **Open question:** none.

### RM-2 — deterministic randomness in the tile build (S, cheap model)
- **Waits for:** Claude's RM-1a merged. **On hold until the owner says start the round map.**
- **Edit:** `tools/build_tiles.py` only the RNG: global `rng = np.random.default_rng(7)` (line 34) is used per tile at lines ~470 (ground tone), 483 (tree jitter), 489 (edge trees), 490 (tree heights). Replace with a per-tile generator inside the tile loop: `rng = np.random.default_rng([7, tx + 1000, tz + 1000])`. Check there is no other use (`grep -n "rng" tools/build_tiles.py`).
- **Done when:** [ ] two test builds of the same 3 tiles (use Claude's `YR_TILES=9_-6,10_-6,10_-5` switch if merged; else temporarily edit `TILES`) are byte-identical (`diff -r`); [ ] building 3 tiles vs 4 tiles changes only the extra tile and (if any) its neighbours; [ ] SHOT forest spot before/after looks the same density.
- **Pitfall:** don't change anything else in that file. Builds are slow: test on 3 tiles only.

### RM-3 — tile list + downloads for 276 tiles (S edit, long job on the owner's Mac)
- **On hold until the owner says start.** **Edit:** `tools/fetch_tiles.py` lines ~20–31: replace the three hand-written sets with "all tiles with centre within 17.8 km of (9000, −5000)" (**keep every one of today's 51 tiles inside it**; assert in code). Delete nothing else.
- **Edit done when:** [ ] `python3 -c "import sys; sys.path.insert(0,'tools'); import fetch_tiles as f; print(len(f.TILE_SET))"` → 276 and all 51 old tiles are members (print the check).
- **Then the owner runs** (terminal tab, overnight, ~2–2.5 h, ~4.6 GB; re-runnable, it skips tiles it already has):
  ```bash
  rm -f data/raw/osm_region.json
  .venv/bin/python tools/fetch_tiles.py 2>&1 | tee ../fetch.log
  ```
  If Overpass (OSM) times out, split the bounding box into 4 requests (edit the OSM fetch part, ≤ 20 lines) and re-run.
- **You then check, not watch:** [ ] `ls data/raw/tiles | wc -l` = 276; [ ] every tile folder has `chm.npy`, satellite and DEM; list failures; [ ] OSM json contains a building in Amity. **Do not run `build_tiles.py`.**
- **Open question for owner:** disk space ≥ 10 GB free? (4.6 GB raw + working).

### RM-5a — rim wall physics (M, strongest model; the exact radius: 17.2 km around (9000, −5000))
- **Create:** `game/src/rim.js` — `makeRim({cx, cz, r})` returning `constrain(vehicle)`; **no three.js** (Node tests import it). Model it on `game/src/track.js` (73 lines): push the vehicle back inside the circle, remove the speed going into the wall, slide along it, never flip it. Hook: one call after each physics step in `main.js` frame loop (near `challenges.constrain()`, line ~341), ≤ 3 lines.
- **Read also:** `game/src/vehicle.js` lines 95–120 and `car.js` ~370–385 (existing "stay inside the map extent" check at the bounding box edge, margin 6 m: your rim replaces that for the round map; leave the bounding-box check in place until RM-4), `jet.js` lines ~285–310 (`mapContains` / `W.W.tiles` boxes: the jet turns at actual tile edges; the rim must take over).
- **Tasks:** works for car, bike, jet, glider; safe-respawn spots (`resetToSafe`, `goHome`) can't be outside; challenge walls still work. For tests today use the same code with a fake circle that fits today's map (centre (9000, −5000) is outside today's band at the edges — use a small circle around the campus, e.g. r = 3 km, centre (0, 0), as a test fixture).
- **Done when:** [ ] `tools/rim_test.mjs`: drive into the wall at 300 km/h at 4 spots (car, bike): never beyond r, no flip, still moving along the wall at the end; jet and glider at 1000+ and 150 km/h: no escape; [ ] DRIVE identical to before (fixture off by default); `jet_boundary_test.mjs` passes; [ ] PAGEERR clean, BENCH/fps unchanged (≤ 0.05 ms).
- **Pitfall:** the jet and glider call `world.extent`/tile-edge logic; keep their existing behaviour when the rim is disabled.

### RM-5b — the glowing ring (M, cheap model ok)
- **Create:** `game/src/rimring.js` (three.js): a tall faint ring band at r that **fades in within ~150 m** of the player; additive blending, no depth write, one draw call; default pale cyan/white. **Hook** in `main.js` ≤ 3 lines. **Done when:** [ ] SHOT at 300 m, 100 m and at the wall (ring faint; scenery visible beyond); [ ] BENCH/fps unchanged (≤ 0.2 ms); [ ] PAGEERR; [ ] **(owner)** colour/feel.
- **Open question for owner:** ring colour? **Default: pale cyan/white.**

### TW-4a — missing-building data download (M, cheap model for downloader code)
- **Waits for:** Grok's R-3 licence note (`docs/research/building-data-licences.md`). **Create:** `tools/fetch_buildings.py` — downloads the chosen open footprint set (default: Overture Maps buildings or Microsoft US Building Footprints, as R-3 recommends) for the map's bounding box, clips to `TILE_SET`, saves `data/raw/footprints.geojson` (git-ignored). **Done when:** [ ] file exists with a count of footprints inside Sheridan's downtown box; [ ] source + licence + credit wording quoted in the report. Run time: let the owner run the download command if it's > 5 min.

### TW-4b — merge footprints into the build (M, strongest model; build_tiles.py edit order above)
- **Create:** `tools/footprints.py`: `merge(osm_buildings, new_footprints)` → list of `{'pts': Nx2 array (world x,z), 'h': float}` (same shape as the OSM list at `build_tiles.py` line ~132); drop a new footprint if > 30% of its area overlaps an OSM footprint; heights: OSM tag else by area class (small < 40 m² → 3 m; house 60–350 → 5.5–7.5 m; > 600 → 8 m; > 1500 → 8 m). Hook: in `build_tiles.py` right after `buildings` is filled (line ~135), 3 lines. Convert lon/lat with the existing `lonlat_to_world` (line 49).
- **Test:** `tools/footprints_test.py` (synthetic cases: duplicate, partial overlap, no overlap, tiny sliver) + a count report for Sheridan/Willamina/McMinnville tiles before/after; **no full rebuild** (Claude runs RM-4).
- **Done when:** [ ] unit tests pass; [ ] counts per town before/after and a SHOT-like top-down plot (matplotlib PNG) of Sheridan Main St over the satellite crop (`data/raw/tiles/<tx>_<tz>/` image) showing no stacked duplicates; [ ] credits line text ready for `game/index.html` `#credits` and `README.md` (put in your report; the owner/Cursor adds it); [ ] Claude reviews (TW-4r).
- **Open question for owner:** OK to use that data source's licence? **Default:** the licence R-3 says is compatible with a public ODbL-credited game.

### Tests / small features (as asked)
- **New test scripts:** copy the pattern of `tools/vehicles_test.mjs`; one file per feature; add a row to the `AGENTS.md` test table; cheap model fine.
- **Later (only when the owner starts them; S–M each):** ghost car (record the best run, ~20 samples/s of position+heading, replay as a see-through car in `challenges.js` — new file `game/src/ghost.js`); respawn at the last checkpoint on R during a run (`challenges.js` + `resetToSafe` hook) with a wrong-way hint. Each: headless test + SHOT + DRIVE identical.

## Report back (send the owner this, filled in)
```
Piece: <ID>   Branch: <name>   Commits: <short hashes>
Changed files: <list>
Checklist: [x]/[ ] each item — evidence (output lines or screenshot path); NOT verified: <say so>
Cause / design chosen (BUG pieces): <3–5 sentences>
For the owner to decide/try: <list>
Add to AGENTS.md: <new commands/files, or "nothing">
Left over / found while working (not fixed): <list>
Usage note: <where you stopped if you hit limits>
```
