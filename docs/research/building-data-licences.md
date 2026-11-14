# building-data-licences — research notes (13 November 2026)

Status: draft

## Summary (≤ 10 lines: what the coding agent needs to know)

Recommend **Overture Maps buildings** (latest public release at the time of this note: `2026-10-21.0`) as the source for ChatGPT’s TW-4a `tools/fetch_buildings.py`. It covers Sheridan, Oregon (global buildings theme; OSM first, then Microsoft ML footprints fill gaps). The theme is published under the Open Database License (ODbL), the same licence already used for the game’s OpenStreetMap roads and buildings, so mixing is compatible. Download only a bounding box with the official `overturemaps` CLI, write GeoJSON, then clip to `TILE_SET` and save `data/raw/footprints.geojson` (git-ignored). A `height` field in metres is present when a source provides it; if it is unset, use TW-4b’s area-class defaults. Google Open Buildings does **not** cover the United States. Yamhill County has a Structures Footprints layer, but no named open licence was found, so do not merge it into the ODbL building set. Exact credits line: **Map data © OpenStreetMap contributors, Microsoft, and Overture Maps Foundation. Available under the Open Database License.** Link “OpenStreetMap” and/or the licence words to https://www.openstreetmap.org/copyright.

## Facts

### Microsoft US Building Footprints

- What / where: Computer-generated building polygons for all 50 US states and the District of Columbia, including Oregon, so Sheridan, Oregon is covered. Official total 129,591,852 footprints; Oregon file has 1,873,786 footprints. Coordinate system EPSG:4326. This is the older, state-partitioned US release. Microsoft later published a global refresh (see the note at the end of this block). World x,z: unknown (download in lon/lat, then convert with the existing `lonlat_to_world` helper).
- Size: Official format is GeoJSON, one zip per state. Oregon unzipped size is 545.94 MiB (figure published by Microsoft; do not invent a clipped size for the game bbox — unknown until clipped). Heights are not included: the documented contents are footprint polygon geometries only, plus a capture-date tag when Microsoft could deduce imagery vintage. Vintage varies: Microsoft says footprints in a highlighted update region are from 2019–2020, and the rest come from older imagery averaging about 2012. Whether Yamhill County sits in the 2019–2020 region was not checked here. — confidence: high for Oregon coverage, format, state file size, and lack of a height field; low for the vintage of Sheridan itself — source: https://github.com/microsoft/USBuildingFootprints
- Materials & colours: not applicable (licence research, not a modelled building).
- Distinctive features:
  - Licence name and version: Open Data Commons Open Database License (ODbL). Microsoft’s data licence file does not print a version number; it links the ODbL, whose current published text is ODbL 1.0 (https://opendatacommons.org/licenses/odbl/).
  - Public website game that already uses OSM (ODbL): yes, this can be used. Both datasets are ODbL. Merging Microsoft footprints with the game’s OSM buildings (TW-4b: drop a new footprint if more than 30% of its area overlaps an OSM footprint) creates a combined building database that must stay under the ODbL. You must not add any later source that cannot be offered under the ODbL (ODbL 1.0 §4.4.d).
  - What must be published or credited: (1) visible credit in the Produced Work (the public game) and in the repo README; (2) if you Publicly Use a Derivative Database, or a Produced Work made from one, offer recipients a machine-readable copy of that database **or** a file describing the method and additional contents that produce it (ODbL 1.0 §4.6). Practical path for this repo: keep `tools/fetch_buildings.py` and `tools/footprints.py` public, record the source URL and date, and on request point people at those scripts plus the upstream Microsoft and OSM downloads. The baked tile files are a Produced Work, not a substitute for that offer. Microsoft does not publish a unique credit sentence beyond licensing the data under the ODbL; use the ODbL example notice, naming the dataset.
  - Exact required credit wording: Microsoft specifies no unique phrase. ODbL 1.0 §4.3 asks for a notice naming the database and stating it is available under the Open Database License (ODbL). Filled-in wording to use: Contains information from Microsoft US Building Footprints, which is made available here under the Open Database License (ODbL). Link the dataset to https://github.com/microsoft/USBuildingFootprints and “Open Database License (ODbL)” to https://opendatacommons.org/licenses/odbl/. Combined with the existing OSM credit, a credits-line sentence would be: “Map data © OpenStreetMap contributors and Microsoft. Available under the Open Database License.”
  - How to download only a bounding box: there is no official bbox API. Download the Oregon state GeoJSON zip and clip locally to the map bbox, then to `TILE_SET`. Oregon URL (as published on the repo README): https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Oregon.geojson.zip
- Photos: not applicable.
- Notes for the game: Workable ODbL fallback if Overture is unavailable. Downsides for TW-4a: no official bbox cut (must fetch ~546 MiB unzipped for all of Oregon), no heights, and the dataset is older than Microsoft’s later global refresh. Do not import blindly into OpenStreetMap (Microsoft itself warns against overwriting local mapping).

Note on the later Microsoft dataset (not the named “US Building Footprints” title, but it is the current Microsoft open footprint product and is already folded into Overture): **Microsoft Global ML Building Footprints** (https://github.com/microsoft/GlobalMLBuildingFootprints) covers the United States, including a 12 October 2022 refresh of the US data, with further US updates in 2025–2026. Licence: Community Data License Agreement – Permissive, Version 2.0 (https://cdla.dev/permissive-2-0/), which is more permissive than ODbL and may be mixed into an ODbL game. CDLA 2.0 does not require a credit sentence; if you *share the data* (for example if `footprints.geojson` is published), you must include the text of CDLA 2.0 with it (§2.1). Heights: yes, in metres, from a model average inside each polygon; buildings with no estimate have height `-1`. Format: files named `.csv.gz` whose contents are line-delimited GeoJSON, partitioned by country and Bing Maps level-9 quadkey. Official index: https://bfppub.blob.core.windows.net/%24web/2026-08-13/dataset-links.csv (updated 13 August 2026). There is no first-party one-shot bbox flag; download the United States quadkey files that intersect the map bbox, then clip. Approximate size of a Yamhill clip: unknown. Overture’s attribution page still describes this Microsoft dataset as ODbL, which does not match Microsoft’s current CDLA 2.0 README — see Gaps.

### Overture Maps buildings

- What / where: Global buildings theme compiled by the Overture Maps Foundation. OpenStreetMap is the highest-priority source; Microsoft ML footprints (and other open sources) are used to fill gaps. Global coverage, so Sheridan, Oregon is covered. Feature types: `building` (outer footprint / roofprint) and `building_part` (from OSM only). Geometry is kept identical to the source. World x,z: unknown until converted with `lonlat_to_world`.
- Size: Official cloud format is GeoParquet on Amazon S3 and Azure (latest paths seen in the docs use release `2026-10-21.0`). A bbox download can be written as GeoJSON, GeoParquet, or other formats supported by the CLI — GeoJSON matches TW-4a’s `data/raw/footprints.geojson`. Approximate size of a clip to the current 51-tile map, or to the planned ~17.8 km round-map bbox, is unknown until downloaded (the official tool transfers only features inside the bbox). Heights: the schema includes `height` (metres, lowest to highest point, must be > 0), plus optional `num_floors`, `min_height`, and `roof_height` (metres). These are filled when a source provides them and may be merged across matched footprints; many features have `height` unset (the schema example is null). Features with height 900 m or more are excluded by Overture. — confidence: high for licence, coverage, official download method, and the existence of a height field; medium for how often heights are actually populated in Yamhill County (not measured here) — source: https://docs.overturemaps.org/guides/buildings/ and https://docs.overturemaps.org/schema/reference/buildings/building/
- Materials & colours: not applicable. (The schema also has optional facade/roof colour and material fields, usually empty for ML footprints.)
- Distinctive features:
  - Licence name and version: Overture publishes the **buildings theme under the ODbL** because it includes OSM data. The docs do not print “ODbL 1.0”, but they mean the Open Data Commons ODbL used by OSM (ODbL 1.0). Other sources are only added if they are ODbL or a licence Overture treats as compatible (they name CC BY 4.0 as an example).
  - Public website game that already uses OSM (ODbL): yes. This is the cleanest mix: the buildings theme is already ODbL, already conflated (OSM preferred; other sources fill holes; overlap between sources is not kept), and already includes the Microsoft gap-fill that TW-4 needs for Sheridan. The public game is a Produced Work. The merged building list used to bake tiles should be treated as an ODbL database (or as part of one). Same publish-or-describe-the-method duty as above (ODbL 1.0 §4.6). Because Overture already contains OSM buildings, TW-4b will correctly drop a large number of overlaps against `osm_region.json`; that is expected, not a bug.
  - What must be published or credited: visible Produced Work credit, plus the §4.6 offer of the derivative database or the method. Credit OpenStreetMap and Overture, and also any theme source whose data is actually present in the extract (see Overture’s attribution page). For a Yamhill County / Sheridan extract the sources that will almost certainly appear are OSM and Microsoft. Google Open Buildings does not cover the US, so that credit should not be needed here. After the download, TW-4a should list unique `sources[].dataset` values in `footprints.geojson` and add any extra required names (for example Esri Community Maps, or USGS 3DEP if it was used for height).
  - Exact required credit wording: Overture does not impose a single mandatory sentence for every product. For its own Explore tool it uses: “© OpenStreetMap contributors, Overture Maps Foundation.” The buildings-theme source list to draw from is: “© OpenStreetMap contributors. Available under the Open Database License.”; “Esri Community Maps contributors. Available under CC BY 4.0.”; “Global ML Building Footprints. Licensed by Microsoft under the Open Database License.”; plus other sources that do not apply to Oregon (Google Open Buildings, an East Asia dataset, and Spanish IGN data). For this game, the recommended single credits-line sentence is in the Recommendation section below. Link “OpenStreetMap” to https://www.openstreetmap.org/copyright (OSMF’s preferred way to show that the data is under the ODbL). Optional second link: https://docs.overturemaps.org/attribution/
  - How to download only a bounding box: official Python client, no account.
    1. `pip install overturemaps`
    2. `overturemaps download --bbox=MINLON,MINLAT,MAXLON,MAXLAT -f geojson --type=building -o data/raw/footprints.geojson`
    The `--bbox` order is xmin, ymin, xmax, ymax (west, south, east, north). The client reads Overture’s cloud GeoParquet and transfers only the bbox. Then clip features to `TILE_SET`. DuckDB against `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/*` (region `us-west-2`) is a documented alternative. The CLI can resolve the latest release via the STAC catalog (https://stac.overturemaps.org/catalog.json) so the downloader should not hard-code a stale release id unless pinning is wanted for reproducibility (if pinned, record the release in the script comments and the TW-4a report).
- Photos: not applicable. The buildings guide has a US-Mexico border illustration of source mixing; not needed for the game.
- Notes for the game: This is the recommended default for TW-4a. Prefer a feature’s `height` (metres) when it is present and greater than 0; otherwise use TW-4b’s area-class defaults. Do not use `height == 900` or over (already excluded upstream). Campus buildings stay hand-authored (`campus.js`) and should continue to win over these footprints.

### Google Open Buildings

- What / where: Google Research Open Buildings v3 — 1.8 billion detections over 58 million km² in **Africa, Latin America, the Caribbean, South Asia, and Southeast Asia**. Official pages do not list the United States or Oregon. **Sheridan, Oregon is not covered.** The project is aimed at Africa and the Global South. A companion “2.5D Temporal” raster dataset covers the same non-US regions. World x,z: not applicable.
- Size: Official v3 polygons total 178 GB as CSV (one file per S2 level-4 cell, cells up to 7.8 GB); a points edition is 48 GB. Format: CSV with a WKT polygon, confidence, area in square metres, and a Plus Code; also an Earth Engine FeatureCollection and an explorer map. Heights: v3 polygon footprints have **no height**. The separate 2.5D temporal rasters include height, but only for the same non-US coverage, so they do not help this map. — confidence: high that the US is outside the coverage and that v3 polygons have no height — source: https://sites.research.google/open-buildings/ and https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings_v3_polygons
- Materials & colours: not applicable.
- Distinctive features:
  - Licence name and version: dual-licensed. The official dataset FAQ says the user may choose either Creative Commons Attribution 4.0 (CC BY-4.0) or Open Data Commons Open Database License (ODbL) v1.0. (The Earth Engine catalog page mentions only CC-BY-4.0; the project site’s FAQ is the fuller statement.) Either choice could be mixed with OSM in principle (pick ODbL v1.0 if it were ever used beside OSM).
  - Public website game already using OSM: licence would be workable **if** the area were covered, but it is not. Do not use this dataset for Yamhill Racer.
  - What must be published or credited: under CC BY 4.0, give appropriate credit, link the licence, and say if changes were made (https://creativecommons.org/licenses/by/4.0/). Under ODbL v1.0, use the ODbL attribution and share-alike rules. Suggested credit if it were used: “Building outlines from Google Open Buildings, available under [chosen licence].”
  - Exact required credit wording: Google does not mandate one sentence. It asks users to consider citing: W. Sirko et al., “Continental-scale building detection from high resolution satellite imagery,” arXiv:2107.12283, 2021.
  - How to download only a bounding box: not relevant here (no US data). In covered regions, Google provides S2-cell CSVs, a Colab notebook that clips an area of interest, and Earth Engine.
- Photos: not applicable.
- Notes for the game: Skip. Overture lists Google Open Buildings as a buildings-theme source, but that source does not apply inside the United States, so a Yamhill extract should not contain it.

### OpenStreetMap (ODbL)

- What / where: The game already uses OSM for roads, buildings, lakes and related features (baked by `tools/fetch_tiles.py` into `data/raw/osm_region.json`, then into tiles). OSM covers the Sheridan / Willamina / McMinnville area for roads. Building footprints in Sheridan are known to be incomplete: `docs/agents/GROK.md` (R-2) and `PLAN.md` (TW-4) state that OSM is missing most of Sheridan’s buildings and that filling those gaps is the point of TW-4. An exact downtown count was not obtained in this pass (the Overpass request from this environment failed). McMinnville already has a large OSM building set (PLAN.md notes 11,630 footprints in a 3.5 km view, from screenshots dated 13 November 2026). World x,z: already handled by the existing pipeline.
- Size: A bbox can be downloaded as OSM JSON/XML or filtered from a regional extract. Geofabrik’s Oregon extract `oregon-latest.osm.pbf` is 243 MB (data up to 12 November 2026, 21:23 UTC, which is 13:23 on 12 November 2026, Pacific Time). That file is the whole state, all feature types, not a building-only clip; the size of a building-only clip of the game bbox is unknown here. The game already fetches OSM for its own bounding box, so TW-4a should not replace that extract. Heights: only when tagged. `height=*` is in metres by default (OSM wiki). `building:levels=*` is a floor count, not a metre height. Many rural and small-town buildings have neither tag; TW-4b already plans area-class defaults for those. — confidence: high for the licence, official credit rules, Oregon extract size, and the height tag unit; medium for the exact completeness of Sheridan buildings (project docs, not a fresh count) — source: https://www.openstreetmap.org/copyright , https://wiki.openstreetmap.org/wiki/Downloading_data , https://download.geofabrik.de/north-america/us/oregon.html , https://wiki.openstreetmap.org/wiki/Key:height
- Materials & colours: not applicable.
- Distinctive features:
  - Licence name and version: Open Data Commons Open Database License (ODbL) 1.0, published by the OpenStreetMap Foundation (OSMF). Licence text: https://opendatacommons.org/licenses/odbl/1-0/ and https://wiki.openstreetmap.org/wiki/Open_Database_License/ODbL-1.0.txt
  - Public website game already using OSM: this *is* the existing source. The live game (https://distractodog.github.io/yamhill-racer/) is Public Use of a Produced Work. You may put your own terms on the game code and assets, but you must credit OSM, make clear that the map data is under the ODbL, and (if you have made a Derivative Database) offer that database or the method of making it (ODbL 1.0 §4.6; OSMF Legal FAQ).
  - Mixing / share-alike: if you alter or build upon OSM data, the resulting database may be distributed only under the ODbL (or a later / compatible licence). Adding a substantial set of extra buildings into the same building list used to build the map should be treated as a Derivative Database, not as a way to escape share-alike. A Collective Database (a separate, independent layer kept apart from OSM) is a narrower option under OSMF guidance; TW-4b’s planned merge into one building list is the derivative-database case. Compatible additions: other ODbL data (Microsoft US Building Footprints, Overture buildings) and permissive licences that allow relicensing or inclusion (CDLA Permissive 2.0, CC BY 4.0). Incompatible or unclear additions must not be merged (Yamhill County GIS until a written compatible licence exists).
  - What must be published or credited: attribution to “OpenStreetMap”, plus a way to see that the data is under the ODbL (OSMF’s usual method is to link the name to https://www.openstreetmap.org/copyright). For computer games, OSMF’s Attribution Guidelines (adopted 25 June 2021) allow the credit on a splash screen, in the game view, on a credits page, in a menu, or another suitable place; more detailed licence information must be easy to find if the short line is brief. The current README line, “Map data © OpenStreetMap contributors (ODbL),” is in the right family; it should keep a link to the copyright page when used in the HTML `#credits` line.
  - Exact required credit wording: attribution must be to “OpenStreetMap”. Historical forms “© OpenStreetMap contributors” or “© OpenStreetMap” are acceptable. OSMF also gives “Map data from OpenStreetMap.” as a qualified form. The ODbL 1.0 §4.3 example is: “Contains information from DATABASE NAME, which is made available here under the Open Database License (ODbL).”
  - How to download only a bounding box: Overpass API (bbox order in Overpass QL is south, west, north, east) or the documented Overpass / Export Tool path; or clip Geofabrik’s Oregon PBF with Osmosis / osmium. Do not use the main OSM editing API for bulk downloads. The game already does a bbox Overpass-style fetch in `tools/fetch_tiles.py`; if that times out on a larger round-map bbox, the ChatGPT brief already says to split the box into four requests.
- Photos: not applicable.
- Notes for the game: OSM remains the source for roads and for any building it already has. The new footprint file is only to fill holes. Campus hand models continue to replace OSM/footprint blocks under campus polygons.

### Yamhill County GIS

- What / where: Yamhill County, Oregon (Sheridan, Willamina, McMinnville and the rest of the county). The county GIS Hub is described as the place to explore maps and download GIS layers. The 2023 Planning map service lists a **Structures Footprints** layer (layer 30) and a Structures layer (layer 29). Service text on that MapServer page says it is current as of 23 March 2023. Sheridan is inside the county, so a county-wide structures layer would be expected to include it; this pass did not successfully query the layer, so density and completeness on Sheridan Main Street are unverified. World x,z: unknown. Native spatial reference on the service is NAD 1983 HARN State Plane Oregon North (FIPS 3601), international feet; a download should be reprojected to EPSG:4326 before `lonlat_to_world`.
- Size: File format from the service: the MapServer supports query output in JSON and GeoJSON, and the county points the public to self-service downloads at https://yamhillcountymaps.com/ (fee schedule: GIS data “at no charge”). Approximate file size and feature count: unknown (the layer metadata and query endpoints could not be fetched in this environment: WebFetch returned HTTP 500, and direct HTTPS requests failed a TLS handshake). Heights: unknown (field list not retrieved). — confidence: high that a Structures Footprints layer exists and that the county currently offers GIS downloads at no charge; medium that Sheridan is included; low for size, format of the hub download, and heights — source: https://www.yamhillcountygis.com/server/rest/services/2023_Planning/Private_2023/MapServer , https://www.yamhillcounty.gov/162/Geographic-Info-Systems , https://www.yamhillcounty.gov/370/Fee-Schedule
- Materials & colours: not applicable.
- Distinctive features:
  - Licence name and version: **no named open licence was found** (not ODbL, not CC, not a public-domain dedication). Access to the GIS Hub requires agreeing to a disclaimer: the data is offered for convenience, may contain errors, carries no warranty, and is not suitable for legal, engineering or surveying use; use is at the user’s sole risk (https://www.yamhillcounty.gov/162/Geographic-Info-Systems). That is a no-warranty / terms-of-use notice, not a copyright licence to copy, adapt, or sublicense a derived database. Older “Request for Public Information” forms for some Assessor extracts said the data would be used for internal purposes only and not sold; the current fee schedule says GIS layers themselves are self-service and free, but it still does not grant an open licence.
  - Public website game already using OSM (ODbL): **do not merge this into the OSM-derived building database** unless the county gives written terms that allow redistribution and ODbL share-alike. ODbL 1.0 §4.4.d forbids adding contents to a Derivative Database that are incompatible with the ODbL. Without a clear grant, compatibility is unknown, so the safe answer is no.
  - What must be published or credited: not established. If the owner later gets written permission, follow whatever credit the county asks for, and keep that layer out of the ODbL merge until the permission is compatible. Even then, the disclaimer says not to rely on the data for surveying-grade work.
  - Exact required credit wording: none found.
  - How to download only a bounding box: the county directs users to https://yamhillcountymaps.com/ after accepting the terms. The ArcGIS REST service can also be queried by geometry (GeoJSON output, `MaxRecordCount` 1000, so paging would be required). That endpoint was not successfully called here, so treat the hub as the official path and confirm the exact export steps in a browser.
- Photos: not applicable.
- Notes for the game: Attractive as local authoritative data, but the licence is the blocker. Leave it out of TW-4a / TW-4b. If the owner wants it later, ask Yamhill County GIS (yamhillgis@yamhillcounty.gov, 503-434-7521) for written permission to use Structures Footprints in a public web game, to adapt the geometry, and to combine it with ODbL map data.

### Recommendation (one source)

**Use Overture Maps buildings** as the single default source for `tools/fetch_buildings.py`.

Reasons:
1. Sheridan, Oregon is in the global theme, and the theme is built to do exactly what TW-4 needs: keep OSM footprints, fill the holes (including Sheridan) from Microsoft ML data, and avoid stacking sources on the same building.
2. The licence is ODbL, already used by the game, so share-alike mixing is straightforward. No unclear county terms, and no reliance on a US-absent Google dataset.
3. Official bbox download in one command, output GeoJSON, which is what TW-4a is specified to write (`data/raw/footprints.geojson`, git-ignored, then clip to `TILE_SET`).
4. Optional height in metres when a source provides it, which TW-4b can prefer over area-class guesses. Microsoft US Building Footprints alone has no heights and requires a full-state download.
5. Monthly releases and a STAC “latest” pointer, so the downloader can stay current or pin a recorded release.

Fallback if the Overture CLI or cloud files are unavailable: Microsoft US Building Footprints (ODbL; download Oregon, clip to the bbox). That is legally fine and covers Sheridan, but is older and has no heights. Microsoft Global ML is newer and has some heights, but Overture already includes it; using Global ML alone would also add a CDLA 2.0 notice if the clipped file is published.

Exact credit sentence to put in the game’s `#credits` line and in `README.md` (extends the current OSM line; do not drop OSM, because roads and other OSM features remain):

**Map data © OpenStreetMap contributors, Microsoft, and Overture Maps Foundation. Available under the Open Database License.**

In HTML, link “OpenStreetMap” (and, if space allows, “Open Database License”) to https://www.openstreetmap.org/copyright. A second link to https://docs.overturemaps.org/attribution/ may sit in the README or an About / data-licences note. If TW-4a finds further `sources[].dataset` values that Overture says to credit (for example Esri Community Maps), append those names. OSMF game guidance is satisfied by this line in `#credits` plus the same sentence in README; a How-to-play or Settings panel is an extra safe place, not a replacement.

What TW-4a should do with this file:
- Default the downloader to Overture buildings, bbox = the map’s lon/lat bounding box, then clip to `TILE_SET`.
- Save `data/raw/footprints.geojson`.
- Print a footprint count inside a stated Sheridan downtown box (define the box in the script and report it).
- Quote the source, the ODbL, and the credit sentence above in the TW-4a report.
- Let the owner run the command if it takes more than about five minutes.
- Do not add Yamhill County GIS or Google Open Buildings.

What TW-4b should remember:
- Overlap with OSM is expected; drop new footprints at the planned 30% area overlap.
- Use Overture `height` in metres when present and valid; otherwise the planned area-class defaults; OSM tags already win on overlapped (kept) OSM footprints.
- Hand the credits sentence to the owner / Cursor for `game/index.html` `#credits` and `README.md`; do not forget the ODbL §4.6 “scripts + source URLs” offer.

## Gaps — what you couldn't find, and what to ask the owner

- Exact byte size and feature count of an Overture (or Microsoft) clip to the current `TILE_SET`, and to the planned 17.8 km round-map bbox — not downloaded in this pass (research only). TW-4a will measure this.
- A fresh OSM building count for Sheridan downtown — the Overpass request from this environment failed. The “OSM is missing most of Sheridan’s buildings” statement is from the project briefs, not a new census.
- Whether Microsoft’s 2019–2020 US update region includes Yamhill County.
- How often Overture `height` is filled in this county, and whether Esri Community Maps or USGS 3DEP appear in a local extract — inspect `sources[]` after the first download.
- Yamhill County Structures Footprints: field list, height attributes, feature count, exact hub export steps, and any copyright / redistribution wording beyond the no-warranty disclaimer. The REST layer page did not load here (HTTP 500 / TLS errors). Ask the owner only if he wants to pursue a written county licence; it is not required for TW-4a.
- Licence mismatch: Overture’s attribution page still says Microsoft Global ML Building Footprints are under the ODbL; Microsoft’s current Global ML README says CDLA Permissive 2.0. For data taken *from Overture*, follow Overture’s ODbL theme licence and attribution list. For data taken *directly* from Microsoft’s Global ML repo, follow CDLA 2.0.
- An Oregon GEO / Framework “statewide building footprints” compilation was discussed in a 18 November 2024 meeting PDF; a public dataset and licence were not confirmed here and are not needed if Overture is used.

No owner photos are needed for this task. The owner question already in PLAN.md / the ChatGPT brief — “OK to use this data source’s licence?” — should default to yes for Overture, because it is ODbL and compatible with the existing public OSM-credited game. This is not legal advice; it is a reading of the published licences and attribution guides.

## Sources — every link used

- https://github.com/microsoft/USBuildingFootprints
- https://raw.githubusercontent.com/microsoft/USBuildingFootprints/master/README.md
- https://raw.githubusercontent.com/microsoft/USBuildingFootprints/master/LICENSE-DATA
- https://minedbuildings.z5.web.core.windows.net/legacy/usbuildings-v2/Oregon.geojson.zip
- https://opendatacommons.org/licenses/odbl/
- https://opendatacommons.org/licenses/odbl/1-0/
- https://github.com/microsoft/GlobalMLBuildingFootprints
- https://raw.githubusercontent.com/microsoft/GlobalMLBuildingFootprints/main/README.md
- https://cdla.dev/permissive-2-0/
- https://bfppub.blob.core.windows.net/%24web/2026-08-13/dataset-links.csv
- https://docs.overturemaps.org/guides/buildings/
- https://docs.overturemaps.org/attribution/
- https://docs.overturemaps.org/getting-data/
- https://docs.overturemaps.org/schema/reference/buildings/building/
- https://github.com/OvertureMaps/overturemaps-py/
- https://github.com/OvertureMaps/data/
- https://stac.overturemaps.org/catalog.json
- https://sites.research.google/open-buildings/
- https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings_v3_polygons
- https://creativecommons.org/licenses/by/4.0/
- https://www.openstreetmap.org/copyright
- https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
- https://osmfoundation.org/wiki/Licence/Licence_and_Legal_FAQ
- https://wiki.openstreetmap.org/wiki/Open_Database_License/ODbL-1.0.txt
- https://wiki.openstreetmap.org/wiki/Downloading_data
- https://wiki.openstreetmap.org/wiki/Key:height
- https://wiki.openstreetmap.org/wiki/Key:building:levels
- https://download.geofabrik.de/north-america/us/oregon.html
- https://www.yamhillcounty.gov/162/Geographic-Info-Systems
- https://www.yamhillcounty.gov/370/Fee-Schedule
- https://www.yamhillcounty.gov/DocumentCenter/View/17200/Request-for-Public-Information-PDF
- https://yamhillcountymaps.com/
- https://www.yamhillcountygis.com/server/rest/services/2023_Planning/Private_2023/MapServer
- https://ftp.gis.oregon.gov/framework/ZZ_Share/MINUTES/FIT/TEAMS/ADDRESSES/BuildingFootprints/20241118/Overview_SBFO.pdf (Oregon statewide buildings discussion only; not used as a recommended source)
