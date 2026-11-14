# plan-review — research notes (2026-11-13)
Status: draft

## Summary (≤ 10 lines: what the coding agent needs to know)
- **Commit the briefs first.** `AGENTS.md` and `docs/` are untracked, and `.gitignore`'s bare `CLAUDE.md` line also ignores `docs/agents/CLAUDE.md`. Branches made "from `main`", and any cloud agent, won't see the briefs.
- **RM-3's tile rule is wrong.** "Centre within 17.8 km" gives **256** tiles, not 276, and leaves holes inside the 17.2 km rim. 276 = tiles that *touch* the 17.8 km circle.
- **The hook and edit orders deadlock** while the round map is on hold. The `world.js` order puts RM-1b before TW-1b, and the `build_tiles.py` order puts RM-1a before TW-2a/TW-3g/TW-4b. RM-1a/1b are "on hold".
- **No agent owns `game/src/data.js`.** Cursor (TW-1b, CD-1c) and Claude (TW-2a, TW-2b) both edit it, and no order is given.
- **All local agents share one checkout.** `git switch` by one agent (or Cursor merging) moves the others' working tree. Use one clone or worktree per agent.
- **GitHub Pages already gzips `.bin` and `.json` on the wire** (measured). RM-1a mainly saves repo and site size, not player download.
- **Determinism (RM-2):** gzip files hold a timestamp unless `mtime=0`. "Byte-identical" builds fail after RM-1a unless the packer sets it.
- **Headless benchmarks sit on the 16.7 ms (60 Hz) frame cap.** "Not worse" can't be seen at Sheridan, Willamina or campus, and TW-0b's "≤ 16.7 ms" target is the cap itself.
- **Too big for one sitting:** TW-1a, TW-1b, TW-0b, BUG-1's 160+ browser runs, and RM-4 (Claude's tightest plan).

## Facts
(For this review, each item below is one finding. Format: **where** → what's wrong → why it matters → confidence and source.)

### 1. Wrong or risky assumptions

#### 1.1 RM-3 tile rule gives 256 tiles, not 276, and leaves rim gaps
- Where: `docs/agents/CHATGPT.md` › RM-3 ("all tiles with centre within 17.8 km of (9000, −5000)" … "→ 276"). The same rule is in `PLAN.md` › (a) ROUND MAP numbers and › RM-3.
- What: I counted the 2 km tile grid (tile (tx,tz) centred at tx·2000, tz·2000). There are **256** tiles with centre ≤ 17.8 km and **276** tiles whose square *intersects* a 17.8 km circle. With the centre rule, about 2% of points on the 17.2 km rim (144 of 7,200 sampled) have no tile. That means no ground right at the wall, and RM-5's "≥ 600 m of scenery beyond the wall" fails. All 51 of today's tiles are inside either way (farthest centre: 15.8 km).
- Why it matters: RM-3's "done when" (`len(TILE_SET) == 276`) can't pass if the agent codes the rule as written. RM-4's "world.json lists 276 tiles" would then fail as well.
- Confidence: high (computed from `game/assets/world.json` tiles on GitHub `main` plus the brief's tile maths).

#### 1.2 `.gitignore` hides the Claude brief, and the briefs aren't on GitHub
- Where: the repo `.gitignore` (bare line `CLAUDE.md`). `AGENTS.md` › 5 Rules #5. `docs/HANDOFF.md` › Rules #1 ("made from the current `main`"). Git status: `AGENTS.md` and `docs/` untracked.
- What: a `.gitignore` pattern with no slash matches at every level, so `docs/agents/CLAUDE.md` is ignored too (git docs). The GitHub tree of `main` (checked 2026-11-13) has no `AGENTS.md` or `docs/`.
- Why it matters: (a) A branch from `main` in a fresh clone, a cloud agent (e.g. Codex cloud, which clones from GitHub) or a second worktree won't have any brief. (b) Even after `git add docs`, Claude's brief stays out silently. (c) Rule #5 says "CLAUDE.md is private, don't quote it", so an agent may also refuse to read `docs/agents/CLAUDE.md`.
- Confidence: high. Source: https://git-scm.com/docs/gitignore (pattern format) and https://github.com/Distractodog/yamhill-racer (tree of `main`).

#### 1.3 RM-1a's "5× smaller" is disk/history size, not download size
- Where: `docs/agents/CLAUDE.md` › RM-1a Goal ("each tile ~5× smaller on disk"). `RM-1b` › done when ("page load time … before/after").
- What: the live site already sends `.bin` and `.json` with `content-encoding: gzip`. Tile `0_0` is 8.13 MB on disk but about **2.7 MB on the wire**: surface.bin 4.0 MB → 69 KB, height.bin 1.07 → 0.92 MB, trees.bin 0.41 → 0.30 MB, tile.json 1.02 → 0.32 MB. Only `ground.png` (1.09 MB) goes uncompressed.
- Why it matters: RM-1a is still right for the 1 GB Pages/repo limits and git history. But players' load time will improve only a little (mostly ground.png → JPEG), so the owner shouldn't expect a big loading speed-up. Also, height.bin barely compresses with plain gzip. PLAN's measured 0.2–0.33 MB must come from something beyond plain gzip, or it's optimistic. Worth re-measuring.
- Confidence: high for the headers (curl of https://distractodog.github.io/yamhill-racer/assets/tiles/0_0/*, 2026-11-13). Medium for "load time barely changes".

#### 1.4 Gzip timestamps break RM-2's byte-identical check
- Where: `docs/agents/CHATGPT.md` › RM-2 done when ("two test builds … byte-identical (`diff -r`)"). `docs/agents/CLAUDE.md` › RM-1a (writes `.gz` directly from `build_tiles.py`).
- What: gzip headers store a modification time. Python's `gzip.compress` has defaulted to `mtime=0` only since 3.14, while `gzip.open`/`GzipFile` still default to the current time (Python docs).
- Why it matters: once RM-1a lands, two identical builds differ in every `.gz` header unless the packer passes `mtime=0`. Then RM-2's check fails, or the rebuild re-commits every tile ("git history balloons", CLAUDE.md › RM-4 Pitfall). Neither brief mentions it.
- Confidence: high. Source: https://docs.python.org/3/library/gzip.html

#### 1.5 Size budgets don't agree
- Where: `docs/agents/CLAUDE.md` › RM-1a Budget ("≤ 2.0 MB per tile"), › TW-2a/TW-2b Budget ("tile size growth ≤ +10%"), › RM-4 done when ("`du -sh game/assets` ≤ ~400 MB").
- What: 276 × 2.0 MB = 552 MB, and +10% for road classes gives about 600 MB. RM-4's ≤ ~400 MB check needs an average of ≤ ~1.4 MB per tile (PLAN measured ~1.3). Every piece can pass its own budget while RM-4 fails.
- Confidence: high (arithmetic). Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits (site ≤ 1 GB, source repo recommended ≤ 1 GB, 100 GB/month soft bandwidth, 10 min deploy timeout).

#### 1.6 Test builds aren't small, and RM-4's RAM figure is tight
- Where: `docs/agents/CLAUDE.md` › TW-2a ("`YR_TILES=…` … so a test build takes a minute"), › RM-4 ("~8 GB RAM peak"). `docs/agents/CHATGPT.md` › RM-2 ("test on 3 tiles only").
- What: `tools/build_tiles.py` sizes its global grids from `fetch_tiles.TX/TZ`, the bounding range of the whole `TILE_SET` (lines 28, 40–45), not from the tiles being built. Restricting `TILES` therefore does not shrink the global height grid or road carving. After RM-3, the bounding box grows from 28 × 20 km (560 km²) to about 38 × 38 km (~1,440 km²), roughly 2.6×. Scaling today's ~3.5 GB that way gives about 9 GB, more than the "~8 GB" estimate, on a 16 GB Mac.
- Why it matters: "a minute" is likely wrong. A 3-tile test build may cost close to a full-size run in RAM and time, especially once RM-3 has merged.
- Confidence: medium (code read on GitHub `main`, linear-scaling guess). Source: https://github.com/Distractodog/yamhill-racer/blob/main/tools/build_tiles.py

#### 1.7 Benchmarks are measured at the 60 Hz frame cap
- Where: `docs/agents/CURSOR.md` › Baselines ("Sheridan 16.7 ms / 0% … Campus 16.7 ms / 0%", "Nothing you add may make these worse"), › TW-0b Goal ("median ≤ 16.7 ms"), › TW-0a (samples `requestAnimationFrame` gaps).
- What: 16.7 ms is one 60 Hz frame. A rAF-gap median can't drop below it, and extra cost under the cap doesn't show. The "not worse" checks for Sheridan, Willamina and campus are blind until something blows the cap. TW-0b's target is the cap itself.
- Why it matters: regressions can pile up unnoticed across TW-1/TW-3p/CD pieces. Measuring CPU work per frame (e.g. time inside `frame()`) or using `renderer.info` counts would show them, and those are already partly in TW-0a.
- Confidence: medium (inferred from the identical 16.7 ms values; headless rAF pacing not separately verified).

#### 1.8 Tests and builds won't run in a cloud agent as written
- Where: `AGENTS.md` › Tests ("Browser tests launch Chrome at `/Applications/Google Chrome.app/...`"). `docs/agents/CHATGPT.md` › Git and Standard checks. `.gitignore` (`data/raw/`).
- What: `tools/shot.mjs`, `stream_test.mjs` and `vehicles_test.mjs` hard-code the macOS Chrome path. `data/raw/` (needed for any `build_tiles.py` run: RM-2, TW-4b counts, TW-2a) exists only on the owner's Mac. The ChatGPT brief never says whether "ChatGPT (Codex)" runs locally (CLI/IDE) or in the cloud.
- Why it matters: in the cloud, PAGEERR/STREAM/SHOT fail or get edited per run, RM-2/TW-4b test builds can't run, and "push nothing" means work can't come back except as a cloud PR.
- Confidence: high (code on GitHub `main`).

#### 1.9 Licences and data sources (the claims check out, with caveats)
- Where: `docs/agents/GROK.md` › R-3. `docs/agents/CHATGPT.md` › TW-4a/TW-4b. `AGENTS.md` › 6 Gotchas (credits).
- Verified: Google Open Buildings has **no US coverage** (Africa, S/SE Asia, Latin America, Caribbean only). Microsoft **US** Building Footprints is ODbL. Overture *buildings* is ODbL and asks for "© OpenStreetMap contributors, Overture Maps Foundation". The Meta/WRI canopy height data is CC BY 4.0.
- Risky: a 2026 third-party comparison lists Microsoft's *Global ML* footprints as CDLA-Permissive-2.0, while Overture says ODbL. Which Microsoft product TW-4a downloads changes the credit line, so R-3 should name the exact dataset and version.
- Wrong in the docs: `AGENTS.md` › 6 Gotchas says the `#credits` line has "CC0 engine sound". The live `game/index.html` `#credits` has only OSM, USGS 3DEP and Meta/WRI. NAIP, the CC0 sound and three.js are only in `README.md`. That's not a legal problem (public domain and CC0 need no credit; three.js is loaded from a CDN), but "update both" will confuse agents.
- Confidence: high for the licences. Sources: https://github.com/microsoft/USBuildingFootprints · https://docs.overturemaps.org/attribution/ · https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings_v3_polygons · https://registry.opendata.aws/dataforgood-fb-forests/ · https://terra-lab.ai/blog/building-footprint-datasets-compared (third-party, low)

#### 1.10 Smaller doc errors
- `docs/agents/CHATGPT.md` › TW-4b heights: "> 600 → 8 m; > 1500 → 8 m" repeats the same value (probably a typo), and nothing is given for 40–60 m² or 350–600 m². `docs/agents/CURSOR.md` › TW-1a classes have the same gaps (houses 60–350, outbuildings < 40, commercial > 600). Confidence: high (text).
- `docs/HANDOFF.md` › Rules #2 lists RM-5a among the `world.js` hooks, but `docs/agents/CHATGPT.md` › RM-5a hooks it in `main.js` (near `challenges.constrain()`, line 343 on `main`). `PLAN.md` › RM-5 says both. Confidence: high.
- `README.md` still says the map is "about 10 × 8 km" Willamina → Sheridan and lists only car controls. It's out of date since the Hwy 18/McMinnville band, bike, jet and glider. Low impact.
- Checked and OK: the line counts the briefs quote (build_tiles.py 524, drive.mjs 600, glider.js 318, track.js 73, vehicles_test.mjs 70, campusmodel.js ~180), the `rng` lines 34/470/483/489/490, `lonlat_to_world` at line 49, the `buildings` list near lines 114–135, the `campus.js` exports `rectPts`/`inPoly`, three.js 0.170.0, the `blur`/`visibilitychange` handlers at main.js 153–154, and `DecompressionStream` (widely available since May 2023, MDN). Line numbers will drift after each merge (see 2.6).

### 2. Missing steps
- **2.1 Commit the briefs to `main` before any piece starts.** That means `AGENTS.md`, `docs/HANDOFF.md`, `docs/agents/*`, `docs/research/*`, plus a `.gitignore` fix so `docs/agents/CLAUDE.md` isn't ignored. No brief says who does this. (`docs/HANDOFF.md` › How to hand out work.)
- **2.2 Getting Grok's research into the repo.** `docs/agents/GROK.md` › Git says the owner saves the file, but CD-*/TW-5/TW-4a read `docs/research/*` from `main`. Nobody owns committing and merging these files, so they may sit on a side branch Cursor never sees.
- **2.3 Where each agent works.** No brief says whether agents share one folder, use separate clones or use `git worktree`. Nor does any brief say which tool is local or cloud (see 3.1 and 1.8).
- **2.4 The noreply email** is "given by the owner" in every brief but recorded nowhere. Each agent will stop and ask, or guess.
- **2.5 Testing anything Pages-specific before going live.** Pages deploys only from `main` (`.github/workflows/pages.yml`), so `.gz` serving, the 1 GB limit and the 10-minute deploy timeout are first tested *live*. There's no preview/staging step (e.g. a second Pages repo or a `workflow_dispatch` dry run of the artifact size) and no rollback note beyond "old assets are in git".
- **2.6 Refreshing line numbers after merges.** CLAUDE.md, CHATGPT.md and CURSOR.md quote line ranges in `build_tiles.py` and `main.js` that will move after RM-1a/RM-2/TW-2a. Add "find by `grep`, not line number" to each, or a step to refresh the numbers after each merge.
- **2.7 When TW-4r happens.** `docs/agents/CLAUDE.md` › TW-4r reviews TW-4b, but HANDOFF's week table has TW-4b in week 4 and TW-4r in week 5. The `build_tiles.py` order also needs TW-4b *merged* before RM-4. Is the review before or after the merge?
- **2.8 Who adds the credits text.** TW-4b's report gives text for "the owner/Cursor" to add to `index.html` and `README.md`, but no piece does it. (`docs/agents/CHATGPT.md` › TW-4b done when.)
- **2.9 Owner decisions.** The roads Q1–Q4, campus spots/photos, BUG-2 A/B/C, ring colour and solid vs drive-through props all have defaults. But nothing says when the owner is asked, or that he confirms before RM-4 (which bakes several of them in).
- **2.10 Bandwidth estimate.** 100 GB/month soft limit ÷ ~1 GB per full-map session (276 tiles × ~2.7 MB on the wire, before packing) is roughly 100–300 full sessions a month. That's fine for a personal game, but nobody has written it down.

### 3. Conflicts between agents
- **3.1 One working copy, several agents.** Every brief starts with `git switch -c <piece> main`. Cursor's merge does `git switch main && git merge`. If Cursor, Claude Code and a local Codex run in the same folder, any `switch` changes files under the others, and uncommitted edits move to the wrong branch. `docs/agents/CLAUDE.md` › Git says "don't switch branches under other sessions" but gives no way to avoid it. (`docs/agents/CURSOR.md` › Git; `docs/HANDOFF.md` › Rules #1, #5.)
- **3.2 `world.js` hook order deadlocks.** `docs/HANDOFF.md` › Rules #2 and `docs/agents/CURSOR.md` › Waiting on others say TW-0b → **RM-1b** → TW-1b → TW-3p → RM-5. RM-1b is "on hold until the owner says start" (`docs/agents/CLAUDE.md` › RM-1a), yet HANDOFF's week table has TW-1b in week 2 and RM-1b in week 3. Taken literally, TW-1b waits on a paused piece.
- **3.3 The `build_tiles.py` order blocks all town rebuild work behind the round map.** RM-1a → RM-2 → TW-2a → TW-3g → TW-4b → RM-4 (`docs/HANDOFF.md` › Rules #2; `docs/agents/CLAUDE.md` › Waiting; `docs/agents/CHATGPT.md` › Waiting). TW-2a also explicitly "waits for … RM-1a merged". If the owner never says "start", roads, ground colours and footprints never run, although `PLAN.md` › RM-4 allows the opposite (round map without towns).
- **3.4 `game/src/data.js` has no owner and no order.** Cursor's TW-1b (collision `top`) and CD-1c (≤ 3 lines for `campuspatch.js`) and Claude's TW-2a (`PATH_KINDS`) and TW-2b (sidewalk physics overlay) all edit it. It isn't in any "you own" list or in HANDOFF Rules #2. All four are physics-critical ("DRIVE same numbers").
- **3.5 `roads.js` vs `meshmerge.js`.** Cursor's TW-0b adds far-distance LOD for road cells (drop markings past ~300 m) in `meshmerge.js`. Claude's TW-2b also adds "strip distance LODs (… no markings past ~300 m)" in `roads.js`, and must "leave alone `meshmerge.js`". Cursor must "never edit" `roads.js`. Two agents may build the same feature on opposite sides of a boundary neither may cross. TW-2b's "BENCH: McMinnville faster than Cursor's TW-0b result" then depends on Cursor's code. (`docs/agents/CURSOR.md` › TW-0b; `docs/agents/CLAUDE.md` › TW-2b.)
- **3.6 `AGENTS.md` edits.** TW-0a says to add a test-table row, and ChatGPT's "Tests" says to add a row per test. `docs/HANDOFF.md` › Rules #8 says the *owner* adds new commands. So several branches edit the same table, giving merge conflicts and two sets of instructions.
- **3.7 Same-agent overlaps if run in parallel sessions.** BUG-1 and BUG-2 both edit `glider.js`, and both are week 1. BUG-1, BUG-3, RM-5a and RM-5b all touch `main.js`. That's safe only one at a time, and nothing says so (`docs/agents/CHATGPT.md` › Waiting lists files, not sequencing). The owner has asked for parallel sub-sessions, so this is a real risk.
- **3.8 Root `CLAUDE.md` vs `docs/agents/CLAUDE.md`.** Claude Code loads the private root `CLAUDE.md` automatically. That file says to read `PLAN.md` (906 lines) every session, read a file outside the repo, agree a done-when checklist with the owner *before* building, and update PLAN/decisions/gotchas at the end. The brief says "read only what's named", "do only that piece" and "keep answers short". Those conflict, and the root file burns the tightest usage plan. (`CLAUDE.md` › At the start of every session, › Before building, › At the end; `docs/agents/CLAUDE.md` › Your role.)
- **3.9 Cursor merges its own pieces.** It's the only merger (`docs/agents/CURSOR.md` › Git), so its own branches get no second reader. Merges also use Cursor's usage, which already carries the most pieces.

### 4. Usage-limit risks (pieces too big for one sitting)
- **TW-1a (M → really L)**, `docs/agents/CURSOR.md`: 6+ building classes (houses, outbuildings, commercial, warehouses, schools, churches, apartments), L-shape splitting, porch orientation from road polylines, and a test script. Split it into houses, then downtown, then the rest, as its own default already suggests.
- **TW-1b (M → L)**, `docs/agents/CURSOR.md`: a new mesh builder with near and far LOD, possible window atlas/shader, frame-sliced generation, shadow range, a `data.js` collision change, campus skipping, and SHOTs in 3 towns × 2 views plus BENCH at 4 spots.
- **TW-0b (M, strongest model)**, `docs/agents/CURSOR.md`: each BENCH run is 4 spots × 20 s plus loading, run per group hidden and after every change. Many full runs per sitting.
- **BUG-1 (S–M)**, `docs/agents/CHATGPT.md`: 30 runs × 2 vehicles × 12 s, plus 100 stress runs, in headless Chrome with throttling. That's well over 30 minutes of wall clock, during which an agent would be "watching". It contradicts "never wait on or poll a job".
- **RM-4 (L, Claude)**, `docs/agents/CLAUDE.md`: a ~30 min build, then ramps, walls, STREAM across a 35 km circle, SHOTs of 5 areas, `vehicles_test`, one big commit, and an owner drive. That's too much for the tightest plan in one go. Split it into build+swap, checks, and commit.
- **RM-5a (M, strongest)**, `docs/agents/CHATGPT.md`: four vehicle types, jet and glider at 1000+ km/h, plus respawn and challenge interplay. It could split into ground vehicles first, then jet/glider.
- **R-2 (M, Grok)**, `docs/agents/GROK.md`: three towns, three files, with block-by-block Sheridan. It's already one file per town; do one town per sitting.
- **CD-1c**, `docs/agents/CURSOR.md`: it may end with "stop, hand to Claude's rebuild", which costs a sitting with nothing to show. Check whether a game-side patch is possible before starting.

## Gaps — what you couldn't find, and what to ask the owner
- Do Cursor, Claude Code and ChatGPT/Codex run in the **same folder** on the Mac, and is Codex local or cloud? (Decides how serious 3.1 and 1.8 are.)
- Are the `._*` files in the docs copy (macOS AppleDouble) real files in the repo folder, or just from the archive? If real, add `._*` to `.gitignore` before committing `docs/`.
- I didn't verify how GitHub Pages serves a `.gz` file (no `.gz` on the live site yet), only that it gzips `.bin`/`.json`. RM-1b's pitfall assumes no `Content-Encoding` on `.gz`; check this on the first deploy.
- Headless Chrome's rAF pacing (1.7) and build RAM scaling (1.6) are inferences, not measurements.
- Which Microsoft footprint product (US vs Global ML) and which licence version TW-4a will use. That's for R-3.
- Owner: is the round map going to start this month? If not, the `build_tiles.py` and `world.js` orders (3.2, 3.3) need re-ordering for the towns work.

## Sources
- Repo docs (local copy, 2026-11-13): `AGENTS.md`, `docs/HANDOFF.md`, `docs/agents/CURSOR.md`, `CHATGPT.md`, `CLAUDE.md`, `GROK.md`, `PLAN.md` (reference only), root `CLAUDE.md`, `README.md`.
- GitHub `main` (read only): https://github.com/Distractodog/yamhill-racer — `.gitignore`, `tools/build_tiles.py`, `tools/fetch_tiles.py`, `game/src/main.js`, `game/src/campus.js`, `game/index.html`, `game/assets/world.json`, `.github/workflows/pages.yml`, tree listing and file sizes via https://api.github.com/repos/Distractodog/yamhill-racer/git/trees/main?recursive=1
- Live headers: https://distractodog.github.io/yamhill-racer/assets/tiles/0_0/ (tile.json, height.bin, surface.bin, ponds.bin, trees.bin, ground.png)
- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- gitignore pattern rules: https://git-scm.com/docs/gitignore
- Python gzip `mtime`: https://docs.python.org/3/library/gzip.html
- DecompressionStream support: https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream
- Microsoft US Building Footprints (ODbL): https://github.com/microsoft/USBuildingFootprints
- Overture attribution and licences: https://docs.overturemaps.org/attribution/
- Google Open Buildings coverage: https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings_v3_polygons
- Meta/WRI canopy height licence: https://registry.opendata.aws/dataforgood-fb-forests/
- Third-party dataset comparison (low confidence): https://terra-lab.ai/blog/building-footprint-datasets-compared
