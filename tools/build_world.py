"""Builds game/assets from the raw data.

World space (metres): x = east, z = south, origin = centre of the satellite image.
Inputs:  data/raw/naip.jpg (satellite, 2048^2), data/raw/dem.tif (USGS 3DEP, 1024^2),
         data/raw/osm.json (roads, buildings, water), reference/Delphiantrailsmap.png (trails).
Outputs: game/assets/height.bin, ground.jpg, surface.bin, trees.bin, buildings.json, meta.json,
         plus data/raw/treecover_check.jpg to eyeball the tree mask.
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage
from skimage.morphology import skeletonize

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import mapdata, align

RAW = os.path.join(ROOT, 'data', 'raw')
OUT = os.path.join(ROOT, 'game', 'assets')
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)

# ---------------------------------------------------------------- geo frame
info = json.load(open(os.path.join(RAW, 'naip_info.json')))['extent']
XMIN, YMIN, XMAX, YMAX = info['xmin'], info['ymin'], info['xmax'], info['ymax']
R = 6378137.0
lat_c = math.degrees(2 * math.atan(math.exp((YMIN + YMAX) / 2 / R)) - math.pi / 2)
K = math.cos(math.radians(lat_c))                 # mercator metres -> real metres
SAT = 2048
SIZE = (XMAX - XMIN) * K                          # world edge length, metres
SAT_M = SIZE / SAT                                # metres per satellite px
TEX = 4096
TEX_M = SIZE / TEX
print(f'world {SIZE:.0f} m, sat {SAT_M:.2f} m/px, tex {TEX_M:.2f} m/px, lat {lat_c:.4f}')


def lonlat_to_sat(lon, lat):
    mx = R * np.radians(lon)
    my = R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    return (mx - XMIN) / (XMAX - XMIN) * SAT, (YMAX - my) / (YMAX - YMIN) * SAT


def sat_to_world(px, py):
    return (np.asarray(px) - SAT / 2) * SAT_M, (np.asarray(py) - SAT / 2) * SAT_M


# ---------------------------------------------------------------- height
dem = np.array(Image.open(os.path.join(RAW, 'dem.tif'))).astype(np.float32)
dem = ndimage.gaussian_filter(dem, 0.7)
HN = dem.shape[0]

# ---------------------------------------------------------------- satellite + tree cover
sat = np.asarray(Image.open(os.path.join(RAW, 'naip.jpg')).convert('RGB')).astype(np.float32)
r, g, b = sat[..., 0], sat[..., 1], sat[..., 2]
lum = (r + g + b) / 3
# Tree cover comes from a 1 m canopy-height model (Meta/WRI global CHM, reprojected onto the satellite
# grid by tools/fetch_chm.py): anything >= 5 m tall is tree. Satellite colour only decides conifer vs broadleaf.
chm = np.load(os.path.join(RAW, 'chm.npy'))
chm_s = ndimage.uniform_filter(chm, 3)
tree = chm_s >= 5.0
tree = ndimage.binary_opening(tree, iterations=1)
lab, n = ndimage.label(tree)
sizes = ndimage.sum(tree, lab, range(1, n + 1))
tree = np.isin(lab, 1 + np.nonzero(sizes >= 6)[0])          # drop single shrubs
lum_s = ndimage.uniform_filter(lum, 5)
green = ndimage.uniform_filter(g - r, 5)
# lighter canopy = broadleaf (alder/maple/oak); dark Douglas-fir canopy = conifer
broad = tree & (lum_s > 62)

# ---------------------------------------------------------------- trails (from the hand-drawn map)
masks = mapdata.map_masks()
TRAIL_CLASSES = ['black', 'longwalk', 'overgrown', 'odyssey', 'ripps', 'agony', 'waterfall']
trail_tex = np.zeros((TEX, TEX), bool)
trail_lines = {}
for k in TRAIL_CLASSES:
    sk = skeletonize(masks[k])
    ys, xs = np.nonzero(sk)
    p = align.map_to_sat(xs + 0.5, ys + 0.5) * (TEX / SAT)
    ok = (p[:, 0] >= 0) & (p[:, 0] < TEX) & (p[:, 1] >= 0) & (p[:, 1] < TEX)
    pi = p[ok].astype(int)
    m = np.zeros((TEX, TEX), bool)
    m[pi[:, 1], pi[:, 0]] = True
    m = ndimage.binary_dilation(m, iterations=2)          # close gaps from the 1.4x upscale
    trail_tex |= m
    wx, wz = p[ok, 0] * TEX_M - SIZE / 2, p[ok, 1] * TEX_M - SIZE / 2
    trail_lines[k] = len(wx)
trail_dist = ndimage.distance_transform_edt(~trail_tex) * TEX_M     # metres from a trail centre line
TRAIL_HALF = 6.0                                                    # 12 m wide: room to race between the kerbs

# ponds: the hand-drawn map says roughly where each pond is; the satellite says exactly where. Near each mapped
# pond, real open water = dark, no tree canopy, flat ground. A pond the satellite can't see (overgrown) is moved
# by the same correction as its nearest neighbour.
_lum = ndimage.uniform_filter(lum, 5)
_dem2 = np.asarray(Image.fromarray(dem).resize((SAT, SAT), Image.BILINEAR))
_slope = ndimage.uniform_filter(np.hypot(*np.gradient(_dem2)), 5) / SAT_M
_open_water = (_lum < 70) & (ndimage.maximum_filter(chm, 5) < 3) & (_slope < 0.06)      # sure-water seeds
# open water is dark AND smooth; forest canopy is just as dark but bumpy - grow each seed through smooth dark pixels
_mu = ndimage.uniform_filter(lum, 5)
_sd = np.sqrt(np.maximum(ndimage.uniform_filter(lum * lum, 5) - _mu * _mu, 0))
_smooth_dark = (_sd < 9) & (_mu < 62) & (_slope < 0.1)
_wm = masks['water']
_wl, _wn = ndimage.label(_wm)
water_sat = np.zeros((SAT, SAT), bool)
_found, _missing, _used = [], [], set()
for _i in range(1, _wn + 1):
    yy, xx = np.nonzero(_wl == _i)
    c = align.map_to_sat(np.array([xx.mean()]), np.array([yy.mean()]))[0]
    x0, y0, r = int(c[0]), int(c[1]), 45
    win = np.s_[max(0, y0 - r):y0 + r, max(0, x0 - r):x0 + r]
    bl, bn = ndimage.label(_open_water[win])
    best = None
    if bn:
        sizes = ndimage.sum(_open_water[win], bl, range(1, bn + 1))
        b = 1 + int(np.argmax(sizes))
        by, bx = np.nonzero(bl == b)
        key = (int(by.mean()) + win[0].start, int(bx.mean()) + win[1].start)
        _blob_abs = np.zeros((SAT, SAT), bool); _blob_abs[by + win[0].start, bx + win[1].start] = True
        if sizes.max() >= 40 and not (_blob_abs & water_sat).any():      # not a pond we already placed
            best = key; _used.add(key)
            m = np.zeros((SAT, SAT), bool); m[by + win[0].start, bx + win[1].start] = True
            grow = np.zeros((SAT, SAT), bool); grow[win] = _smooth_dark[win]
            gl, _ = ndimage.label(grow | m)
            m = np.isin(gl, np.unique(gl[m]))
            m = ndimage.binary_fill_holes(ndimage.binary_closing(ndimage.binary_opening(m, iterations=1), iterations=2))
            water_sat |= ndimage.binary_dilation(m, iterations=1)
            _found.append((c, (key[1] - c[0], key[0] - c[1])))
    if best is None: _missing.append((_i, c))
for _i, c in _missing:                                     # shift the mapped outline like its nearest found pond
    if not _found: break
    off = min(_found, key=lambda f: np.hypot(*(f[0] - c)))[1]
    yy, xx = np.nonzero(_wl == _i)
    sp = align.map_to_sat(xx + .5, yy + .5)
    px = np.clip((sp[:, 0] + off[0]).round().astype(int), 0, SAT - 1); py = np.clip((sp[:, 1] + off[1]).round().astype(int), 0, SAT - 1)
    m = np.zeros((SAT, SAT), bool); m[py, px] = True
    water_sat |= ndimage.binary_fill_holes(ndimage.binary_closing(m, iterations=2))
print('ponds from satellite:', len(_found), '· moved with a neighbour:', len(_missing))
water = np.asarray(Image.fromarray(water_sat.astype(np.uint8) * 255).resize((TEX, TEX), Image.BILINEAR)) > 127

# ---------------------------------------------------------------- OSM roads, buildings, water
osm = json.load(open(os.path.join(RAW, 'osm.json')))['elements']
# game widths (m): real roads are too narrow to race on, so everything drivable is at least 12 m
ROAD_W = {'primary': 16, 'secondary': 15, 'tertiary': 14, 'unclassified': 13, 'residential': 13,
          'service': 12, 'track': 12, 'path': 3, 'footway': 2.5}
road_img = Image.new('L', (TEX, TEX), 0)      # 1 asphalt, 2 gravel
rd = ImageDraw.Draw(road_img)
bld_img = Image.new('L', (TEX, TEX), 0)
bd = ImageDraw.Draw(bld_img)
wat_img = Image.new('L', (TEX, TEX), 0)
wd = ImageDraw.Draw(wat_img)
buildings = []
road_paths = []            # world-space centre lines for the 3D road strips
for e in osm:
    t = e['tags']; geo = e.get('geometry')
    if not geo:
        continue
    px, py = lonlat_to_sat(np.array([q['lon'] for q in geo]), np.array([q['lat'] for q in geo]))
    tp = list(zip(px * TEX / SAT, py * TEX / SAT))
    if 'highway' in t:
        h = t['highway']
        if h not in ROAD_W:
            continue
        paved = h in ('primary', 'secondary', 'tertiary', 'unclassified', 'residential') or \
            t.get('surface') in ('asphalt', 'paved', 'concrete')
        w = max(2, int(round(ROAD_W[h] / TEX_M)))
        rd.line(tp, fill=1 if paved else 2, width=w, joint='curve')
        if h not in ('path', 'footway'):
            wx, wz = sat_to_world(px, py)
            road_paths.append({'kind': 'asphalt' if paved else 'gravel', 'w': ROAD_W[h],
                               'pts': [[round(float(a), 2), round(float(c), 2)] for a, c in zip(wx, wz)]})
        for q in tp:
            rd.ellipse([q[0] - w / 2, q[1] - w / 2, q[0] + w / 2, q[1] + w / 2], fill=1 if paved else 2)
    elif 'building' in t:
        bd.polygon(tp, fill=1)
        wx, wz = sat_to_world(px, py)
        lv = t.get('building:levels')
        hgt = float(t.get('height', 0) or 0) or (float(lv) * 3.2 if lv else (7.5 if len(geo) > 8 else 5.5))
        buildings.append({'pts': [[round(float(a), 2), round(float(c), 2)] for a, c in zip(wx, wz)][:-1],
                          'h': round(hgt, 1), 'name': t.get('name', '')})
    elif t.get('natural') == 'water':
        wd.polygon(tp, fill=1)
road = np.asarray(road_img)
bld = np.asarray(bld_img) > 0
water |= np.asarray(wat_img) > 0

trail = (trail_dist < TRAIL_HALF) & (road == 0) & ~bld & ~water


# ---------------------------------------------------------------- trail centre lines -> paths
def trace_skeleton(mask, min_len_px):
    """1-px skeleton -> list of pixel paths (junction-to-junction / end-to-end), short end spurs dropped."""
    sk = skeletonize(mask)
    ys, xs = np.nonzero(sk)
    on = set(zip(ys.tolist(), xs.tolist()))
    NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    nbrs = {p: [(p[0] + a, p[1] + b) for a, b in NB if (p[0] + a, p[1] + b) in on] for p in on}
    deg = {p: len(n) for p, n in nbrs.items()}
    nodes = {p for p, d in deg.items() if d != 2}
    used = set(); paths = []
    def walk(start, nxt):
        path = [start, nxt]; prev, cur = start, nxt
        while cur not in nodes:
            cand = [q for q in nbrs[cur] if q != prev and (min(cur, q), max(cur, q)) not in used]
            if not cand: break
            used.add((min(cur, cand[0]), max(cur, cand[0])))
            prev, cur = cur, cand[0]; path.append(cur)
            if cur == start: break
        return path
    for nd in nodes:
        for q in nbrs[nd]:
            e = (min(nd, q), max(nd, q))
            if e in used: continue
            used.add(e); paths.append(walk(nd, q))
    for p in on:                                   # pure loops with no junction
        for q in nbrs[p]:
            e = (min(p, q), max(p, q))
            if e in used: continue
            used.add(e); paths.append(walk(p, q))
    out = []
    for pth in paths:
        ends_free = deg[pth[0]] == 1 or deg[pth[-1]] == 1
        if ends_free and len(pth) < min_len_px: continue
        out.append(pth)
    return out


def rdp(pts, eps):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]; ab = b - a; L = np.hypot(*ab) or 1e-9
    r = pts - a; d = np.abs(ab[0] * r[:, 1] - ab[1] * r[:, 0]) / L
    i = int(d.argmax())
    if d[i] > eps: return np.vstack([rdp(pts[:i + 1], eps)[:-1], rdp(pts[i:], eps)])
    return np.vstack([a, b])


def chaikin(pts, n=2):
    for _ in range(n):
        q = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]): q += [a * .75 + b * .25, a * .25 + b * .75]
        q.append(pts[-1]); pts = np.array(q)
    return pts


trail_paths = []
for pth in trace_skeleton(trail_tex & ~(road > 0), int(8 / TEX_M)):
    w = np.array([[(x + .5) * TEX_M - SIZE / 2, (y + .5) * TEX_M - SIZE / 2] for y, x in pth])
    w = chaikin(rdp(w, 0.6), 2)
    if len(w) >= 2 and np.hypot(*np.diff(w, axis=0).T).sum() >= 4:
        trail_paths.append({'kind': 'trail', 'w': TRAIL_HALF * 2, 'pts': np.round(w, 2).tolist()})
print('paths: trails', len(trail_paths), 'roads', len(road_paths))


# ---------------------------------------------------------------- keep roads and trails out of the ponds
# The map draws trails running beside the ponds; with the map/satellite mismatch some ran through the water.
# Any centre-line point closer to the water than half the strip width + 1.5 m is pushed out to that distance.
_d_out, _i_out = ndimage.distance_transform_edt(~water, return_indices=True)    # land -> nearest water pixel
_d_in, _i_in = ndimage.distance_transform_edt(water, return_indices=True)       # water -> nearest land pixel
MAX_NUDGE = 6.0     # metres: further than this from where the map put it, the trail ends at the shore instead
def fix_path(path):
    """Returns the path split into pieces that stay out of the water. Points that only graze a pond are nudged
    onto the shore; where a trail would cross a pond it simply ends at the water's edge (like the map shows)."""
    keep = (path['w'] / 2 + 1.5) / TEX_M
    src = np.array(path['pts'], float)
    dense = [src[0]]                                              # resample every ~1 m so cuts land precisely
    for a, b in zip(src[:-1], src[1:]):
        n = max(1, int(np.hypot(*(b - a)) / 1.0))
        dense += [a + (b - a) * t for t in np.linspace(0, 1, n + 1)[1:]]
    pts = np.array(dense)
    new = pts.copy(); cut = np.zeros(len(pts), bool)
    for k in range(len(pts)):
        u = (pts[k] + SIZE / 2) / TEX_M
        iu, iv = int(np.clip(u[0], 0, TEX - 1)), int(np.clip(u[1], 0, TEX - 1))
        if water[iv, iu]:
            q = np.array([_i_in[1][iv, iu], _i_in[0][iv, iu]], float); d = q - u; need = (_d_in[iv, iu] + keep) * TEX_M
        elif _d_out[iv, iu] < keep:
            q = np.array([_i_out[1][iv, iu], _i_out[0][iv, iu]], float); d = u - q; need = (keep - _d_out[iv, iu]) * TEX_M
        else:
            continue
        if need > MAX_NUDGE: cut[k] = True; continue
        nrm = np.hypot(*d) or 1.0
        new[k] = (q + d / nrm * keep) * TEX_M - SIZE / 2
    pieces, run = [], []
    for k in range(len(new)):
        if cut[k]:
            if run: pieces.append(np.array(run)); run = []
        else: run.append(new[k])
    if run: pieces.append(np.array(run))
    out = []
    for pc in pieces:
        if len(pc) < 2 or np.hypot(*np.diff(pc, axis=0).T).sum() < 8: continue
        pc = chaikin(rdp(pc, 0.4), 2)
        out.append({**path, 'pts': np.round(pc, 2).tolist()})
    return out
_before = len(road_paths) + len(trail_paths)
road_paths = [q for p in road_paths for q in fix_path(p)]
trail_paths = [q for p in trail_paths for q in fix_path(p)]
print('paths after keeping out of ponds:', len(road_paths) + len(trail_paths), '(was', str(_before) + ')')
# rasterise the final strips: used for tree clearance, height smoothing and painting the ground beneath them
_pm = Image.new('L', (TEX, TEX), 0); _pd = ImageDraw.Draw(_pm)
for p in road_paths + trail_paths:
    tp = [((x + SIZE / 2) / TEX_M, (z + SIZE / 2) / TEX_M) for x, z in p['pts']]
    w = max(2, int(round(p['w'] / TEX_M)))
    _pd.line(tp, fill=255, width=w, joint='curve')
    for q in tp: _pd.ellipse([q[0] - w / 2, q[1] - w / 2, q[0] + w / 2, q[1] + w / 2], fill=255)
path_mask = np.asarray(_pm) > 0
path_dist = ndimage.distance_transform_edt(~path_mask) * TEX_M
print('strip pixels in water after pushing:', int((path_mask & water).sum()))

# ---------------------------------------------------------------- surface classes (physics + texture)
# 0 grass/field, 1 forest floor, 2 dirt trail, 3 asphalt, 4 gravel, 5 water, 6 building pad, 7 running track
tree_tex = np.asarray(Image.fromarray(tree.astype(np.uint8) * 255).resize((TEX, TEX), Image.BILINEAR)) > 127
surf = np.zeros((TEX, TEX), np.uint8)
surf[tree_tex] = 1
surf[trail] = 2
surf[road == 2] = 4
surf[road == 1] = 3
surf[water] = 5
surf[bld] = 6
# running track oval: reddish ring around the track centre seen in the image
tc = np.array(align.map_to_sat(np.array([700]), np.array([1108])))[0] * TEX / SAT
yy, xx = np.ogrid[0:TEX, 0:TEX]
ex = ((xx - tc[0]) / (40 / TEX_M)) ** 2 + ((yy - tc[1]) / (88 / TEX_M)) ** 2
surf[(ex < 1.0) & (ex > 0.62) & (surf <= 1)] = 7
del yy, xx, ex

# ---------------------------------------------------------------- ground texture
# Stylised flat colours (no photo): open land is sorted into lawn / meadow / dry field / plowed from the
# satellite's broad colour, everything else gets a clean class colour. Fine detail comes from the shader.
sat_big = np.asarray(Image.open(os.path.join(RAW, 'naip.jpg')).convert('RGB')
                     .resize((TEX, TEX), Image.BILINEAR).filter(ImageFilter.GaussianBlur(10))).astype(np.float32)
REF = np.array([(92, 112, 62), (112, 116, 76), (168, 150, 104), (112, 94, 74)], np.float32)   # satellite looks
OPEN = np.array([(118, 172, 70), (146, 166, 82), (212, 186, 112), (156, 116, 80)], np.float32)  # game colours
d = ((sat_big[:, :, None, :] - REF[None, None]) ** 2).sum(-1)
land = OPEN[d.argmin(-1)]
del d, sat_big
land = ndimage.median_filter(land, size=(9, 9, 1))          # tidy patch edges
col = land.copy()
# roads and trails are 3D strips in the game, so the ground under/around them is painted as the land it
# runs through (forest floor in the woods, field colour in the open) – no brown spilling past the strip edge
under = (surf == 2) | (surf == 3) | (surf == 4)
road_like = path_mask.copy()                # where the 3D strips really are, for flattening heights under them
surf[under & tree_tex] = 1
surf[under & ~tree_tex] = 0
# ---- ponds, from the real elevation: lidar sees a pond as a flat surface, so the water level is the low flat
# part inside the mapped outline. Only ground that is actually at that level is water - the outline also
# covers some hillside, which stays dry (digging it out made a cliff).
HCELL = SIZE / (HN - 1)
hs = TEX // HN
outline = ndimage.binary_dilation(ndimage.zoom(water.astype(np.float32), 1 / hs, order=1) > 0.5, iterations=2)
pond_wet = np.zeros((HN, HN), bool); pond_lab = np.zeros((HN, HN), np.int32); pond_levels = []
lab0, n0 = ndimage.label(outline)
for i in range(1, n0 + 1):
    m = lab0 == i
    if m.sum() < 3: continue
    core = ndimage.binary_erosion(m, iterations=2)
    level = float(np.percentile(dem[core if core.sum() > 3 else m], 10)) + 0.05
    wet = ndimage.binary_erosion(m, iterations=2) & (dem < level + 1.5)   # outline was grown by 2 above
    wl, wn = ndimage.label(wet)                       # keep the main body of water, not stray low pixels
    if wn == 0: continue
    big = 1 + int(np.argmax(ndimage.sum(wet, wl, range(1, wn + 1))))
    wet = wl == big
    if wet.sum() < 3: continue
    pond_levels.append(level); pond_lab[wet] = len(pond_levels); pond_wet |= wet
# paint the bed as mud where there is water (the see-through water surface supplies the blue);
# everything the old map outline covered outside that is painted as the land around it
wet_tex = np.asarray(Image.fromarray(pond_wet.astype(np.uint8) * 255).resize((TEX, TEX), Image.BILINEAR)) > 100
dry_bank = (surf == 5) & ~wet_tex
surf[dry_bank & tree_tex] = 1
surf[dry_bank & ~tree_tex] = 0
surf[wet_tex & (surf <= 1)] = 5
SURF_COL = {1: (64, 96, 50), 5: (104, 92, 66), 6: (196, 196, 190), 7: (200, 86, 66)}
for c, rgb in SURF_COL.items():
    col[surf == c] = np.array(rgb, np.float32)
# borders: darker rim on trails, white edge lines on asphalt, darker rim on gravel
def rim(mask, width_m):
    inner = ndimage.binary_erosion(mask, iterations=max(1, int(round(width_m / TEX_M))))
    return mask & ~inner
# gentle large-scale tone variation so big fields aren't flat paint
tone = ndimage.gaussian_filter(rng.standard_normal((TEX // 8, TEX // 8)).astype(np.float32), 4)
tone = ndimage.zoom(tone / (tone.std() + 1e-6), 8, order=1)[:TEX, :TEX, None]
col *= 1 + tone * 0.05
Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)).save(os.path.join(OUT, 'ground.png'), optimize=False)

# ---------------------------------------------------------------- flatten heights under trails/roads a bit
# (bare-earth lidar is already good; this only removes the 1-2 m lumps a car would catch air on)
flat = ndimage.gaussian_filter(dem, 3.0)
hs = TEX // HN
pathy = ndimage.zoom((road_like | (surf == 7)).astype(np.float32),
                     1 / hs, order=1)
wgt = np.clip(ndimage.gaussian_filter(pathy, 1.5) * 2.0, 0, 1)
height = dem * (1 - wgt) + flat * wgt
# ponds: carve a gentle bowl into the wet cells only (shore depth ~0.3 m, ~0.3 m deeper per 3.5 m, max 1.6 m)
ponds = []
pond_id = np.zeros((HN, HN), np.uint8)       # which pond (1-based) each height-grid vertex belongs to
for k, level in enumerate(pond_levels, 1):
    m = pond_lab == k
    dist = ndimage.distance_transform_edt(m)[m]
    height[m] = np.minimum(height[m], level - np.minimum(1.6, 0.15 + dist * 0.3))
    sq = np.ones((3, 3), bool)                                   # grow diagonally too, not just sideways
    rim_zone = ndimage.binary_dilation(m, structure=sq, iterations=2) & ~m
    height[rim_zone] = np.maximum(height[rim_zone], level + 0.18)   # dry shore stays just above the water line
    pond_id[ndimage.binary_dilation(m, structure=sq, iterations=1)] = len(ponds) + 1
    ii, jj = np.nonzero(m)
    ponds.append({'level': round(level, 3),
                  'x0': round(-SIZE / 2 + (jj.min() - 1) * HCELL, 1), 'x1': round(-SIZE / 2 + (jj.max() + 1) * HCELL, 1),
                  'z0': round(-SIZE / 2 + (ii.min() - 1) * HCELL, 1), 'z1': round(-SIZE / 2 + (ii.max() + 1) * HCELL, 1)})
print('ponds', len(ponds), [round((p['x1'] - p['x0']) * (p['z1'] - p['z0'])) for p in ponds])
height.astype('<f4').tofile(os.path.join(OUT, 'height.bin'))
surf.tofile(os.path.join(OUT, 'surface.bin'))

# ---------------------------------------------------------------- trees
SP = 7.0
gx, gz = np.meshgrid(np.arange(-SIZE / 2 + SP / 2, SIZE / 2, SP), np.arange(-SIZE / 2 + SP / 2, SIZE / 2, SP))
gx = gx.ravel() + rng.uniform(-SP * .45, SP * .45, gx.size)
gz = gz.ravel() + rng.uniform(-SP * .45, SP * .45, gz.size)
sx = np.clip(((gx + SIZE / 2) / SAT_M).astype(int), 0, SAT - 1)
sz = np.clip(((gz + SIZE / 2) / SAT_M).astype(int), 0, SAT - 1)
tx = np.clip(((gx + SIZE / 2) / TEX_M).astype(int), 0, TEX - 1)
tz = np.clip(((gz + SIZE / 2) / TEX_M).astype(int), 0, TEX - 1)
road_dist = ndimage.distance_transform_edt(road == 0) * TEX_M
bld_dist = ndimage.distance_transform_edt(~bld) * TEX_M
keep = tree[sz, sx] & (path_dist[tz, tx] > 1.2) & (road_dist[tz, tx] > 2.5) & \
    (bld_dist[tz, tx] > 4) & ~water[tz, tx] & (np.abs(gx) < SIZE / 2 - 4) & (np.abs(gz) < SIZE / 2 - 4)
# a few scattered trees on open ground near forest edges (hedgerows, yard trees)
edge_zone = ndimage.binary_dilation(tree, iterations=3) & ~tree
keep |= edge_zone[sz, sx] & (rng.random(gx.size) < 0.12) & (path_dist[tz, tx] > 3) & (road_dist[tz, tx] > 5) \
    & (bld_dist[tz, tx] > 6) & ~water[tz, tx]
kind = broad[sz, sx].astype(np.float32)                         # 0 conifer, 1 broadleaf
ch = ndimage.maximum_filter(chm, 3)[sz, sx]
hgt = np.clip(ch * rng.uniform(0.85, 1.1, gx.size), 6, 48)
T = np.stack([gx, gz, hgt, kind], 1)[keep].astype('<f4')
T.tofile(os.path.join(OUT, 'trees.bin'))
print('trees', len(T), f'({(kind[keep] > 0).mean() * 100:.0f}% broadleaf)', 'buildings', len(buildings))

json.dump(buildings, open(os.path.join(OUT, 'buildings.json'), 'w'))
json.dump(road_paths + trail_paths, open(os.path.join(OUT, 'paths.json'), 'w'))
json.dump(ponds, open(os.path.join(OUT, 'ponds.json'), 'w'))
pond_id.tofile(os.path.join(OUT, 'ponds.bin'))

# ---------------------------------------------------------------- meta + spawn
mb = np.array(align.map_to_sat(np.array([700]), np.array([1430])))[0]   # parking just south of Main Building
sx_, sz_ = sat_to_world(mb[0], mb[1])
json.dump({'size': SIZE, 'heightN': HN, 'surfN': TEX, 'lat': lat_c,
           'hmin': float(height.min()), 'hmax': float(height.max()),
           'spawn': [float(sx_), float(sz_)], 'trails': trail_lines},
          open(os.path.join(OUT, 'meta.json'), 'w'), indent=1)

# ---------------------------------------------------------------- check image: tree cover + trails on satellite
chk = np.asarray(Image.open(os.path.join(RAW, 'naip.jpg')).convert('RGB')).astype(np.float32).copy()
chk[tree] = chk[tree] * 0.4 + np.array([0, 255, 60]) * 0.6
tr2 = ndimage.zoom(trail.astype(np.uint8), SAT / TEX, order=0) > 0
chk[tr2] = (255, 220, 120)
Image.fromarray(chk.astype(np.uint8)[300:1600, 300:1300]).save(os.path.join(RAW, 'treecover_check.jpg'), quality=85)
print('done')
