# Tile format v3

**Release status (2026-11-14): ready to push; awaiting the owner's go-ahead.** Driving is unchanged: the lossless candidate matches all 97 baseline DRIVE sections. Assets total **555,809,093 bytes** (906 MB before). The size cap is now **700,000,000 bytes**: 450 MB was a target set while v3 was meant to round data, and exact packing was chosen instead because any rounding changed how the cars drive. The owner accepted ~556 MB; the hard limit is GitHub Pages' ~1 GB published site, and 700 MB keeps room for the full-map bridges/ramps rebuild. Screenshots were captured on the owner's Mac and reviewed (see "Screenshot gate result" below). See `v3_validation.json`.

`world.json` identifies the published format with numeric `"packed": 3`. The browser loader accepts v3 and returns the existing float32 terrain/tree arrays and JSON objects. Python tools retain plain/v1/v2 readers. No physics, interpolation, road-query or vehicle logic is changed.

Each tile contains `height.bin.gz`, `surface.bin.gz`, `ponds.bin.gz`, `trees.bin.gz`, `tile.json.gz`, `ground.webp`, and a `v3.json` receipt. Binary integers/floats are little-endian. Gzip uses level 9 and `mtime=0`.

## Exact heights

The 16-byte `<4sHHfI` header retains magic `H3Q0`, grid side, flags, base and correction count. **Flag 8** identifies the lossless subtype; base bits and correction count must both be zero. Current grids remain 517 × 517 at 4 m spacing (501 core vertices plus eight margin vertices on each side).

Interpret original float32 samples as uint32 bit patterns. Difference horizontally once, then vertically twice, modulo 2^32 with missing predecessors zero. Zigzag the signed modular residuals and split their uint32 bytes into four planes before gzip. Decode unshuffles/undoes zigzag, integrates vertically twice and horizontally once, then restores the original float32 bits. Every sample, including shared core edges, negative zero and subnormals, is exact. Nonfinite values and malformed headers/lengths are rejected. `heightAt` and `normalAt` receive original float values; interpolation is unchanged and its results are not rounded.

Legacy flag 0 (2 cm quantization plus sparse corrections) remains readable for old candidates. New writes are always lossless. Experimental 5 mm/mask flags are research fixtures, not published subtypes. No coarse scenery grids are used: all current tiles intersect the rim plus 500 m.

## Exact trees

The header remains `<4sIiiI`: `TRV3`, count, tile x/z, subtype/exception count. A final field of `0xffffffff` selects exact data. Each coordinate axis stores original float32 bits XORed with the previous tree's bits, separated into four byte planes. Four more planes preserve height bits. A final byte per tree represents broadleaf 0, 1 or negative zero. The payload is 13 bytes per tree before gzip, with no coordinate rounding or exceptions.

Decoded `[world_x, world_z, height, broadleaf]` records are byte-identical, including order. Collision radius/height inputs, render buckets and procedural appearance inputs therefore remain unchanged. Legacy quantized TRV3 reads remain supported.

## Exact geometry and rasters

`tile.json.gz` contains a `G3E1` JSON wrapper. Identical render/physics road objects share a stored pool, but decoding creates independent objects. Coordinate matrices use integer deltas only when division by their scale reproduces the original number exactly; otherwise original numeric arrays are retained. Negative zero is explicitly preserved. Scales are 100 for planar coordinates, 1000 for road/junction heights, and 10000 for road cross slopes. These scales do not permit rounding: unsupported values use the lossless fallback.

Every decoded geometry value, including road heights/cross slopes, is equal to the original JavaScript number. Decoders reject invalid dimensions, indices and unsafe integer deltas. Surface and pond payloads remain byte-identical gzip. Both runtime tile loading and full-map geometry loading decode G3E1.

## Imagery

Ground WebP remains quality 86/method 6 at original dimensions and RGB/sRGB interpretation. Detail WebP remains quality 75/method 6. The follow-up does not recompress imagery. Ground mean SSIM must remain ≥0.97 over the fixed 20-tile sample; detail must remain ≥0.95. See the validation file for measured means/minima.

The previous campus map patch uses the current runtime track mesh, retaining rim shading and image dimensions. Image metrics do not replace visual approval.

## Conversion and verification

Run from the isolated worktree. Preserve the immutable v2 backup:

```sh
.venv/bin/python tools/repack_v3.py --assets game/assets --backup work/v3/baseline-assets --scratch work/v3/staging --refresh height.bin,trees.bin,tile.json
.venv/bin/python tools/verify_pack.py work/v3/baseline-assets game/assets --report work/v3/followup/final-verify.json
.venv/bin/python -m unittest discover -s tools -p '*_test.py'
node tools/heightcodec_v3_test.mjs
node tools/geometrycodec_v3_test.mjs
node tools/tilepack_v2_test.mjs
.venv/bin/python tools/image_ssim_v3.py --assets work/v3/baseline-assets --converted game/assets --out work/v3/followup/final-image-ssim.json
NODE_OPTIONS=--max-old-space-size=8192 npm run drive > work/v3/followup/final-drive.txt
```

The repacker validates the entire immutable source, processes one tile at a time, and records per-file codec/source profiles. Explicit `--refresh` re-encodes changed selected codecs from v2; validated unselected imagery is copied unchanged. Matching profiles are skipped on resume. It stages and validates files, replaces individual files, removes known obsolete format files, and installs the receipt last. An interrupted install is repaired from the backup. Unknown target files fail rather than being silently deleted. Do not run concurrent conversions against the same destination.

`verify_pack` independently requires exact decoded data for the new subtypes, checks every seam, reports all asset bytes and fails above `SIZE_LIMIT_BYTES` (700,000,000; the reason is written next to it in `verify_pack.py`). It does not waive the size gate when data checks pass.

Use `tools/v3_ab.mjs` for forward component tests against archived `67327f0` game code and its immutable v2 assets. Its component names are `hbuf`, `tbuf`, `tile`, `sbuf`, or `baseline`; `--section all` runs 97 sections and `diagnostic` runs 18. Snapshot the candidate assets before modifying them. Use `tools/v3_drive_compare.py BASELINE1 BASELINE2 CANDIDATE --out REPORT` for the full comparison; diagnostics additionally require `--allow-subset --expected-count 18`. Baseline disagreement, incomplete coverage and candidate differences fail instead of inventing a tolerance.

## Owner-run screenshots

The baseline directory must contain archived `67327f0` game source with `assets` linked to the immutable v2 backup. Start these servers in separate terminals:

```sh
python3 tools/serve.py 8385 work/v3/before-game/game
python3 tools/serve.py 8384 game
```

Then run on the owner's Mac:

```sh
node tools/v3_screens.mjs --before http://127.0.0.1:8385/ --after http://127.0.0.1:8384/ --out work/v3/screens
```

This captures eight PNGs (before/after campus overhead, McMinnville Third Street, Sheridan and rim wall), matching camera/vehicle poses and JSON metadata. `--chrome PATH` overrides Chrome discovery. `--dry-run` validates the plan without launching a browser. Launch/page errors fail and are recorded. Inspect every pair; successful capture does not constitute visual approval. Do not push before the size, physics and screenshot gates all pass.

### Screenshot gate result (2026-11-14, owner's Mac)

`v3_screens.mjs` captured all four pairs with matching poses and zero page errors; a scratch copy with the same capture code added a North Woods trail spot (-909, -664.8) and the full map (M). All six pairs were inspected and look the same. Differences are small and limited to edges (fraction of pixels differing by more than 8/255: campus 5.7%, McMinnville 1.4%, Sheridan 1.4%, rim 1.0%, woods 0.5%, full map 0.04%), from the ground imagery re-encoding. The one visible change is intended: the corner map's campus track now shows the current 6-lane oval with a green infield. Speed (`stream_test` at 1000 km/h, two runs each): before 0/1 slow frames, after 0/0, both 0 frames with no ground. Evidence lives in `work/v3/release/` (local, not committed).

## Follow-up: measured physics repeatability and component isolation

Baseline commit: `67327f0`. Two independent full-map v2 DRIVE runs, each with an 8 GB Node heap, exited 0 and produced identical text in all **97 test sections**. Only the known Node warning containing a process ID was excluded. Observed printed variation was zero; this is not a statistical allowance for future differences. DRIVE itself has no encoded baseline tolerance, and its exit code does not detect a race that prints `DID NOT FINISH`.

The forward A/B runs kept v2 physics code, manifest, routes and all other decoded data unchanged, replacing exactly one field with v3 data. They loaded the full map sequentially and used a frozen decoder snapshot. Each diagnostic run contained **18 sections**, including campus wandering, North Woods, wall impacts and jet scenarios. All commands exited 0; differences below still fail the unchanged-physics requirement.

| Data added to v2 | Changed sections / 18 | Campus flips | North Woods finish | Jet takeoff air entries | Jet landing air entries |
|---|---:|---:|---:|---:|---:|
| v2 baseline | 0 | 0 | 352 s | 1 | 2 |
| v3 heights only | 7 | 0 | 372 s | 1 | 2 |
| v3 trees only | 1 | 0 | 352 s | 1 | 2 |
| v3 geometry only | 7 | 0 | 376 s | 5 | 30 |
| v3 surface only | 0 | 0 | 352 s | 1 | 2 |

The tree-only finish time rounds to the baseline value, but North Woods still changes: wall contacts fall from 3,200 to 2,695, backups rise from 11 to 13, and time to 100 km/h changes from never reaching it to 33.5 seconds. Surface-only results match every diagnostic section exactly and provide a control for the harness.

Geometry quantization alone reproduces the jet takeoff/landing bouncing. This establishes a direct component effect, but does not show that all other failures share that cause. The earlier combined-v3 full run retained two release-blocking failures: North Woods stopped at 35%, and campus wandering gained a flip. It changed 62 of 97 sections. All failing logs and comparisons remain part of the evidence; they are not replaced by successful process exit codes or later narrower tests.

### Finer heights and preservation masks

The finer-height experiment used a 5 mm step on **394 tiles** and an adaptive step on **74 tiles**, because their ranges do not fit uint16 at 5 mm. Maximum range was 648.809311 m, maximum adaptive step was 0.0099001955 m, and maximum reconstructed error was **0.00494384765625 m**. All 888 shared core edges remained exact. Thus this is not a uniform 5 mm codec across the entire map.

Its height-only diagnostic run still failed North Woods at 35%. Six of 18 sections changed; campus wandering had zero flips but longest air changed from 0.11 to 0.79 seconds. Jet Highway 18 landing matched baseline exactly. Smaller per-sample error therefore did not establish unchanged physics.

The first preservation experiment used a 13×13 neighborhood around surface-raster values ≥2. The raster does not encode asphalt/gravel/trail road classes; it contains values 0, 1, 5, 6 and 7. This was a pad/water/track preservation mask, **not a road-preservation mask**. Six diagnostic sections still changed: campus wandering gained one flip and longest air rose to 3.34 seconds; North Woods finished in 360 seconds instead of 352.

A subsequent semantic mask used actual `physPaths` and `physJunctions`, road widths, sidewalks, neighboring geometry, and conservative interpolation/normal-query padding. It reduced the differences to two diagnostic sections: North Woods finished in **353 seconds**, and field jet takeoff still differed. The remaining differences exceed the zero variation observed in the two baselines. The semantic mask protects road-query support, not all off-road physics domains.

A separate four-tile audit queried actual `terrainAt`, `overlayAt` and `heightAt` at 157,658 original road-centre and edge samples, keeping geometry exact. Original terrain already exceeded road overlay at 370 samples. The 2 cm variant created **zero new overrides**; the finer-height variant created one, only **0.000054 m** high. This does not support widespread newly raised terrain masking roads as the explanation in those sampled locations. It does not rule out existing terrain-dominant locations, off-road contacts, normal changes or interacting trajectory sensitivity.

## Final follow-up result

The chosen fix preserves every terrain/tree float32 bit and every geometry number, rather than selecting test locations for extra precision. Both full final DRIVE runs exit zero and match all 97 baseline sections exactly. North Woods finishes in 352 seconds, campus wandering has zero flips, and Highway 18 jet landing has two air-mode entries. The requested rebase found `origin/main` unchanged at `67327f0`; all 64 Python tests, 30 non-browser Node checks, SSIM and full DRIVE were repeated afterward.

The ordinary Node heap exhausted memory while loading the full map, before any DRIVE cases ran. That failed log is retained. The successful candidate runs use the same 8 GB heap as both baseline runs; this is a test-runner setting, not a game physics change.

The size constraint remains unmet. Exact terrain compresses to roughly 224.7 MB even with modular prediction and byte planes. Eighteen lossless predictor variants were sampled, followed by a full-map census of the selected method; this does not prove that no better codec exists. Finer quantization and general surface/road preservation masks did not meet the zero-observed-variation DRIVE gate. No test-coordinate exceptions, physics retuning, weakened tolerances or additional image quality reduction were introduced to make a check pass. The branch is intentionally unpushed and must not be released in this state.
