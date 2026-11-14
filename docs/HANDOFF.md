# Handing work to AI agents — the index

For the project owner. Four tools, each on a ~$20/month plan with **limited usage** (limits change: check each plan, and
assume any agent can run out mid-piece). So the work is cut into **pieces** (S = under an hour, M = one sitting, L = split it),
each ending at a committed, tested state.

**How to hand out work:** open the tool, paste **one line**, wait for its report.

| Tool | Paste this (change the piece ID) | Brief |
|---|---|---|
| Cursor | `Read docs/agents/CURSOR.md and do piece TW-0a.` | [CURSOR.md](agents/CURSOR.md) |
| Claude Code | `Read docs/agents/CLAUDE.md and do piece RM-1a.` | [CLAUDE.md](agents/CLAUDE.md) |
| ChatGPT (Codex) | `Read docs/agents/CHATGPT.md and do piece BUG-1.` | [CHATGPT.md](agents/CHATGPT.md) |
| Grok | `Read docs/agents/GROK.md and do task R-3.` | [GROK.md](agents/GROK.md) |

Each brief says: start with `AGENTS.md`, its pieces in order (goal, files to edit and leave alone, tasks, "done when" checks,
budget, pitfalls), git rules, what it must wait for, your open questions with defaults, and a report template.
`AGENTS.md` (repo root) is the shared guide to the game and the rules; agents never need to read the whole code.

## Who does what

| Tool | Strength | Pieces (size) |
|---|---|---|
| **Claude Code** (tightest limits: few, narrow) | Risky pipeline work | RM-1a pack tiles (M) · RM-1b packed loader (M) · TW-2a road classes (M) · TW-2b road drawing (M) · TW-3g town ground (S) · RM-4 the one rebuild (L, mostly commands) · TW-4r review (S) |
| **Cursor** | Visual work you watch and iterate | TW-0a benchmark (S) · TW-0b McMinnville speed (M) · TW-1a/1b/1c town buildings (M/M/S) · TW-3p street props (M) · CD-1a/1b/1c Main Building (M/M/S) · CD-2, CD-3a/3b, CD-4 (M each) · CD-5 (S each) · TW-5 landmarks (M each) · RM-6 round minimaps (M) · **merges branches** |
| **ChatGPT (Codex)** | Self-contained, testable packages | BUG-1 stuck bank (S–M) · BUG-2 glider in races (S–M) · BUG-3 jet visual test (M) · RM-2 seeded randomness (S) · RM-3 tile list + downloads (S) · RM-5a rim wall (M) · RM-5b ring (M) · TW-4a footprint download (M) · TW-4b merge footprints (M) · tests · later: ghost car, respawn |
| **Grok** | Research, no code | R-3 licences (S) · R-1a Main Building facts (S–M) · R-1b other campus (M) · R-2 landmarks per town (M) · R-4 plan review (S–M) → files in `docs/research/` |

The **round map** (RM-*) is approved but **on hold until you say "start"**. `PLAN.md` (private) has the full package text and history.

## Suggested order over the month (shift it whenever a tool hits its limit)
| Week | Cursor | ChatGPT | Claude | Grok |
|---|---|---|---|---|
| 1 | TW-0a, TW-0b (McMinnville faster) | BUG-1, BUG-2 | — (save usage) | R-3, R-1a |
| 2 | TW-1a, TW-1b (town buildings) | BUG-3, tests | RM-1a (if round map started) | R-1b, R-2 |
| 3 | TW-1c, CD-1a, CD-1b (Main Building) | RM-2, RM-3 (start downloads on your Mac), RM-5a | RM-1b | R-4 |
| 4 | CD-1c, TW-3p, RM-6 (JS part) | RM-5b, TW-4a, TW-4b | TW-2a, TW-3g | — |
| 5 | CD-2… and merges | ghost car / respawn | TW-2b, TW-4r, **RM-4** (you run the build commands) | TW-5 facts if needed |
Week 5+ then repeats: you playtest, then the next CD/TW-5 pieces.

## BR — bridges and overpasses (planned 2026-11-14, not started)
Owner, 2026-11-14: a full review of bridges **including overpasses**: "there are several spots where roads clip because
there is an overpass not being made." Today the game has no bridges and no rivers: every road follows the bare-earth lidar,
so a road over a river dips into the valley, and where two roads cross on different levels the build pulls them to one height
or one clips through the other. Pieces in order (BR-1 → BR-2 share `build_tiles.py`: one at a time, merged before the next):

| Piece | Size | Who | What |
|---|---|---|---|
| BR-0 | S–M | ChatGPT | audit: every OSM bridge/tunnel/layer way + road crossing without a junction + road over water, typed and screenshotted |
| BR-1 | M | ChatGPT | rivers and streams as water (pools stepping down each line, banks carved) |
| BR-2 | M–L | ChatGPT | bridge/overpass decks in the road build (no carve under, no harmonize pull-down, lower road keeps its height) |
| BR-3 | M | ChatGPT | physics under a deck: queries take the vehicle's height so a car below isn't snapped up onto it |
| BR-4 | M + M | Cursor | meshes: concrete deck, railings, piers; Sheridan Bridge's green Parker through-truss |
| BR-5 | L (commands) | Claude | one rebuild (468 tiles) + minimap re-bake with rivers |

Full piece text: BR-0 to BR-3 in [CHATGPT.md](agents/CHATGPT.md), BR-4 in [CURSOR.md](agents/CURSOR.md), BR-5 in [CLAUDE.md](agents/CLAUDE.md).
BR-0 can start any time; BR-4 can start on a test build from BR-2. A first draft of BR-1/2/3 (unfinished) is on the owner's
local branch `bridges` (not pushed).

## RJ — ramps, merges and splits (planned 2026-11-14, not started)
Owner, 2026-11-14, from a screenshot of a one-lane highway where an exit splits off to the left and an on-ramp feeds in:
"they all kinda blend together and it looks bad." Today the build treats every ramp meet as an ordinary junction (a wide fan
of asphalt, lines running into each other, no gore, no lane-ending taper), and ramps are built as wide as their main road.
RJ-1 shares `build_tiles.py` / `roadnet.py` with BR-1/BR-2: one piece at a time, merged before the next. **RJ-4 and BR-5 are one
rebuild** (468 tiles): don't rebuild for either alone.

| Piece | Size | Who | What |
|---|---|---|---|
| RJ-0 | S | ChatGPT | audit: every ramp meeting a road at < 30°, typed (exit / on-ramp / Y-split), screenshotted; the owner's spot is row 1 |
| RJ-1 | M–L | Claude | road build: parallel taper + widened lane + flat gore piece instead of a fan; ramps get their own width; heights follow the main road |
| RJ-2 | M | Cursor | markings: edge line follows the taper, dashed lane-drop line, gore V + chevrons, no crossing lines |
| RJ-3 | S–M | ChatGPT | physics (`data.js`) and the minimap draw the same tapers and gores |
| RJ-4 | — | Claude | folded into BR-5's single 468-tile rebuild + minimap re-bake |

Full piece text: RJ-0 + RJ-3 in [CHATGPT.md](agents/CHATGPT.md), RJ-2 in [CURSOR.md](agents/CURSOR.md), RJ-1 + RJ-4 in [CLAUDE.md](agents/CLAUDE.md).

## Rules that keep four agents from breaking each other
1. **One git branch per piece**, named after its ID in lower case (`tw-1b`, `bug-1`, `rm-1a`), made from the current `main`.
   Agents commit only on their branch as `Distractodog` with the GitHub noreply email. **No agent pushes `main`.** A branch is pushed
   only if you say so.
2. **Never run two agents on pieces that touch the same files.** Safe together: Cursor town/campus pieces ∥ ChatGPT bug/test/rim pieces ∥
   Claude road/tile pieces ∥ Grok research. Conflicts: campus pieces one at a time; `world.js` hooks in the order TW-0b → RM-1b → TW-1b → TW-3p → RM-5a;
   `build_tiles.py` one agent at a time in the order RM-1a → RM-2 → TW-2a → TW-3g → TW-4b → RM-4.
3. **Tile rebuilds happen once, by Claude (RM-4).** Others hand over code, not rebuilt tiles. Nobody else commits `game/assets/tiles/`.
4. **Long jobs run on your Mac as plain commands** (the briefs give them): the ~2 h tile download (RM-3) and the ~30 min build (RM-4). Agents
   start or check them; they don't sit and watch.
5. **Merging:** tell Cursor *"merge branch X"*. It merges into `main` locally, runs `npm run drive` and the piece's checks, and reports. **You** say
   OK before anything is pushed (a push publishes the game).
6. **Cheaper model first:** the briefs say when a cheaper model is fine (docs, tests, small fixes) and when to use the strongest.
7. **Public repo:** no personal names, emails, absolute local paths or secrets in any committed file. `PLAN.md` and the private notes stay on your computer;
   if an agent needs something from them it's already in its brief — paste text from `PLAN.md` into a chat only if you have to.
8. **After a piece lands:** tick it in `PLAN.md`; if the agent added a command or file, add it to `AGENTS.md`.

## If an agent runs out of usage mid-piece
Nothing is lost: every step is committed on its branch. Paste the same one-line message into the same tool later (or into another
tool) and add "continue from the last commit on branch X". Ask the agent for its **Usage note** in the report: it says where it stopped.

## Tips
- Agents can't judge "does it feel/look right": those items are marked **(owner)** — you playtest them.
- If an agent says a test failed or couldn't run, believe it and ask why; don't accept "should work".
- Start the week with Grok's licence note (R-3) before ChatGPT's TW-4a, and Grok's campus facts before Cursor's CD pieces if you have them.
