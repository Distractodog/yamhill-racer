# Brief for Claude (Claude Code) — Yamhill Racer

**Start here:** read `AGENTS.md` (repo root) completely, then this file. Don't read the rest of the code: each piece
names the files and functions to open. The owner pastes one line such as *"Read docs/agents/CLAUDE.md and do piece RM-1a"*.
Do only that piece, then stop. (If a private `CLAUDE.md` / `PLAN.md` exists in the repo root, they are the owner's
private notes: use them for status, never copy their contents into committed files.)

## Your role and your limits
You are on a ~$20/month plan whose usage is **limited (check your plan; don't assume numbers)** — the tightest of the four
tools. So you get **few, narrow, high-risk pipeline pieces** that other agents would likely get wrong: the tile data
format and loader, the road network, and the one big rebuild. Everything else was given to Cursor or ChatGPT.
- Each piece is sized **S / M / L** and ends at a **committed, tested state**. Commit after every working step; if you run
  out of usage nothing is lost.
- **Read only what's named.** Don't survey the codebase. `build_tiles.py` is 524 lines: read only the line ranges given.
- **Never watch a long job.** Downloads (~2 h) and builds (~30 min) are plain commands the owner runs in a terminal tab (exact
  commands below); you start or hand over the command, then later check its log/output. Don't poll.
- Mostly keep answers short; no recaps.

## Git (every piece)
- Branch from `main`, lower-case piece name: `git switch -c rm-1a main`.
- Identity: user name `Distractodog` + the GitHub **noreply** email the owner gives you; repo-local config only
  (`git config user.name Distractodog`; `git config user.email <noreply>`). No personal name/email/absolute paths in files or messages.
- **Never push `main`; push nothing unless the owner says so.** Don't switch branches under other sessions; don't stash/reset others' work.
- Commit only files you changed. Tile assets (`game/assets/tiles/**`) are committed **only** by RM-4, once.
- Commit messages end with the attribution line your tool adds (if any); keep them factual.

## Standard checks
- **DRIVE** = `npm run drive` exits 0, 0 flips, no NaN, all race bots finish; diff the printed numbers against a run on `main` before you start (save it as `drive-before.txt` outside the repo).
- **PAGEERR** = game loads headless with no `PAGE ERROR` (server: `python3 tools/serve.py 8173 game`; `node tools/shot.mjs out.png`).
- **STREAM** = `node tools/stream_test.mjs 1000` → 0 frames with no ground.
- **BENCH** = `node tools/bench.mjs` (Cursor creates it in TW-0a; if it doesn't exist yet, use shot.mjs's fps line at the same spots).
- **SHOT** = `node tools/shot.mjs out.png x z surfaceClass cam`, then look at the image.
- **ROADCLIP** = the road-clip percentage the build prints must stay ~0.02% (0.019% today).

## Waiting on others
- You own: `tools/build_tiles.py`, `tools/roadnet.py`, `tools/pack_tiles.py` (new), `game/src/tilepack.js` (new), `game/src/roads.js` (road *data/markings logic*), `tools/challenge_routes.py`, everything in `game/assets/tiles/`.
- **Cursor owns** new town/campus/prop files and `minimap.js`; **ChatGPT owns** `rim.js`, `tools/footprints.py`, glider/challenge bug fixes, and runs `fetch_tiles.py` edits (RM-3) and the deterministic-seed change (RM-2, a few lines in `build_tiles.py` — see below).
- **Order for `build_tiles.py`** (one agent at a time, each merged before the next starts): RM-1a → RM-2 (ChatGPT) → TW-2a → TW-3g → TW-4b (ChatGPT, 3-line hook) → RM-4.
- RM-4 waits for: RM-1a/1b, RM-2, RM-3 (downloads done), and whichever of TW-2/TW-3g/TW-4 the owner wants in the batch.
- Cursor's TW-0b (merged road meshes) touches `world.js` and may call `roads.js` helpers: don't change `buildRoads`' signature without telling the owner.

## Pieces, in order

### RM-1a — pack the tiles (tool) (M)
- **Goal:** each tile ~5× smaller on disk, visually identical. (Approved round-map plan; owner said "we will do this, but not now" — **do nothing here until the owner says start.**)
- **Edit/create:** new `tools/pack_tiles.py`; `tools/build_tiles.py` **output step only** (lines ~455–520: `surf.tofile`, `ground.png` save at ~472, `height.bin` ~477, `trees.bin` ~492, `tile.json` dump ~511, `ponds.bin` ~515, `world.json` dump ~520); new `tools/verify_pack.py`. **Leave alone:** all `game/src/`.
- **Formats:** `height.bin.gz`, `surface.bin.gz`, `ponds.bin.gz`, `tile.json.gz` (gzip; the browser decodes with `DecompressionStream('gzip')`, Node tests with `zlib`), `ground.jpg` (quality ≥ 90), `trees.bin` raw. `world.json` gets `"packed": 1`; **without that flag the old file names still load** (so RM-1b can be tested on both).
- **Tasks:** `pack_tiles.py <src assets dir> <dst assets dir>` converts a whole assets folder; `verify_pack.py` unpacks and compares byte-for-byte (heights, surface, ponds, trees, tile.json) and prints max/mean pixel difference for ground; update the output step of `build_tiles.py` to write packed files directly.
- **Done when:** [ ] `du -sh` before/after for the 51 tiles (target 1.0–2.0 MB each, ~70–100 MB total); [ ] `verify_pack.py` passes on ≥ 5 tiles (campus, town, forest, farmland, corner): arrays byte-identical, ground mean pixel diff small (report); [ ] SHOT (after RM-1b) identical-looking.
- **Budget:** ≤ 2.0 MB per tile. **Pitfall:** JPEG must keep the same colour space as the PNG (three.js treats it as sRGB: check `world.js` ~lines 45–60, which splits ground into 4 quarter textures from a blob).
- **Open question for owner:** none (agreed). Ask only if JPEG visibly shifts colour. Long job: none (run on a packed copy: `python3 tools/pack_tiles.py game/assets ../yr-assets-packed`, a few minutes).

### RM-1b — tile loader and tests for packed tiles (M)
- **Edit/create:** new `game/src/tilepack.js` (`unpackGzip(url)` → ArrayBuffer/JSON, using `DecompressionStream`, one tile at a time so no frame stalls); `game/src/world.js` `fetchTile` (lines ~45–60: the 5 fetches and the ground blob; use packed names when `W.packed`); `tools/drive.mjs`, `tools/campus_test.mjs`, `tools/jet_boundary_test.mjs` and any test reading `height.bin` etc. directly (grep `\.bin`), decode with `node:zlib`. **Leave alone:** `data.js` `makeTileData` (it receives buffers exactly as before).
- **Done when:** [ ] game loads from the packed copy (`python3 tools/serve.py 8173 ../yr-assets-packed`-style: serve a folder that has `index.html` + `src` + packed `assets`; or copy `game/` to a scratch dir) with PAGEERR clean; [ ] DRIVE numbers identical to `drive-before.txt`; [ ] STREAM 0 frames with no ground; [ ] page load time to first tiles before/after reported; [ ] unpacked old assets still load (flag absent).
- **Pitfall:** `.gz` served by GitHub Pages is just bytes (no `Content-Encoding`); decode in JS only.

### TW-2a — road classes in the data (M)
- **Waits for:** the owner's answers (below) and RM-1a merged.
- **Goal:** each road keeps its OSM class and gets a proper width.
- **Edit:** `tools/roadnet.py` (read its docstring; the OSM ways come in with tags — find where `road_paths` is filled in `build_tiles.py` ~lines 109–135 and the width/kind assignment), `tools/build_tiles.py` (write `cls` = highway tag, `lanes`, `sidewalk`, `oneway` per path into `tile.json`), `game/src/data.js` `PATH_KINDS` only if you add kinds (keep asphalt/gravel/trail working). **Leave alone:** `roads.js` rendering (TW-2b).
- **Tasks:** widths by class (arterial as now; residential 10 m (owner Q3); alleys/driveways/parking aisles 5–6 m); tiny service stubs (driveways < 30 m, parking aisles) become flat paving flagged `flat:true` (not raised strips); split carriageways / doubled OSM ways merged or flagged for a median. **Test on a 2–3 tile build only**: `YR_ASSETS=../yr-assets-test .venv/bin/python tools/build_tiles.py` is the *full* build — instead temporarily restrict `TILE_SET` via an env var `YR_TILES=9_-6,10_-6` that you add (one line in `build_tiles.py`'s `TILES = [...]`) so a test build takes a minute.
- **Done when:** [ ] test build of a McMinnville tile + a Sheridan tile (`YR_TILES=…`): `tile.json` has `cls` on every path; [ ] ROADCLIP ~0.02% on that build; [ ] DRIVE on the test assets (point a copy of `game/` at them) passes; [ ] width/flag counts reported (e.g. N service stubs flat).
- **Pitfall:** closed loops must be simplified with `rdp()` measured from the start point; junction geometry must still close (no gaps at width changes) — look at 3 junction SHOTs.
- **Open questions for owner (Q1–Q4 in the roads list):** what bugs him most; worst spot; real-width town streets or wide for speed; roads rebuilt together with the round map. **Defaults if unanswered:** residential 10 m, alleys 5 m, rebuild together with the round map, low sidewalks yes, tall kerbs no.

### TW-2b — road drawing by class (M)
- **Edit:** `game/src/roads.js` (`buildRoads`, `buildJunctions`, `campusRoad`), with `game/src/data.js` physics overlay for sidewalks only if added. **Leave alone:** Cursor's merged-mesh code (`meshmerge.js`); don't change function signatures.
- **Tasks:** markings by class (yellow centre only on arterials/collectors; white edge lines only out of town; residential plain; stop lines + crosswalks where a minor road meets a bigger one in town); junctions sized to the roads meeting there; flat-paving stubs drawn flat; low kerbs + sidewalks where `sidewalk` tag says so — **low and drivable** (owner disliked kerbs earlier: ask, default = sidewalks yes, kerb height ≤ 12 cm, no flips at 100/300 km/h); strip distance LODs (fewer points, no markings past ~300 m).
- **Done when:** [ ] SHOT of 6 spots (residential, arterial, alley, parking lot, downtown junction, Hwy 18 junction) before/after, looked at; [ ] drive over a sidewalk/kerb at 100 and 300 km/h in a headless script: no flip; [ ] BENCH: McMinnville faster than Cursor's TW-0b result, other towns 0 slow frames; [ ] DRIVE, PAGEERR; [ ] **(owner)** drives the three towns' streets.
- **Budget:** tile size growth ≤ +10%.

### TW-3g — town ground colours (S)
- **Edit:** `tools/build_tiles.py` ground-colour section (~lines 415–472: where `sat` and the dry/grass palette are combined into `col`). **Tasks:** lawns green, lots/gravel/parking grey instead of sandy yellow, using OSM landuse + parking polygons + satellite; painted driveways/sidewalks where there are no kerbs. **Done when:** [ ] test build (`YR_TILES=`) ground SHOT before/after for 3 towns; [ ] ground file size unchanged ±5%. Rides in RM-4.

### RM-4 — the one rebuild batch (L, but mostly commands on the owner's Mac)
- **Waits for:** everything chosen for the batch merged to `main`; ChatGPT's RM-3 downloads complete (**check, don't run**: `ls data/raw/tiles | wc -l` = 276).
- **Commands** (owner runs in a terminal tab; each is a log you read afterwards; close other heavy apps — ~8 GB RAM peak):
  ```bash
  # from the repo root; builds into a NEW folder so the live assets are never half-written
  cp -r game/assets ../yr-assets-new && rm -rf ../yr-assets-new/tiles
  YR_ASSETS=../yr-assets-new .venv/bin/python tools/build_tiles.py 2>&1 | tee ../build.log     # ~30 min
  YR_ASSETS=../yr-assets-new .venv/bin/python tools/build_minimap.py 2>&1 | tee ../minimap.log   # ~10 s (Cursor's RM-6 version)
  ```
  Then swap in and plan the races (challenge_routes only reads `game/assets`):
  ```bash
  rm -rf game/assets/tiles && mv ../yr-assets-new/tiles game/assets/tiles
  cp ../yr-assets-new/world.json ../yr-assets-new/minimap.jpg ../yr-assets-new/minimap.json game/assets/
  .venv/bin/python tools/challenge_routes.py 2>&1 | tee ../routes.log                           # ~8 s
  ```
  (Keep the old tiles' git history as the backup: `git stash` is **not** to be used; the old assets are in git.)
- **Your job:** after each command, read the last lines of its log (not all of it) and report: tile count, ROADCLIP %, errors. Check ramps (`game/assets/ramps.json`: road under each ramp still straight — `node tools/drive.mjs ramps`).
- **Done when:** [ ] `world.json` lists 276 tiles (`python3 -c` count), `du -sh game/assets` ≤ ~400 MB; [ ] ROADCLIP ~0.02%; [ ] DRIVE + `node tools/drive.mjs ramps` + `walls` pass; races re-planned and bots finish; [ ] STREAM across the circle 0 frames with no ground; [ ] SHOT Amity, Ballston, Perrydale, new Willamina/McMinnville parts look like Sheridan; [ ] page load not slower; PAGEERR clean; `vehicles_test.mjs` passes; [ ] commit the assets in **one** commit (tiles + world.json + minimap + challenges); [ ] **(owner)** drives it before any push.
- **Pitfall:** a failed build leaves `../yr-assets-new` half-written — don't swap until the log ends with the final tile line. Repeat builds must be deterministic (RM-2) or git history balloons.

### TW-4r — review ChatGPT's footprint merge (S)
- Read only `tools/footprints.py` and its 3-line hook in `build_tiles.py`; check dedupe logic (overlap thresholds), licence credit line, and heights. Report approve / changes needed. No other work.

## Report back (send the owner this, filled in)
```
Piece: <ID>   Branch: <name>   Commits: <short hashes>
Changed files: <list>
Checklist: [x]/[ ] each item — evidence (output lines or screenshot path); NOT verified: <say so>
Numbers: sizes before→after, ROADCLIP %, BENCH/STREAM results
For the owner to decide/try: <list>
Add to AGENTS.md: <new commands/files, or "nothing">
Next piece that is now unblocked: <ID>
Usage note: <where you stopped if you hit limits>
```
