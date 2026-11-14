# Tile format v3

**Release blocked.** The current converted assets meet the size and numerical error limits, but the full DRIVE comparison fails: North Woods does not finish, campus wandering gains a flip, and jet landing bounce counts increase. The headless screenshot gate is also not verified. Do not publish this candidate. See `v3_validation.json` for measured results and baseline commit.

`world.json` identifies the published format with numeric `"packed": 3`. The browser loader accepts only v3 and returns the existing float32 terrain/tree arrays and JSON objects to the simulation. Python tools retain plain/v1/v2 readers for conversion. Do not publish an intermediate mixture of versions.

Each tile contains `height.bin.gz`, `surface.bin.gz`, `ponds.bin.gz`, `trees.bin.gz`, `tile.json.gz`, and `ground.webp`. Conversion may also retain a validated `v3.json` SHA-256 receipt. All binary integers and floats below are little-endian. Gzip uses level 9 and `mtime=0`; identical inputs and encoder versions produce deterministic bytes.

## Heights

The uncompressed payload begins with `<4sHHfI`: magic `H3Q0`, grid side length, flags (currently zero), float32 minimum height, and correction count. Current grids are **517 × 517**: 501 core vertices at 4 m spacing plus eight margin vertices on each side.

Each sample is rounded to `q = round((height - base) / 0.02)`. The encoder rejects nonfinite grids or a range exceeding 1,310.7 m, rather than overflowing uint16. In row order, the predictor is `left + up - upleft`, with missing neighbours zero. The residual wraps into signed 16-bit range, is zigzag encoded, and is stored as uint16. Decode reverses the predictor modulo 65,536 and reconstructs `base + q * 0.02` as float32.

Trailing corrections are `<If>` records: sample index and original float32 height. They preserve any sample whose float32 reconstruction would exceed **0.01 m** error. They also preserve the shared core boundary rows/columns (indices 8 and 508) exactly, preventing separately quantized neighbours from opening seams.

No 8 m scenery grids are used: all current tiles intersect the circle extending 500 m beyond the playable rim. Flags other than zero are rejected; optional coarse-grid support is not implemented or silently activated.

## Trees

The payload header is `<4sIiiI`: `TRV3`, tree count, tile x/z indices, and exception count. The original ordered records are `[world_x, world_z, height, broadleaf]` float32 values. Tile-local origin is `(tx * 2000 - 1000, tz * 2000 - 1000)`.

Coordinates are rounded to 2 cm units. Each axis stores `q // 2` as uint16 (4 cm base steps), split into low-byte and high-byte planes. A uint8 flag per tree stores broadleaf in bit 0 and the x/z 2 cm refinements in bits 1/2. Bits 3–7 must be zero. Four further byte planes preserve the original float32 tree height **bit for bit**.

Payload order is x low/high planes, z low/high planes, flags, then four height byte planes: nine bytes per tree before gzip. Trailing `<Iff>` exceptions restore original x/z coordinates if quantization would cross a 250 m render bucket or exceed **0.02 m Euclidean displacement** after float32 reconstruction.

Tree count, order, height, type, and render-bucket membership remain unchanged. There are no stored scale or rotation fields to requantize: those visual choices are procedural. Preserving their existing ordering/bucket inputs avoids changing them.

## Rasters, geometry, and imagery

Surface and pond payloads are unchanged bytes, compressed with gzip. Geometry JSON removes whitespace and unnecessary numeric trailing zeros. Coordinates/building heights/junction heights use centimetres; road `yc` height uses centimetres and cross-slope uses 0.001. The encoder retains original road values when the proposed height error plus half-width times slope error would exceed 0.01 m. Pond levels, flags, widths, and topology remain unchanged.

Current path/junction x/z coordinates already lie on centimetres. Verification requires these coordinates unchanged so that interpolation domains stay identical; future data failing that condition must not be published merely because rounding is numerically small.

Ground images retain their dimensions and RGB/sRGB interpretation, using WebP quality **86**, method **6**. Existing detail maps use quality **75**, method **6**, at unchanged 1 m/pixel resolution. The deterministic 20-tile full-resolution RGB SSIM sample measured ground mean **0.970782748** (minimum **0.925414767**) and detail mean **0.974199016** (minimum **0.966059709**). The ground requirement specifies a sample mean. For detail, both the 20-sample mean and minimum are reported; this does not interpret its threshold as a mean-only requirement. These figures do not replace visual review.

The campus detail is rebaked from current ground and the actual runtime track mesh exported through Node, including its colors. The overview receives a local campus patch without resizing the complete image. JPEG encoding can still introduce normal recompression differences outside that patch. Rim shading is retained; the patch is checked to remain clear of it.

## Conversion and verification

Run from the repository root with the existing v2 assets and installed Python/Node dependencies:

```sh
.venv/bin/python tools/repack_v3.py --assets game/assets --backup work/v3/baseline-assets --scratch work/v3/staging
.venv/bin/python tools/repack_maps_v3.py --assets game/assets --backup work/v3/map-backup
.venv/bin/python tools/verify_pack.py work/v3/baseline-assets game/assets --report work/v3/verification.json
.venv/bin/python tools/image_ssim_v3.py --assets work/v3/baseline-assets --converted game/assets --out work/v3/image-ssim.json
node tools/tilepack_v2_test.mjs
.venv/bin/python tools/verify_pack_test.py
.venv/bin/python tools/verify_pack_v3_test.py
node tools/minimap_detail_test.mjs
npm run drive
```

The historical `tilepack_v2_test.mjs` filename now tests v3 JS decoding against Python and explicitly checks Python v2 backward reads. SSIM verification requires scikit-image. Keep baseline images until comparisons and visual checks finish.

The repacker processes one tile at a time from an immutable v2 backup, stages it separately, validates its receipt, and replaces its directory. It updates the manifest only after all tiles finish. `--limit N` deliberately stops after N new conversions for resume testing. Rerun the same command and paths: checksum-valid outputs are skipped; corrupted outputs are rebuilt from the verified original. Never replace the backup with partially converted assets or edit it between retries. Source changes must fail verification, not trigger requantization of already lossy output. Keep backup and scratch outside published assets and do not run concurrent conversions against the same destination.

Map conversion has separate immutable originals and hash-checked state. Repeating it must use the same map-backup directory to avoid another generation of lossy encoding. Encoder/code changes require deliberate review of receipts and source identity before reuse.

Before deployment, verify every tile, the exact final asset size (at most 450,000,000 bytes), drive results, and four matching before/after browser views. Record browser checks as **not verified** if unavailable and stop before pushing. Test success or sampled SSIM alone does not authorize publishing a failing size or visual result.
