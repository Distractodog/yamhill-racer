# Brief for Grok — Yamhill Racer (research only, no code)

**Start here:** read `AGENTS.md` (repo root) for what the game is (skim sections 1 and 2 only), then this file. The owner pastes
one line such as *"Read docs/agents/GROK.md and do R-1a"*. Do only that task, then stop.

## Your role and your limits
You do **research and reference**, not code: facts, photos (links), licences, and a review of the plans. The coding agents
(Cursor, ChatGPT, Claude) read your files so they don't have to research. Your plan is ~$20/month with **limited usage (check
your plan)**: each task below is small (S/M) and ends in one saved file; do one per sitting. Search the web; prefer primary
sources (school/city/county sites, official museum pages, university pages, county GIS, OpenStreetMap wiki, licence texts).
Never write or change code files. Public repo: **no personal information about any private person** (staff, students, neighbours) —
only facts about buildings and public places.

## Output format (every task) — save as `docs/research/<topic>.md`
```
# <topic> — research notes (<date>)
Status: draft | reviewed
## Summary (≤ 10 lines: what the coding agent needs to know)
## Facts            one block per item:
### <Name>
- What / where: <description, coordinates or nearest street, approx. world x,z if you can, else "unknown">
- Size: <storeys, length × width, height> — confidence: high/medium/low — source: <link>
- Materials & colours: <walls, roof type + pitch, trim, doors, windows (count/rhythm)> — confidence — source
- Distinctive features: <list>
- Photos: <links to freely viewable photos, with what each shows; don't paste images>
- Notes for the game: <what would be easy to get wrong>
## Gaps — what you couldn't find, and what to ask the owner
## Sources — every link used
```
Rules: say how sure you are of each fact; separate fact from guess; quote nothing long (summarise, ≤ 15 words per quote,
with the link); no invented numbers — write "unknown". Dimensions in metres (convert and note the original unit).

## Tasks, in order (suggested spread over the month)

### R-3 — building-data licences (S) → `docs/research/building-data-licences.md` — **do first** (ChatGPT's TW-4a waits for it)
- Compare open building-footprint sources for the Yamhill County area: **Microsoft US Building Footprints**, **Overture Maps buildings**, **Google Open Buildings** (if it covers the US), **OpenStreetMap** (ODbL), county GIS. For each: coverage (is Sheridan, Oregon covered?), licence name + version, whether it can be used in a **public website game** that already uses OpenStreetMap data (ODbL share-alike: does mixing matter? ask "what must we publish/credit?"), exact required credit wording, how to download only a bounding box, file format, approximate size, whether heights are included.
- Recommend **one** source with the reasons, and the exact credit sentence to put in the game's credits line.

### R-1a — Main Building (S–M) → `docs/research/campus-main-building.md`
- The Delphian School (Sheridan/McMinnville area, Oregon) **Main Building**: front facade (Art Deco brick, bays, piers, stone spandrels, coping, tower), entrance (steps, canopy, door, lettering "THE DELPHIAN SCHOOL"), front lawn/loop drive, the courtyard (chapel windows, kitchen wing, fountain, planters, fire stair), back/west wing/parking side, roof. Use the school's own public site/tour pages, public photos and news. Give window counts and rhythm per facade if you can see them.

### R-1b — other campus buildings (M) → `docs/research/campus-other.md`
- Larson Hall / Heron Books HQ, Dragon Hall + Student Lounge, gymnasium + track, dorms/staff houses (public descriptions only), barns/equestrian centre, greenhouse/lath house, tennis courts, basketball court, playground, archery range, RC car track, pond campground shelter, bus parking, Early Childhood Development Center / Lower School. What exists, what each looks like, and which the coding agents will find hardest. Also list campus signs, flagpole, lamp-post style, bench style.

### R-2 — town landmarks (M) → `docs/research/landmarks-<town>.md` (one file per town: `landmarks-mcminnville.md`, `landmarks-sheridan.md`, `landmarks-willamina.md`)
- **McMinnville:** Third Street downtown blocks (building heights, materials, awnings, street trees, historic names), Evergreen Aviation & Space Museum (hangars, the 747 on the waterpark roof, dimensions), Linfield University main quad, the water tower, other recognisable buildings. **Sheridan:** Main Street storefronts, the grain elevator by the tracks, other landmarks (note OSM is missing most of Sheridan's buildings: describe the downtown block by block if you can). **Willamina:** the mill area and main street.
- End each file with **"Which matter most"**: rank the 5 most recognisable landmarks per town by how well a player would notice them, with a one-line reason.

### R-4 — review the plans for gaps (S–M) → `docs/research/plan-review.md`
- Read `AGENTS.md` and `docs/HANDOFF.md` and `docs/agents/*.md`. List (1) wrong or risky assumptions (e.g. a licence, a data source, a technical claim), (2) missing steps, (3) things that conflict between agents (two agents editing the same file), (4) usage-limit risks (pieces too big for one sitting). Be specific (file + section). Don't propose rewrites of code.

## Git
- You normally have no repo access: **deliver the file text** to the owner, who saves it as `docs/research/<topic>.md` (or paste it into a Cursor/ChatGPT chat to commit). If you do have repo access: branch `research-<topic>`, commit identity `Distractodog` + the GitHub noreply email the owner gives you, **never push `main`**, push nothing without the owner's OK.

## Waiting on others
- None for R-3, R-1a, R-1b, R-2 (start any time). R-4 waits until the other briefs exist (they do now).
- Who reads your files: Cursor (CD-1…CD-5 read `campus-*.md`; TW-5 reads `landmarks-*.md`), ChatGPT (TW-4a reads `building-data-licences.md`), Claude (RM-4 credit wording).

## Open questions for you
- None — but tell the owner which facts you could not find, so he can send photos (the best photos: Main Building front/entrance, courtyard, back/kitchen side, Larson Hall, Dragon Hall, gym entrance).

## Report back (send the owner this)
```
Task: <R-id>   File: docs/research/<topic>.md (text attached / saved)
Confidence summary: <how much is high/medium/low>
Biggest gaps (need owner's photos or answers): <list>
Anything the coding agents should know first: <1–3 lines>
Usage note: <where you stopped if you hit limits>
```
