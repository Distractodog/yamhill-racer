# Campus satellite survey and trail audit

Survey source: the supplied tile `0_0/naip.jpg`, 2128 × 2128, 1 m/pixel;
world `(x,z) = pixel - 1064`. Crops inspected: the whole developed campus and northern
meadows, track/west apron, tennis courts, eastern track-side houses, staff housing,
and the three eastern barns. No tile assets were rebuilt or edited.

The image supports footprints and roof colours, not building heights or the detailed
construction of seating. The owner's covered-stand description supplies that interpretation:
the long red feature can be confused with the red field-event surface at this resolution.
There is no clear separate press box, so none was added. Heights, seven seating rows,
steel posts, access aisles and railings are conservative modeling choices for review.

## Survey inventory

| Feature | World coordinates / observation | Change or disposition |
|---|---|---|
| Covered stand | centre `(-621.5,42.5)`, 66 × 8 m; axis `(0.2133,0.9770)`; ends approximately `(-628.5,10.3)` and `(-614.5,74.7)` | Added seven rising rows facing east, three stair aisles, benches, rails and a shallow maroon gable canopy. Separate elevated roof collider permits passage underneath; seating is solid. Near/far copies omit small detail at distance. |
| Old west-track block | generic OSM footprint centred `(-603.2,53.6)` | Replaced by the owner's specified stand rather than leaving a second enclosed building next to it. This is a placement interpretation requiring the director's visual review. |
| Concrete apron | corners `(-626,7),(-615,5),(-600,76),(-611,78)` | Added terrain-supported grey surface, concrete grip. |
| Field-event surfaces | narrow strip `x -623..-611,z 19..47`; wider red pad `x -635..-610,z 47..75` | Existing measured shapes retained, now leveled with the apron/stand. Red areas remain flat surfaces, not walls. |
| Four tennis courts | centre `(-461,-163)`, overall 69 × 35 m, axis 87° from east | Missing 3D courts added: red surround, green playing rectangles, lines and nets; level shared terrain and track-surface grip. |
| Tennis utility building | `(-532.5,-134.6)`, 26 × 11 m, angle 67° | Existing generic footprint replaced by a low pale metal-roofed building. White rectangle west of courts is clear on satellite. |
| North meadow shed | `(-563,-568)`, 22 × 16 m, angle −32° | Clear pale roof absent from existing campus and tile footprints; added solid shed. |
| Meadow equipment shed | `(-583,-494)`, 18 × 8 m, angle 90° | Omitted after director review: its visible footprint overlaps the current 12 m trail strip `0_0:72`. Moving it clear by another 2 m would invent a position. |
| White building south of track | Gym, `(-510.5,177.8)` | Already present at the visible white rectangle, 48.5 × 28.7 m; no duplicate. |
| East track-side houses | generic footprints centred `(-396.2,44.6)`, `(-419.1,75.8)`, `(-460.8,143.5)` | Already present. Tree cover obscures exact small extensions; left intact. |
| Small block beside tennis courts | generic footprint `(-480.9,-166.3)` | Already present outside the western court edge; not duplicated. |
| Main Building + rear kitchen | Main around `(-548,371)`; kitchen north of its courtyard | Existing hand-authored compound follows the pale roof wings; retained. |
| Main parking | west approach around `(-610,317)` and front stalls around `(-600,383)` | Existing road strips / painted front stalls. Lot borders and parked vehicles are indistinct at 1 m/pixel; no invented lot polygon. The west parking expanse remains a candidate for a closer reference. |
| East lawn court/pad | around `(-470,340)` | Existing small painted pad; not the four northern tennis courts. Retained. |
| Heron Print Shop | `(-607.9,229.4)` | Existing roof/porch at the visible pale roof; retained. |
| West parking building | `(-638.3,329.9)` | Existing hand-authored building; retained. |
| Larson Hall | `(-459.7,439)` | Existing long hall east/south of Main; retained. |
| Dragon Hall | `(-589.1,496.9)` | Existing building at pale horizontal roof; retained. |
| West staff houses | centres `(-790.7,595.2),(-833.5,608.1),(-814.3,515.7),(-807.8,468.7),(-757.4,472.6),(-832,568.8),(-696.1,522.2),(-725.6,557.2),(-754.1,573.5),(-663.2,506.9)` | Existing houses/duplexes cover the visible roof cluster. Small backyard objects cannot reliably be distinguished from vehicles and shadows; not added as buildings. |
| Eastern barns | `(112,614.8),(94,604.8),(122.5,577.7)` | Two red and one pale metal roof match existing three barns; no additions. |
| Fences and field paths | court perimeter; meadows northwest of track; staff housing and barn yards | Thin lines/tree shadows are not sufficient to locate new solid fences. Existing decorative staff fences retained. All encoded campus trails were audited separately below. |

## Trail findings and changes

`tools/campus_trail_audit.mjs` reads every rendered trail in `0_0` and its eight
neighbours. Strip IDs are **zero-based `tile.paths[]` indices in the current packed
assets**, not durable route IDs after a rebuild. It samples the centre and both
12 m-wide strip edges, checks reversed offset edges, grades and endpoint corners.
This is geometric inspection, not proof that every strip was driven in a browser.

Runtime fixes:

- `applyTrack` previously changed the terrain after the baked road heights had been
  prepared. Three northern track approaches were buried by 2.29–2.74 m. The terrain
  edit now rebases both physics/drawing strips and their junctions. Road top vertices
  are kept above terrain; the oval hides the obsolete trail surface underneath it.
- Trail skirts formerly ended exactly 3 m below the road. Thirteen strips have cuts
  deeper than 3 m. Skirts now extend to the local terrain; this changes drawing only.
- Tight 12 m offset ribbons can reverse triangle winding. Their top triangles now
  face up in both near and far meshes. This closes back-face holes without moving the
  driving corridor. It does not claim to eliminate all self-overlap in sharp bends.

The equipment shed at `(-583,-494)` was removed after the director's follow-up.
A fresh enlarged satellite crop confirms its roof overlaps the current 12 m-wide
trail `0_0:72`, from `(-579.11,-514.57)` to `(-579.16,-482.10)`. A position outside
the drawn trail plus 2 m clearance would not match the roof. The shed's proposed
build-side trace mask and screenshot case were removed as well; this task no longer
requires rerouting `long-walk`, `bike-north-scramble` or `bike-gravel-run` around it.

Build changes, **not baked into assets**:

- `tools/build_tiles.py` now uses `campus_trails.trace_skeleton`: redundant diagonal
  shortcuts around orthogonal skeleton corners no longer make triangular loops and
  false junctions. Traversal is deterministic; closed loops survive.
- `smooth_trail` resamples by distance before smoothing raster jitter, preserves open
  endpoints/closed loops, and limits movement to 2 m. On the existing 115 baked strip
  shapes, a diagnostic resampling found 227 folded offset samples before and 114
  after smoothing. That is an isolated shape experiment, not a scratch rebuild.
  True tight bends can still overlap at the intentional 12 m game width.
- `tools/roadnet.py` limits trail height spikes after profile fitting and again after
  overlap harmonization, preserving junction endpoint heights exactly. Interior
  grades are bounded to 0.55 or the endpoint-required average when steeper. This
  prevents overlap matching from introducing one-sample cliffs. Short connectors
  with intrinsically incompatible junction heights still require layout review.

Recommended director rebuild: run the shared tile bake after all workers' changes,
then regenerate minimap/races and rerun this audit. Review the listed tight bends;
if overlap remains visible, adjust their traced centreline/turn radius before another
bake rather than globally narrowing all campus trails. For short steep connectors,
inspect the two incident junctions in `roadnet.junction_layout/profiles`; merging
nearby junctions or revising the trace is preferable to breaking endpoint continuity.

## Verification and remaining review

- Follow-up full `npm run drive` (heavy-gated, 8 GB Node heap) passed: all 11 ground
  and 3 aircraft race bots finished; no `DID NOT FINISH`, `FAIL` or `NaN` markers.
- Existing `campus_test.mjs` and campus item ownership tests passed.
- `campus_sat_test.mjs`: finite near/far meshes, seven east-facing rows, open canopy
  underside, drawn roof versus roof collision, court/apron grip, deep-cut skirts,
  and upward top triangles at four representative tight turns, near and far.
- Six Python cleanup tests: corner connectivity, T junction, closed loops, bounded
  jitter/endpoints, profile spikes and unavoidable steep connectors.
- Source NAIP crops and a CPU projection of the actual stand mesh were viewed. The
  CPU view is not a browser render and does not establish shadows, fps or page errors.
- Director browser script: `node tools/campus_sat_shots.mjs --out /tmp/campus-sat
  --sat <tile-0_0-naip.jpg> --before <baseline-server-url>` (wrap in heavy gate).
  It captures the stand from the track, an exact-bounds overhead view next to the
  satellite, every added item, track-height fixes and deep-skirt fixes before/after.
  It records frame times, draw counts, loaded ground and browser/request errors.
  `--trails <audit.json>` adds one view per audited strip; `--only <substring>` narrows
  a run. It requires existing servers and never starts one.
- **Not verified:** browser screenshots, visual overlap/jaggedness, performance,
  full per-strip player driving, and the combined bake. Browser launch and asset
  rebuilding were excluded by this worker task.

## Exact rebuild / review locations

Eight steep sampled profiles below need the rebuilt profile check. The first two short
connectors demand grades above 0.55 even between their existing endpoint heights;
the limiter preserves those endpoints and cannot promise a gentler route there.

| Tile | Strip | Maximum grade | Coordinate | Build action |
|---|---:|---:|---|---|
| 0_0 | 66 | 1.44 | (-948.73,-189.18) | Profile limiter + inspect incident junctions |
| 0_0 | 69 | 0.86 | (-707.97,-125.56) | Profile limiter + inspect incident junctions |
| 0_0 | 78 | 1.01 | (-812.54,-366.21) | Profile limiter + inspect incident junctions |
| 0_0 | 118 | 0.77 | (-708.41,162.11) | Profile limiter + inspect incident junctions |
| 0_0 | 123 | 0.78 | (-160.66,333.35) | Profile limiter + inspect incident junctions |
| 0_0 | 131 | 0.89 | (-927.23,-187.45) | Profile limiter + inspect incident junctions |
| 0_0 | 134 | 0.86 | (-663.95,-73.66) | Profile limiter + inspect incident junctions |
| 0_0 | 183 | 0.67 | (-150.17,-422.69) | Profile limiter + inspect incident junctions |

One endpoint has no junction polygon within 40 m: `0_0`, strip 122,
`(-920.27,-233.68)`. It is an unmatched end, not evidence of a confirmed missing
connection. Check the trail-map trace against the wooded satellite area before
extending it in `mapdata.py`. Other non-tile-cut endpoints match a junction ring
corner within 0.007 m. Pairwise interior centreline intersection checks found no
unjoined crossing between the 115 strips. No nonfinite heights were observed.

The following complete inventory records all 115 strips, including unflagged ones.
“Cut” is the maximum road-top to terrain gap, not necessarily a visual defect: the
new skirt covers it. “Fold” counts reversed offset edges and locates one representative
bend; renderer winding is repaired, while centreline smoothing awaits the rebuild.
“Buried” is the old/new **baked strip** deficit; top vertices are clamped to terrain
at draw time, and physics already takes the higher of terrain and strip. Width is
12 m everywhere, as required by the existing 3× trail-width policy.

| Tile | Strip | Start → end | Buried before/after (m) | Cut (m) at | Fold count at |
|---|---:|---|---:|---|---|
| 0_-1 | 47 | (-101.45,-1000.00) → (-390.28,-1000.00) | 0.00/0.00 | 2.97 at (-361.84,-1088.37) | 11 at (-359.12,-1066.91) |
| 0_-1 | 48 | (-792.58,-1000.00) → (-786.63,-1012.75) | 0.00/0.00 | 0.15 at (-792.58,-1000.00) | 1 at (-792.58,-1000.00) |
| -1_0 | 4 | (-1000.00,-688.37) → (-1044.92,-650.96) | 0.00/0.00 | 0.49 at (-1007.48,-689.57) | 0 |
| -1_0 | 5 | (-1116.68,-526.09) → (-1128.28,-459.40) | 0.00/0.00 | 0.56 at (-1134.30,-460.25) | 0 |
| -1_0 | 6 | (-1106.14,-531.07) → (-1045.55,-452.42) | 0.00/0.00 | 0.90 at (-1051.22,-450.23) | 0 |
| -1_0 | 7 | (-1126.24,-609.16) → (-1119.18,-635.36) | 0.00/0.00 | 0.94 at (-1118.29,-616.06) | 0 |
| -1_0 | 8 | (-1000.00,-189.13) → (-1101.09,-193.37) | 0.00/0.00 | 2.54 at (-1028.54,-204.20) | 12 at (-1097.38,-194.83) |
| -1_0 | 9 | (-1000.00,-768.64) → (-1007.06,-790.06) | 0.00/0.00 | 2.42 at (-1003.93,-764.10) | 0 |
| -1_0 | 10 | (-1118.32,-647.40) → (-1016.01,-798.58) | 0.00/0.00 | 0.89 at (-1111.75,-659.71) | 0 |
| -1_0 | 11 | (-1126.75,-597.50) → (-1114.58,-539.53) | 0.00/0.00 | 0.81 at (-1120.12,-552.19) | 0 |
| -1_0 | 12 | (-1129.01,-445.72) → (-1101.59,-205.35) | 0.00/0.00 | 3.20 at (-1137.49,-259.27) | 3 at (-1145.34,-255.92) |
| -1_0 | 13 | (-1000.00,-401.65) → (-1039.09,-440.51) | 0.00/0.00 | 0.38 at (-1036.30,-428.18) | 0 |
| -1_0 | 14 | (-1000.00,-81.48) → (-1090.52,-179.41) | 0.00/0.00 | 2.67 at (-1084.20,-180.39) | 8 at (-1089.92,-154.86) |
| -1_0 | 15 | (-1108.91,-640.97) → (-1116.83,-603.22) | 0.00/0.00 | 2.93 at (-1077.46,-638.26) | 4 at (-1062.40,-642.02) |
| -1_0 | 16 | (-1057.97,79.58) → (-1107.26,-181.02) | 0.04/0.04 | 4.60 at (-1100.38,-163.55) | 6 at (-1129.08,-148.48) |
| -1_0 | 17 | (-1000.00,-805.82) → (-1004.23,-803.36) | 0.00/0.00 | 0.19 at (-997.19,-800.52) | 0 |
| -1_0 | 18 | (-1118.47,-451.38) → (-1051.63,-442.64) | 0.00/0.00 | 1.04 at (-1068.18,-439.82) | 0 |
| 0_0 | 57 | (-827.51,-959.58) → (-579.58,-737.29) | 0.00/0.00 | 2.07 at (-583.83,-748.62) | 0 |
| 0_0 | 58 | (-260.19,301.18) → (-285.23,243.90) | 0.00/0.00 | 1.14 at (-287.67,272.04) | 0 |
| 0_0 | 59 | (-258.05,314.00) → (-311.02,336.00) | 0.00/0.00 | 5.46 at (-279.59,353.60) | 10 at (-308.11,333.32) |
| 0_0 | 60 | (-638.78,357.87) → (-575.05,263.60) | 0.00/0.00 | 1.88 at (-607.31,299.87) | 0 |
| 0_0 | 61 | (-785.71,329.65) → (-838.64,419.11) | 0.00/0.00 | 2.84 at (-640.86,367.96) | 8 at (-747.41,417.56) |
| 0_0 | 62 | (-997.54,-690.64) → (-1000.00,-688.37) | 0.00/0.00 | 0.71 at (-1001.60,-695.06) | 0 |
| 0_0 | 63 | (-470.06,-196.98) → (-480.89,-203.64) | 0.00/0.43 | 1.10 at (-473.62,-200.03) | 2 at (-477.33,-202.90) |
| 0_0 | 64 | (-931.70,-198.72) → (-931.33,-196.22) | 0.00/0.00 | 8.62 at (-937.58,-197.53) | 0 |
| 0_0 | 65 | (-463.11,2.17) → (-471.54,-2.72) | 0.00/0.00 | 0.33 at (-469.55,5.70) | 0 |
| 0_0 | 66 | (-943.79,-191.84) → (-950.23,-188.05) | 0.00/0.00 | 4.03 at (-945.53,-191.14) | 0 |
| 0_0 | 67 | (-917.73,-175.12) → (-941.07,-95.12) | 0.05/0.05 | 1.20 at (-932.15,-107.92) | 4 at (-941.16,-100.97) |
| 0_0 | 68 | (-118.42,167.23) → (-133.71,234.18) | 0.00/0.00 | 1.21 at (-118.59,216.03) | 0 |
| 0_0 | 69 | (-707.97,-125.56) → (-708.87,-127.53) | 0.00/0.00 | 7.10 at (-702.89,-129.07) | 0 |
| 0_0 | 70 | (-67.73,589.42) → (-97.10,650.50) | 0.00/0.00 | 2.49 at (-99.74,568.63) | 8 at (-99.08,560.89) |
| 0_0 | 71 | (-339.01,163.25) → (-128.10,160.81) | 0.00/0.00 | 1.11 at (-331.46,158.41) | 0 |
| 0_0 | 72 | (-579.11,-514.57) → (-579.16,-482.10) | 0.00/0.00 | 0.89 at (-573.30,-487.06) | 0 |
| 0_0 | 73 | (-7.22,-322.09) → (-1.11,-320.14) | 0.00/0.00 | 1.17 at (-4.46,-327.42) | 0 |
| 0_0 | 74 | (-554.89,237.31) → (-573.95,261.97) | 0.00/0.00 | 1.59 at (-568.29,252.83) | 0 |
| 0_0 | 75 | (-796.67,326.98) → (-849.80,410.66) | 0.00/0.00 | 2.30 at (-798.29,340.33) | 4 at (-802.43,366.10) |
| 0_0 | 76 | (-560.67,-542.96) → (-562.40,-530.56) | 0.00/0.00 | 2.24 at (-560.67,-542.96) | 5 at (-563.72,-532.07) |
| 0_0 | 77 | (-955.92,192.27) → (-710.10,161.33) | 0.00/0.00 | 2.05 at (-716.11,160.43) | 2 at (-714.78,153.13) |
| 0_0 | 78 | (-808.82,-356.26) → (-820.28,-376.16) | 0.00/0.00 | 3.62 at (-819.62,-375.44) | 0 |
| 0_0 | 79 | (-861.42,5.65) → (-664.59,-61.89) | 0.00/0.00 | 0.75 at (-856.53,4.88) | 0 |
| 0_0 | 80 | (-316.74,348.24) → (-294.39,397.88) | 0.00/0.00 | 2.25 at (-310.92,346.79) | 0 |
| 0_0 | 81 | (-352.39,166.71) → (-449.19,187.42) | 0.00/0.00 | 1.82 at (-364.29,168.00) | 0 |
| 0_0 | 82 | (-801.14,-272.44) → (-717.35,-119.10) | 0.00/0.00 | 1.45 at (-756.82,-152.00) | 0 |
| 0_0 | 83 | (-576.18,-564.98) → (-554.48,-673.87) | 0.00/0.00 | 1.40 at (-556.24,-644.36) | 0 |
| 0_0 | 84 | (144.80,-182.20) → (27.31,-304.05) | 0.00/0.00 | 0.42 at (47.09,-287.35) | 0 |
| 0_0 | 85 | (-969.68,-184.37) → (-1000.00,-189.13) | 0.00/0.00 | 2.75 at (-982.73,-187.49) | 0 |
| 0_0 | 86 | (-879.54,11.14) → (-975.02,160.94) | 0.00/0.00 | 2.77 at (-974.35,140.06) | 2 at (-878.78,16.92) |
| 0_0 | 87 | (-20.44,-22.18) → (-3.20,-264.95) | 0.00/0.00 | 0.96 at (-12.25,-26.85) | 0 |
| 0_0 | 88 | (-957.59,180.65) → (-579.52,-41.72) | 2.74/0.73 | 1.42 at (-784.55,114.96) | 7 at (-778.28,110.52) |
| 0_0 | 89 | (-481.37,272.65) → (-466.59,270.91) | 0.00/0.00 | 0.26 at (-479.01,267.13) | 4 at (-474.71,274.50) |
| 0_0 | 90 | (-128.14,-437.83) → (-31.27,-338.04) | 0.00/0.00 | 0.59 at (-135.97,-425.94) | 2 at (-144.80,-424.30) |
| 0_0 | 91 | (-518.23,249.02) → (-521.80,246.33) | 0.00/0.00 | 1.41 at (-521.82,253.82) | 0 |
| 0_0 | 92 | (-908.89,-190.05) → (-831.87,-373.54) | 0.00/0.00 | 2.38 at (-914.09,-193.04) | 2 at (-904.21,-204.95) |
| 0_0 | 93 | (-995.41,-701.52) → (-1000.00,-768.64) | 0.00/0.00 | 2.53 at (-997.15,-758.96) | 2 at (-989.33,-759.48) |
| 0_0 | 94 | (-641.83,-475.43) → (-640.16,-463.97) | 0.00/0.00 | 0.68 at (-640.12,-465.91) | 0 |
| 0_0 | 95 | (-971.87,-76.08) → (-967.25,-72.60) | 0.00/0.00 | 2.27 at (-963.94,-77.60) | 0 |
| 0_0 | 96 | (-930.53,-3.12) → (-991.40,-47.63) | 0.00/0.00 | 2.65 at (-956.02,-7.52) | 0 |
| 0_0 | 97 | (-931.69,11.34) → (-986.95,173.13) | 0.00/0.00 | 2.13 at (-935.89,20.27) | 4 at (-992.42,175.40) |
| 0_0 | 98 | (-926.69,-46.97) → (-929.55,-54.91) | 0.00/0.00 | 4.03 at (-926.69,-46.97) | 0 |
| 0_0 | 99 | (-534.20,-250.03) → (-539.40,-323.46) | 0.00/0.00 | 1.61 at (-536.17,-316.26) | 0 |
| 0_0 | 100 | (-49.60,538.80) → (-135.53,244.75) | 0.00/0.00 | 2.47 at (-151.65,339.69) | 0 |
| 0_0 | 101 | (-703.64,-152.30) → (-556.26,-61.80) | 0.00/0.00 | 2.37 at (-693.26,-146.66) | 0 |
| 0_0 | 102 | (-835.41,-384.96) → (-939.25,-330.07) | 0.00/0.00 | 1.18 at (-928.96,-338.67) | 0 |
| 0_0 | 103 | (-165.15,-439.12) → (-297.67,-596.45) | 0.00/0.00 | 0.64 at (-289.60,-590.67) | 0 |
| 0_0 | 104 | (289.59,479.10) → (-39.73,545.64) | 0.00/0.00 | 0.65 at (-35.81,540.77) | 0 |
| 0_0 | 105 | (-598.88,-453.31) → (-628.88,-452.09) | 0.00/0.00 | 0.64 at (-629.26,-458.08) | 0 |
| 0_0 | 106 | (-129.92,-490.36) → (-122.26,-450.72) | 0.00/0.00 | 1.12 at (-131.44,-484.17) | 4 at (-125.77,-486.31) |
| 0_0 | 107 | (-578.12,-413.53) → (-578.55,-468.05) | 0.00/0.00 | 0.58 at (-572.88,-429.37) | 0 |
| 0_0 | 108 | (-508.33,-211.76) → (-529.17,-223.74) | 0.00/0.00 | 0.65 at (-517.32,-221.23) | 0 |
| 0_0 | 109 | (-291.55,234.06) → (-343.44,173.80) | 0.00/0.00 | 0.79 at (-349.23,175.37) | 0 |
| 0_0 | 110 | (-279.42,233.61) → (-232.64,236.12) | 0.00/0.00 | 1.38 at (-255.59,222.48) | 0 |
| 0_0 | 111 | (-577.91,-528.70) → (-578.02,-539.26) | 0.00/0.00 | 2.24 at (-571.93,-530.49) | 0 |
| 0_0 | 112 | (-136.75,-501.06) → (-101.45,-1000.00) | 0.03/0.03 | 2.50 at (-161.99,-891.97) | 29 at (-104.65,-940.14) |
| 0_0 | 113 | (-390.28,-1000.00) → (-142.75,-491.03) | 0.12/0.12 | 2.02 at (-348.16,-892.55) | 28 at (-234.80,-597.95) |
| 0_0 | 114 | (3.92,-276.01) → (6.12,-304.74) | 0.00/0.00 | 0.40 at (0.06,-283.99) | 0 |
| 0_0 | 115 | (-812.54,-978.63) → (-792.58,-1000.00) | 0.00/0.00 | 0.35 at (-810.87,-988.45) | 0 |
| 0_0 | 116 | (-163.33,-401.89) → (-164.91,-393.47) | 0.00/0.00 | 0.54 at (-169.08,-400.19) | 2 at (-162.83,-400.20) |
| 0_0 | 117 | (-787.90,318.33) → (-773.77,301.16) | 0.00/0.00 | 3.01 at (-777.41,312.05) | 6 at (-780.24,300.07) |
| 0_0 | 118 | (-738.57,238.83) → (-579.64,155.24) | 0.00/0.00 | 3.51 at (-698.81,162.08) | 8 at (-700.43,167.98) |
| 0_0 | 119 | (-957.78,-177.45) → (-958.98,-175.29) | 0.00/0.00 | 2.25 at (-963.23,-179.96) | 0 |
| 0_0 | 120 | (-113.29,-442.15) → (-3.84,-341.74) | 0.00/0.00 | 0.66 at (-3.84,-341.74) | 0 |
| 0_0 | 121 | (-954.22,-320.47) → (-1000.00,-401.65) | 0.00/0.00 | 2.85 at (-955.79,-312.52) | 0 |
| 0_0 | 122 | (-943.64,-315.63) → (-920.27,-233.68) | 0.14/0.14 | 6.91 at (-952.51,-287.61) | 13 at (-891.67,-313.87) |
| 0_0 | 123 | (-242.59,308.13) → (-145.11,238.80) | 0.00/0.00 | 3.09 at (-163.90,344.43) | 8 at (-222.58,252.85) |
| 0_0 | 124 | (-495.92,265.73) → (-484.24,273.53) | 0.00/0.00 | 0.49 at (-495.92,265.73) | 0 |
| 0_0 | 125 | (-884.33,-17.30) → (-882.72,-9.90) | 0.00/0.00 | 1.26 at (-877.93,-17.10) | 0 |
| 0_0 | 126 | (-7.49,-275.50) → (-160.35,-381.03) | 0.00/0.00 | 0.73 at (-59.28,-307.59) | 2 at (-120.54,-358.50) |
| 0_0 | 127 | (-320.48,-141.32) → (-192.21,-385.20) | 0.00/0.00 | 2.22 at (-291.05,-164.76) | 6 at (-243.30,-383.48) |
| 0_0 | 128 | (-329.63,-608.20) → (-548.17,-521.05) | 0.00/0.00 | 1.41 at (-329.36,-614.58) | 0 |
| 0_0 | 129 | (111.75,-335.23) → (281.58,-203.08) | 0.00/0.00 | 2.91 at (270.11,-205.95) | 0 |
| 0_0 | 130 | (-445.71,-41.31) → (-120.55,151.90) | 0.00/0.00 | 1.06 at (-121.62,140.02) | 0 |
| 0_0 | 131 | (-927.97,-187.55) → (-923.50,-186.99) | 0.00/0.00 | 2.79 at (-927.97,-187.55) | 0 |
| 0_0 | 132 | (-569.59,-51.21) → (-556.21,-48.60) | 2.29/0.38 | 1.52 at (-567.88,-57.05) | 0 |
| 0_0 | 133 | (-799.20,-381.50) → (-658.91,-451.20) | 0.00/0.00 | 2.49 at (-667.84,-450.46) | 0 |
| 0_0 | 134 | (-663.57,-72.89) → (-667.81,-80.31) | 0.03/0.03 | 2.15 at (-661.79,-81.82) | 0 |
| 0_0 | 135 | (28.99,-319.23) → (79.46,-329.60) | 0.00/0.00 | 1.40 at (60.09,-325.49) | 0 |
| 0_0 | 136 | (-991.97,-81.24) → (-1000.00,-81.48) | 0.00/0.00 | 1.45 at (-991.97,-81.24) | 1 at (-999.88,-81.48) |
| 0_0 | 137 | (-973.98,-70.13) → (-975.73,-68.18) | 0.00/0.00 | 0.74 at (-973.98,-70.13) | 0 |
| 0_0 | 138 | (-908.41,-24.18) → (-913.44,-8.12) | 0.00/0.00 | 6.38 at (-908.41,-24.18) | 0 |
| 0_0 | 139 | (-50.01,550.10) → (-59.71,578.71) | 0.00/0.00 | 0.72 at (-55.96,548.09) | 0 |
| 0_0 | 140 | (-393.53,286.56) → (-322.58,337.80) | 0.00/0.00 | 2.30 at (-328.08,324.23) | 0 |
| 0_0 | 141 | (-569.49,-520.98) → (-561.71,-519.60) | 0.00/0.00 | 2.52 at (-569.49,-520.98) | 0 |
| 0_0 | 142 | (-968.31,187.88) → (-978.56,184.28) | 0.00/0.00 | 2.55 at (-972.43,193.74) | 2 at (-974.10,187.66) |
| 0_0 | 143 | (-984.99,-696.81) → (-645.36,-494.45) | 0.00/0.00 | 1.12 at (-976.29,-703.92) | 0 |
| 0_0 | 144 | (-655.06,-66.72) → (-585.95,-52.12) | 2.46/0.00 | 2.40 at (-594.65,-53.73) | 0 |
| 0_0 | 145 | (-684.92,-97.36) → (-702.60,-113.36) | 0.00/0.00 | 1.46 at (-698.77,-117.98) | 0 |
| 0_0 | 146 | (-572.73,-475.11) → (-567.47,-477.02) | 0.00/0.00 | 0.60 at (-572.12,-481.71) | 0 |
| 0_0 | 147 | (-877.08,-841.42) → (-1000.00,-805.82) | 0.00/0.00 | 0.63 at (-904.11,-826.98) | 0 |
| 0_0 | 148 | (-503.63,-12.24) → (-492.55,-4.33) | 0.00/0.00 | 0.36 at (-498.38,-7.86) | 0 |
| 0_0 | 157 | (-55.96,593.14) → (-83.71,652.55) | 0.00/0.00 | 1.12 at (-76.20,644.73) | 0 |
| 0_0 | 158 | (-96.54,662.10) → (-848.49,423.04) | 0.04/0.04 | 2.99 at (-291.46,749.21) | 26 at (-848.00,668.34) |
| 0_0 | 169 | (-892.02,5.04) → (-906.09,1.56) | 0.00/0.00 | 1.18 at (-900.05,-3.18) | 0 |
| 0_0 | 175 | (-980.93,178.13) → (-979.70,187.42) | 0.00/0.00 | 0.88 at (-986.88,177.38) | 1 at (-980.58,185.77) |
| 0_0 | 183 | (-153.47,-418.03) → (-149.15,-424.84) | 0.00/0.00 | 1.72 at (-156.94,-423.48) | 0 |
| 0_0 | 187 | (-168.98,-386.50) → (-170.02,-384.83) | 0.00/0.00 | 0.82 at (-170.02,-384.83) | 0 |
