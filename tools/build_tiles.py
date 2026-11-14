"""Builds the tiled world (game/assets/tiles/) from data/raw/tiles/* (see fetch_tiles.py) + OSM + Ethan's trail map.

Same world frame as before: metres, x east, z south, origin = centre of the original campus map.
Tile (tx, tz) covers x in [tx*2000-1000, tx*2000+1000] (z likewise).

Things that must line up across tiles are built on ONE global grid first (heights, path smoothing, pond carving),
then cut into tiles, so there are no seams. Per-tile things (ground colours, trees, surface classes) are built
from each tile's own satellite / tree-height data.

Per tile, game/assets/tiles/<tx>_<tz>/:
  height.bin    float32 (HN+2*HM)^2 heights on a 4 m grid: the tile's 501^2 vertices plus HM vertices of margin
  surface.bin   uint8 2000^2 surface classes at 1 m (0 grass, 1 forest floor, 5 pond bed, 6 building pad, 7 track)
  ground.png    2048^2 stylised ground colours
  (written packed by default — height.bin.gz, surface.bin.gz, ponds.bin.gz, tile.json.gz, ground.jpg, see tilefmt.py;
   YR_PACK=0 writes the plain files above)
  trees.bin     float32 [x, z, height, broadleaf] per tree
  tile.json     buildings, road/trail strips (render + physics pieces), ponds
game/assets/world.json: tile size, list of tiles, spawn, height grid info.
"""
import json, math, os, sys, time
from collections import Counter, defaultdict
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage
from skimage.morphology import skeletonize

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import mapdata, align, roadnet, tilefmt
from fetch_tiles import TILE, MARGIN, TX, TZ, TILE_SET, HSTEP, CX, CY, K, R

RAW = os.path.join(ROOT, 'data', 'raw')
ASSETS = os.environ.get('YR_ASSETS', os.path.join(ROOT, 'game', 'assets'))   # YR_ASSETS=dir builds somewhere else, to swap in after
OUT = os.path.join(ASSETS, 'tiles')
PACK = os.environ.get('YR_PACK', '1') != '0'      # packed tile files (tools/tilefmt.py); YR_PACK=0 writes the old ones
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(7)
T0 = time.time()
def log(*a): print(f'[{time.time() - T0:5.0f}s]', *a, flush=True)

TILES = [(tx, tz) for tx, tz in TILE_SET if os.path.exists(os.path.join(RAW, 'tiles', f'{tx}_{tz}', 'chm.npy'))]
# YR_TILES=9_-6,2_1 builds only those tiles, on a height grid around just them (quick, low-memory test builds;
# heights near a test tile's edge can differ slightly from a full build)
if os.environ.get('YR_TILES'):
    TILES = [tuple(map(int, t.split('_'))) for t in os.environ['YR_TILES'].split(',')]
TILE_KEYS = set(TILES)
_tx = [t[0] for t in TILES] if os.environ.get('YR_TILES') else [TX.start, TX.stop - 1]
_tz = [t[1] for t in TILES] if os.environ.get('YR_TILES') else [TZ.start, TZ.stop - 1]
GX0, GX1 = min(_tx) * TILE - TILE / 2, max(_tx) * TILE + TILE / 2     # global extent
GZ0, GZ1 = min(_tz) * TILE - TILE / 2, max(_tz) * TILE + TILE / 2
HN = int(TILE / HSTEP) + 1                       # 501 vertices per tile side
HM = 8                                            # height margin vertices kept around each tile (32 m)
SAT_N = TILE + 2 * MARGIN                         # raw satellite / chm pixels per tile (1 m)
GHW, GHH = int((GX1 - GX0) / HSTEP) + 1, int((GZ1 - GZ0) / HSTEP) + 1
log('tiles', len(TILES), 'global height grid', GHW, 'x', GHH)

# ---------------------------------------------------------------- helpers
def lonlat_to_world(lon, lat):
    mx = R * np.radians(lon); my = R * np.log(np.tan(np.pi / 4 + np.radians(lat) / 2))
    return (mx - CX) * K, (CY - my) * K


def rdp(pts, eps):
    if len(pts) < 3: return pts
    a, b = pts[0], pts[-1]; ab = b - a; L = np.hypot(*ab)
    r = pts - a
    # closed loop (roundabout, cul-de-sac circle): measure from the start point, or the whole loop collapses
    d = np.abs(ab[0] * r[:, 1] - ab[1] * r[:, 0]) / L if L > 1e-6 else np.hypot(*r.T)
    i = int(d.argmax())
    if d[i] > eps: return np.vstack([rdp(pts[:i + 1], eps)[:-1], rdp(pts[i:], eps)])
    return np.vstack([a, b])


def chaikin(pts, n=2):
    for _ in range(n):
        q = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]): q += [a * .75 + b * .25, a * .25 + b * .75]
        q.append(pts[-1]); pts = np.array(q)
    return pts


def tile_rect(tx, tz, pad=0.0):
    return tx * TILE - TILE / 2 - pad, tz * TILE - TILE / 2 - pad, tx * TILE + TILE / 2 + pad, tz * TILE + TILE / 2 + pad


def tile_of(x, z):
    return int(math.floor((x + TILE / 2) / TILE)), int(math.floor((z + TILE / 2) / TILE))


def in_map(x, z, pad=0.0):
    """True where a point is on a built tile (or within pad metres of one). x, z arrays."""
    x, z = np.atleast_1d(x), np.atleast_1d(z); ok = np.zeros(len(x), bool)
    for dx in ((0,) if pad == 0 else (-pad, 0, pad)):
        for dz in ((0,) if pad == 0 else (-pad, 0, pad)):
            tx = np.floor((x + dx + TILE / 2) / TILE).astype(int); tz = np.floor((z + dz + TILE / 2) / TILE).astype(int)
            ok |= np.array([(a, b) in TILE_KEYS for a, b in zip(tx, tz)])
    return ok


def keep_in_map(pts, pad=120.0):
    """The runs of a polyline that lie on the map (densified to 20 m so long segments can't skip a gap)."""
    d, orig = [pts[0]], [True]
    for a, b in zip(pts[:-1], pts[1:]):
        n = max(1, int(np.hypot(*(b - a)) / 20.0))
        d += [a + (b - a) * t for t in np.linspace(0, 1, n + 1)[1:]]; orig += [False] * (n - 1) + [True]
    d = np.array(d); ok = in_map(d[:, 0], d[:, 1], pad)
    if ok.all(): return [pts]
    runs, cur = [], []
    for k in range(len(d)):
        if ok[k]: cur.append(k)
        if cur and (not ok[k] or k == len(d) - 1):
            idx = [i for i in cur if orig[i] or i == cur[0] or i == cur[-1]]
            if len(idx) >= 2: runs.append(d[idx])
            cur = []
    return runs


# ---------------------------------------------------------------- 1. OpenStreetMap: roads, buildings, water
osm = json.load(open(os.path.join(RAW, 'osm_region.json')))['elements']
ROAD_W = {'motorway': 18, 'trunk': 17, 'primary': 16, 'secondary': 15, 'tertiary': 14, 'unclassified': 13,
          'residential': 10, 'service': 12, 'track': 12, 'living_street': 10}
# service roads by their OSM `service` tag (untagged service roads, e.g. the campus drives, keep 12 m)
SERVICE_W = {'alley': 5, 'driveway': 5, 'parking_aisle': 6, 'drive-through': 5}
FLAT_DRIVEWAY = 30.0                 # driveways shorter than this and all parking aisles: flat paving (flat: true)
PAVED = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street'}
road_paths, buildings, water_polys = [], [], []
for e in osm:
    t = e.get('tags', {}); geo = e.get('geometry')
    if not geo: continue
    wx, wz = lonlat_to_world(np.array([q['lon'] for q in geo]), np.array([q['lat'] for q in geo]))
    pts = np.stack([wx, wz], 1)
    h = t.get('highway')
    if h:
        h = h.replace('_link', '')
        if h not in ROAD_W: continue
        paved = h in PAVED or t.get('surface') in ('asphalt', 'paved', 'concrete')
        svc = t.get('service') if h == 'service' else None
        try: lanes = int(t.get('lanes', 0)) or None
        except ValueError: lanes = None
        attr = {'cls': h + (':' + svc if svc in SERVICE_W else ''), 'lanes': lanes,
                'sidewalk': t.get('sidewalk') if t.get('sidewalk') in ('both', 'left', 'right', 'yes', 'separate') else None,
                'oneway': t.get('oneway') in ('yes', '1', '-1') or t.get('junction') == 'roundabout'}
        w = SERVICE_W.get(svc, ROAD_W[h])
        for run in keep_in_map(pts):
            road_paths.append({'kind': 'asphalt' if paved else 'gravel', 'w': w, 'pts': run, 'bridge': t.get('bridge') == 'yes',
                               'attr': attr})
    elif 'building' in t:
        if not in_map(pts[:, 0].mean(), pts[:, 1].mean(), 80)[0]: continue
        lv = t.get('building:levels')
        try: hgt = float(t.get('height', 0) or 0) or (float(lv) * 3.2 if lv else (7.5 if len(geo) > 8 else 5.5))
        except ValueError: hgt = 6.0
        buildings.append({'pts': pts[:-1], 'h': round(hgt, 1)})
    elif t.get('natural') == 'water' and e['type'] == 'way':
        if in_map(pts[:, 0], pts[:, 1], 100).any(): water_polys.append(pts)
if os.path.isfile(os.path.join(RAW, 'footprints.geojson')):
    import footprints
    buildings = footprints.merge(buildings, footprints.load_geojson(os.path.join(RAW, 'footprints.geojson'), lonlat_to_world))
log('osm: roads', len(road_paths), 'buildings', len(buildings), 'water polygons', len(water_polys))
# town ground (fetch_tiles.py fetch_landuse): green = parks / lawns / pitches / cemeteries, grey = parking + lots
GREEN_LU = {'grass', 'recreation_ground', 'cemetery', 'village_green', 'park', 'pitch', 'playground', 'garden',
            'golf_course', 'sports_centre'}
lu_green, lu_grey, lu_lots = [], [], []      # lots: industrial / commercial zones (grey only where bare or paved)
_lu = os.path.join(RAW, 'osm_landuse.json')
for e in (json.load(open(_lu))['elements'] if os.path.exists(_lu) else []):
    t = e.get('tags', {}); kind = t.get('landuse') or t.get('leisure') or t.get('amenity')
    rings = [e['geometry']] if e.get('geometry') else [m['geometry'] for m in e.get('members', []) if m.get('role') == 'outer' and m.get('geometry')]
    for g in rings:
        if len(g) < 3: continue
        wx, wz = lonlat_to_world(np.array([q['lon'] for q in g]), np.array([q['lat'] for q in g]))
        if not in_map(wx, wz, 50).any(): continue
        (lu_green if kind in GREEN_LU else lu_grey if kind == 'parking' else lu_lots).append(np.stack([wx, wz], 1))
log('land use polygons: green', len(lu_green), 'parking', len(lu_grey), 'lots', len(lu_lots))

# ---------------------------------------------------------------- 2. campus: trails + ponds from Ethan's map
# These come from the original single-map pipeline (old 2048 px satellite frame, same world origin).
info = json.load(open(os.path.join(RAW, 'naip_info.json')))['extent']
OLD_SIZE = (info['xmax'] - info['xmin']) * K
OLD_SAT = 2048; OLD_SM = OLD_SIZE / OLD_SAT
CT = 4096; CT_M = OLD_SIZE / CT                     # campus raster 0.87 m/px over the old map area
def old_sat_to_world(px, py): return (np.asarray(px) - OLD_SAT / 2) * OLD_SM, (np.asarray(py) - OLD_SAT / 2) * OLD_SM

masks = mapdata.map_masks()
trail_tex = np.zeros((CT, CT), bool)
for k in ['black', 'longwalk', 'overgrown', 'odyssey', 'ripps', 'agony', 'waterfall']:
    ys, xs = np.nonzero(skeletonize(masks[k]))
    p = align.map_to_sat(xs + 0.5, ys + 0.5) * (CT / OLD_SAT)
    ok = (p[:, 0] >= 0) & (p[:, 0] < CT) & (p[:, 1] >= 0) & (p[:, 1] < CT)
    pi = p[ok].astype(int); m = np.zeros((CT, CT), bool); m[pi[:, 1], pi[:, 0]] = True
    trail_tex |= ndimage.binary_dilation(m, iterations=2)
_ri = Image.new('L', (CT, CT), 0); _rd = ImageDraw.Draw(_ri)        # roads on the campus raster (trails stop at them)
for rp in road_paths:
    tp = [((x + OLD_SIZE / 2) / CT_M, (z + OLD_SIZE / 2) / CT_M) for x, z in rp['pts']]
    _rd.line(tp, fill=255, width=max(2, int(rp['w'] / CT_M)), joint='curve')
campus_road = np.asarray(_ri) > 0


def trace_skeleton(mask, min_len_px):
    sk = skeletonize(mask); ys, xs = np.nonzero(sk); on = set(zip(ys.tolist(), xs.tolist()))
    NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    nbrs = {p: [(p[0] + a, p[1] + b) for a, b in NB if (p[0] + a, p[1] + b) in on] for p in on}
    deg = {p: len(n) for p, n in nbrs.items()}; nodes = {p for p, d in deg.items() if d != 2}
    used = set(); paths = []
    def walk(start, nxt):
        path = [start, nxt]; prev, cur = start, nxt
        while cur not in nodes:
            cand = [q for q in nbrs[cur] if q != prev and (min(cur, q), max(cur, q)) not in used]
            if not cand: break
            used.add((min(cur, cand[0]), max(cur, cand[0]))); prev, cur = cur, cand[0]; path.append(cur)
            if cur == start: break
        return path
    for p0 in list(nodes) + list(on):
        for q in nbrs[p0]:
            e2 = (min(p0, q), max(p0, q))
            if e2 in used: continue
            used.add(e2); paths.append(walk(p0, q))
    return [p for p in paths if not ((deg[p[0]] == 1 or deg[p[-1]] == 1) and len(p) < min_len_px)]


TRAIL_W = 12.0
trail_paths = []
for pth in trace_skeleton(trail_tex & ~campus_road, int(8 / CT_M)):
    w = np.array([[(x + .5) * CT_M - OLD_SIZE / 2, (y + .5) * CT_M - OLD_SIZE / 2] for y, x in pth])
    w = chaikin(rdp(w, 0.6), 2)
    if len(w) >= 2 and np.hypot(*np.diff(w, axis=0).T).sum() >= 4:
        trail_paths.append({'kind': 'trail', 'w': TRAIL_W, 'pts': w})
log('campus trails', len(trail_paths))

# campus ponds: map says roughly where, satellite says exactly (same method as the approved single map)
osat = np.asarray(Image.open(os.path.join(RAW, 'naip.jpg')).convert('RGB')).astype(np.float32)
olum = osat.mean(2); ochm = np.load(os.path.join(RAW, 'chm.npy'))
odem = np.array(Image.open(os.path.join(RAW, 'dem.tif'))).astype(np.float32)
_dem2 = np.asarray(Image.fromarray(odem).resize((OLD_SAT, OLD_SAT), Image.BILINEAR))
_slope = ndimage.uniform_filter(np.hypot(*np.gradient(_dem2)), 5) / OLD_SM
_lum5 = ndimage.uniform_filter(olum, 5)
_open = (_lum5 < 70) & (ndimage.maximum_filter(ochm, 5) < 3) & (_slope < 0.06)
_sd = np.sqrt(np.maximum(ndimage.uniform_filter(olum * olum, 5) - _lum5 * _lum5, 0))
_smooth_dark = (_sd < 9) & (_lum5 < 62) & (_slope < 0.1)
_wl, _wn = ndimage.label(masks['water'])
campus_water = np.zeros((OLD_SAT, OLD_SAT), bool); _found, _missing = [], []
for i in range(1, _wn + 1):
    yy, xx = np.nonzero(_wl == i); c = align.map_to_sat(np.array([xx.mean()]), np.array([yy.mean()]))[0]
    x0, y0, rr = int(c[0]), int(c[1]), 45
    win = np.s_[max(0, y0 - rr):y0 + rr, max(0, x0 - rr):x0 + rr]
    bl, bn = ndimage.label(_open[win]); placed = False
    if bn:
        sizes = ndimage.sum(_open[win], bl, range(1, bn + 1)); b = 1 + int(np.argmax(sizes))
        by, bx = np.nonzero(bl == b)
        m = np.zeros((OLD_SAT, OLD_SAT), bool); m[by + win[0].start, bx + win[1].start] = True
        if sizes.max() >= 40 and not (m & campus_water).any():
            grow = np.zeros_like(m); grow[win] = _smooth_dark[win]
            gl, _ = ndimage.label(grow | m); m = np.isin(gl, np.unique(gl[m]))
            m = ndimage.binary_fill_holes(ndimage.binary_closing(ndimage.binary_opening(m, iterations=1), iterations=2))
            campus_water |= ndimage.binary_dilation(m, iterations=1); placed = True
            _found.append((c, (by.mean() + win[0].start - c[1], bx.mean() + win[1].start - c[0])))
    if not placed: _missing.append((i, c))
for i, c in _missing:
    if not _found: break
    off = min(_found, key=lambda f: np.hypot(*(f[0] - c)))[1]
    yy, xx = np.nonzero(_wl == i); sp = align.map_to_sat(xx + .5, yy + .5)
    px = np.clip((sp[:, 0] + off[1]).round().astype(int), 0, OLD_SAT - 1); py = np.clip((sp[:, 1] + off[0]).round().astype(int), 0, OLD_SAT - 1)
    m = np.zeros((OLD_SAT, OLD_SAT), bool); m[py, px] = True
    campus_water |= ndimage.binary_fill_holes(ndimage.binary_closing(m, iterations=2))
log('campus ponds from satellite', len(_found), 'moved with neighbour', len(_missing))
_cy, _cx = np.nonzero(campus_water)
campus_water_pts = np.stack(old_sat_to_world(_cx + .5, _cy + .5), 1)          # world coords of water pixels (1.74 m)
TRACK_C = np.array(old_sat_to_world(*align.map_to_sat(np.array([700]), np.array([1108]))[0]))
SPAWN_OLD = np.array(old_sat_to_world(*align.map_to_sat(np.array([700]), np.array([1430]))[0]))
del osat, olum, ochm, odem, _dem2, _slope, _lum5, _open, _sd, _smooth_dark

# ---------------------------------------------------------------- 3. global water mask (2 m)
WM = 2.0
GWW, GWH = int((GX1 - GX0) / WM), int((GZ1 - GZ0) / WM)
_wimg = Image.new('L', (GWW, GWH), 0); _wd = ImageDraw.Draw(_wimg)
for poly in water_polys:
    _wd.polygon([((x - GX0) / WM, (z - GZ0) / WM) for x, z in poly], fill=255)
gwater = np.asarray(_wimg) > 0
cu = ((campus_water_pts[:, 0] - GX0) / WM).astype(int); cv = ((campus_water_pts[:, 1] - GZ0) / WM).astype(int)
okc = (cu >= 0) & (cu < GWW) & (cv >= 0) & (cv < GWH)
gwater[cv[okc], cu[okc]] = True
gwater = ndimage.binary_closing(gwater, iterations=1)
log('water pixels', int(gwater.sum()), f'({gwater.sum() * WM * WM / 1e4:.1f} ha)')

# ---------------------------------------------------------------- 4. keep roads/trails out of the water
# distances only over the box around the water (the full 2 m grid is too big for 4 distance/index arrays)
_wr, _wc = np.nonzero(gwater.any(1))[0], np.nonzero(gwater.any(0))[0]
WR0, WR1 = (max(0, _wr[0] - 32), min(GWH, _wr[-1] + 33)) if len(_wr) else (0, 1)
WC0, WC1 = (max(0, _wc[0] - 32), min(GWW, _wc[-1] + 33)) if len(_wc) else (0, 1)
_gwc = gwater[WR0:WR1, WC0:WC1]
_d_out, _i_out = ndimage.distance_transform_edt(~_gwc, return_indices=True)
_d_in, _i_in = ndimage.distance_transform_edt(_gwc, return_indices=True)
MAX_NUDGE = 6.0
def fix_path(path):
    """Trails grazing water are nudged onto the shore; trails that would cross it end at the water's edge.
    Roads are only nudged (they never get cut: a road over water stays continuous)."""
    keep = (path['w'] / 2 + 1.5) / WM
    src = np.asarray(path['pts'], float)
    dense = [src[0]]
    for a, b in zip(src[:-1], src[1:]):
        n = max(1, int(np.hypot(*(b - a)) / 1.0)); dense += [a + (b - a) * t for t in np.linspace(0, 1, n + 1)[1:]]
    pts = np.array(dense); new = pts.copy(); cut = np.zeros(len(pts), bool)
    ends = pts[0].copy(), pts[-1].copy()
    u = (pts - [GX0 + WC0 * WM, GZ0 + WR0 * WM]) / WM            # cell coords in the water box
    inside = (u[:, 0] >= 0) & (u[:, 0] < WC1 - WC0) & (u[:, 1] >= 0) & (u[:, 1] < WR1 - WR0)
    iu = np.clip(u[:, 0].astype(int), 0, WC1 - WC0 - 1); iv = np.clip(u[:, 1].astype(int), 0, WR1 - WR0 - 1)
    for k in np.nonzero(inside & (_gwc[iv, iu] | (_d_out[iv, iu] < keep)))[0]:
        a, b = iv[k], iu[k]
        if _gwc[a, b]: q = np.array([_i_in[1][a, b], _i_in[0][a, b]], float); d = q - u[k]; need = (_d_in[a, b] + keep) * WM
        else: q = np.array([_i_out[1][a, b], _i_out[0][a, b]], float); d = u[k] - q; need = (keep - _d_out[a, b]) * WM
        if need > MAX_NUDGE:
            if path['kind'] == 'trail': cut[k] = True
            continue
        new[k] = (q + d / (np.hypot(*d) or 1.0) * keep) * WM + [GX0 + WC0 * WM, GZ0 + WR0 * WM]
    if not cut[0]: new[0] = ends[0]                 # junction ends stay put (other roads meet there)
    if not cut[-1]: new[-1] = ends[1]
    out, run, flags = [], [], []
    for k in range(len(new)):
        if cut[k]:
            if run: out.append(np.array(run)); flags.append((run0 == 0, False)); run = []
        else:
            if not run: run0 = k
            run.append(new[k])
    if run: out.append(np.array(run)); flags.append((run0 == 0, True))
    return [({**path, 'pts': chaikin(rdp(pc, 0.4), 2)}, fl) for pc, fl in zip(out, flags)
            if len(pc) >= 2 and np.hypot(*np.diff(pc, axis=0).T).sum() >= 8]

# road network: ways that share a point meet at a junction; dead ends near a road join it; tiny bits collapse
nodes, edges = roadnet.build_graph(road_paths + trail_paths)
log('graph: nodes', len(nodes), 'edges', len(edges))
log('dead ends joined', roadnet.snap_dead_ends(nodes, edges))
for _ in range(3):
    roadnet.merge_deg2(nodes, edges); roadnet.contract_short(nodes, edges)
roadnet.merge_deg2(nodes, edges)
nodes, edges = roadnet.compact(nodes, edges)
# water: nudge / cut each edge (junction ends are kept unless the edge is cut there)
fixed = []
for e in edges:
    for piece, (keep_a, keep_b) in fix_path(e):
        a = e['a'] if keep_a else len(nodes)
        if not keep_a: nodes.append(piece['pts'][0].copy())
        b = e['b'] if keep_b else len(nodes)
        if not keep_b: nodes.append(piece['pts'][-1].copy())
        fixed.append({'a': a, 'b': b, 'pts': piece['pts'], 'kind': e['kind'], 'w': e['w'], 'attr': e.get('attr', {})})
nodes, edges = roadnet.compact(nodes, fixed)
paths = edges
deg = Counter([e['a'] for e in edges] + [e['b'] for e in edges])
log('network: edges', len(edges), 'junctions', sum(1 for v in deg.values() if v >= 3),
    'dead ends', sum(1 for v in deg.values() if v == 1))
del _d_out, _i_out, _d_in, _i_in
log('paths', len(paths))

# per-road data written into tile.json: OSM class, lanes, sidewalk, oneway; flat paving for tiny service stubs;
# median for split carriageways (two one-way roads of the same class side by side, opposite directions)
from scipy.spatial import cKDTree as _KD
_samp, _owner = [], []
for i, p in enumerate(paths):
    a = p.get('attr', {})
    if not a.get('oneway'): continue
    q = roadnet.at_s(p['pts'], np.arange(0, roadnet.arclen(p['pts'])[-1], 10.0))
    tg = np.gradient(q, axis=0) if len(q) > 1 else np.zeros_like(q)
    for k in range(len(q)): _samp.append((q[k, 0], q[k, 1], tg[k, 0], tg[k, 1])); _owner.append(i)
_samp, _owner = np.array(_samp).reshape(-1, 4), np.array(_owner, int)
_kd = _KD(_samp[:, :2]) if len(_samp) else None
for i, p in enumerate(paths):
    a = p.get('attr', {}); cls = a.get('cls', p['kind'])          # Ethan's campus trails: cls 'trail'
    L = float(roadnet.arclen(p['pts'])[-1])
    meta = {'cls': cls}
    if a.get('lanes'): meta['lanes'] = a['lanes']
    if a.get('sidewalk'): meta['sidewalk'] = a['sidewalk']
    if a.get('oneway'): meta['oneway'] = True
    if cls == 'service:parking_aisle' or (cls == 'service:driveway' and L < FLAT_DRIVEWAY): meta['flat'] = True
    if a.get('oneway') and _kd is not None:
        mine = np.nonzero(_owner == i)[0]; hits = 0
        for k in mine:
            for j in _kd.query_ball_point(_samp[k, :2], 30.0):
                o = _owner[j]
                if o != i and paths[o].get('attr', {}).get('cls') == cls and \
                   np.dot(_samp[k, 2:], _samp[j, 2:]) / (np.hypot(*_samp[k, 2:]) * np.hypot(*_samp[j, 2:]) + 1e-9) < -0.7:
                    hits += 1; break
        if len(mine) and hits / len(mine) >= 0.6: meta['median'] = True
    p['meta'] = meta
# stop lines + crosswalks (drawn by roads.js): the ends of a town street where it meets a bigger road
_RANK = {'motorway': 5, 'trunk': 5, 'primary': 4, 'secondary': 4, 'tertiary': 3, 'unclassified': 2,
         'residential': 1, 'living_street': 1}
_rank = lambda c: _RANK.get(c.split(':')[0], 0.5 if c.startswith('service') else 0)
_at = defaultdict(list)
for i, p in enumerate(paths): _at[p['a']].append(i); _at[p['b']].append(i)
for i, p in enumerate(paths):
    m = p['meta']; c = m['cls']
    town = 'sidewalk' in m or c.split(':')[0] in ('residential', 'living_street', 'service')
    if not town or 'flat' in m or c == 'trail' or c == 'service': continue      # campus drives / stubs: no paint
    for end, node in (('stopA', p['a']), ('stopB', p['b'])):
        if len(_at[node]) >= 3 and any(_rank(paths[o]['meta']['cls']) > _rank(c) for o in _at[node] if o != i):
            p[end] = True
_cc = Counter(p['meta']['cls'] for p in paths)
log('road classes:', dict(_cc.most_common()))
log('stop lines at', sum(p.get('stopA', False) + p.get('stopB', False) for p in paths), 'street ends')
log('flat paving:', sum('flat' in p['meta'] for p in paths), '· median (split carriageway):',
    sum('median' in p['meta'] for p in paths), '· with sidewalk tag:', sum('sidewalk' in p['meta'] for p in paths))

# ---------------------------------------------------------------- 5. global heights (4 m), smoothed, carved
gh = np.full((GHH, GHW), np.nan, np.float32)
for tx, tz in TILES:
    d = np.load(os.path.join(RAW, 'tiles', f'{tx}_{tz}', 'dem.npy'))
    m = int(MARGIN / HSTEP); core = d[m:m + HN, m:m + HN]
    j0 = int(round((tx * TILE - TILE / 2 - GX0) / HSTEP)); i0 = int(round((tz * TILE - TILE / 2 - GZ0) / HSTEP))
    gh[i0:i0 + HN, j0:j0 + HN] = core
if np.isnan(gh).any():                      # tiles not downloaded (yet): fill with the nearest known height
    idx = ndimage.distance_transform_edt(np.isnan(gh), return_distances=False, return_indices=True)
    gh = gh[tuple(idx)]
gh = ndimage.gaussian_filter(gh, 0.7)
# smooth a little under every strip so cars don't catch air on 1-2 m lidar lumps
_pimg = Image.new('L', (GHW, GHH), 0); _pd = ImageDraw.Draw(_pimg)
for p in paths:
    tp = [((x - GX0) / HSTEP, (z - GZ0) / HSTEP) for x, z in p['pts']]
    _pd.line(tp, fill=255, width=max(2, int(round(p['w'] / HSTEP))), joint='curve')
on_path = np.asarray(_pimg).astype(np.float32) / 255
wgt = np.clip(ndimage.gaussian_filter(on_path, 1.2) * 2.0, 0, 1)
gh = gh * (1 - wgt) + ndimage.gaussian_filter(gh, 2.6) * wgt
# ponds: water level from the flat part of the lidar inside each water body; gentle bowl; shore kept dry
hwater = np.asarray(Image.fromarray(gwater.astype(np.uint8) * 255).resize((GHW, GHH), Image.BILINEAR)) > 100
outline = ndimage.binary_dilation(hwater, iterations=2)
ponds_g = []                                         # (level, mask) on the global height grid
pond_gid = np.zeros((GHH, GHW), np.int32)
lab0, n0 = ndimage.label(outline)
for i, sl in enumerate(ndimage.find_objects(lab0), 1):
    sl = (slice(max(0, sl[0].start - 3), sl[0].stop + 3), slice(max(0, sl[1].start - 3), sl[1].stop + 3))
    m = lab0[sl] == i
    if m.sum() < 3: continue
    core = ndimage.binary_erosion(m, iterations=2)
    sub = gh[sl]
    level = float(np.percentile(sub[core if core.sum() > 3 else m], 10)) + 0.05
    wet = ndimage.binary_erosion(m, iterations=2) & (sub < level + 1.5)
    wl, wn = ndimage.label(wet)
    if wn == 0: continue
    wet = wl == 1 + int(np.argmax(ndimage.sum(wet, wl, range(1, wn + 1))))
    if wet.sum() < 3: continue
    dist = ndimage.distance_transform_edt(wet)
    sub[wet] = np.minimum(sub[wet], level - np.minimum(1.6, 0.15 + dist[wet] * 0.3))
    sq = np.ones((3, 3), bool)
    rim = ndimage.binary_dilation(wet, structure=sq, iterations=2) & ~wet
    sub[rim] = np.maximum(sub[rim], level + 0.18)
    pid = len(ponds_g) + 1
    pond_gid[sl][ndimage.binary_dilation(wet, structure=sq, iterations=1)] = pid
    ponds_g.append({'level': round(level, 3), 'wet': (sl, wet)})
log('ponds', len(ponds_g))

# road heights: junction planes + smooth profiles; then carve the ground under every road
_hfun = lambda g: (lambda x, z: ndimage.map_coordinates(g, [(np.atleast_1d(z) - GZ0) / HSTEP, (np.atleast_1d(x) - GX0) / HSTEP], order=1, mode='nearest'))
_ghs = ndimage.gaussian_filter(gh, 2.0)
_gz, _gx = np.gradient(_ghs, HSTEP)
J = roadnet.junction_layout(nodes, edges)
planes, plane_y = roadnet.profiles(nodes, edges, J, _hfun(gh), lambda x, z: float(_hfun(_ghs)(x, z)[0]),
                                   lambda x, z: (float(_hfun(_gx)(x, z)[0]), float(_hfun(_gz)(x, z)[0])))
log('roads matched to an overlapping bigger road:', roadnet.harmonize(edges, J))
juncs = roadnet.junction_rings(J, edges, planes, plane_y)
# pond beds are never carved; the 1-cell rim around them can be, as long as it stays above that pond's water
_lv = np.array([-np.inf] + [p['level'] for p in ponds_g], np.float32)
_protect = ndimage.maximum_filter(_lv[pond_gid], size=3) + 0.15
_protect[pond_gid > 0] = np.inf
nv, mx = roadnet.carve(gh, GX0, GZ0, HSTEP, edges, juncs, _protect)
log(f'roads carved: {nv} height vertices moved (max {mx:.1f} m), junction pieces {len(juncs)}')
del _ghs, _gx, _gz

# ---------------------------------------------------------------- 6. per tile
REF = np.array([(92, 112, 62), (112, 116, 76), (168, 150, 104), (112, 94, 74)], np.float32)
OPEN = np.array([(118, 172, 70), (146, 166, 82), (212, 186, 112), (156, 116, 80)], np.float32)
SURF_COL = {1: (64, 96, 50), 5: (104, 92, 66), 6: (196, 196, 190), 7: (200, 86, 66)}
LAWN, LOT = np.array((124, 166, 74), np.float32), np.array((148, 149, 145), np.float32)   # town lawns / paved lots
TOWN_DENSITY = 0.06                   # share of ground under buildings (smoothed over ~60 m) that counts as town
TEXN = 2048


def clip_polyline(pts, rect):
    """Pieces of a polyline inside rect (Liang-Barsky per segment, joined)."""
    x0, z0, x1, z1 = rect; pieces, cur = [], []
    for a, b in zip(pts[:-1], pts[1:]):
        d = b - a; t0, t1 = 0.0, 1.0; ok = True
        for p, q in ((-d[0], a[0] - x0), (d[0], x1 - a[0]), (-d[1], a[1] - z0), (d[1], z1 - a[1])):
            if p == 0:
                if q < 0: ok = False; break
            else:
                t = q / p
                if p < 0: t0 = max(t0, t)
                else: t1 = min(t1, t)
        if not ok or t0 > t1:
            if cur: pieces.append(cur); cur = []
            continue
        pa, pb = a + d * t0, a + d * t1
        if not cur: cur = [pa]
        elif np.hypot(*(cur[-1] - pa)[:2]) > 1e-6: pieces.append(cur); cur = [pa]
        cur.append(pb)
        if t1 < 1.0: pieces.append(cur); cur = []
    if cur: pieces.append(cur)
    return [np.array(p) for p in pieces if len(p) >= 2]


world_tiles = []
for tx, tz in TILES:
    t1 = time.time()
    rx0, rz0, rx1, rz1 = tile_rect(tx, tz)
    out = os.path.join(OUT, f'{tx}_{tz}'); os.makedirs(out, exist_ok=True)
    src = os.path.join(RAW, 'tiles', f'{tx}_{tz}')
    sat = np.asarray(Image.open(os.path.join(src, 'naip.jpg')).convert('RGB')).astype(np.float32)
    chm = np.load(os.path.join(src, 'chm.npy'))
    lum = sat.mean(2)
    # tree cover (same rules as campus): >= 5 m tall, drop single shrubs; lighter canopy = broadleaf
    tree = ndimage.binary_opening(ndimage.uniform_filter(chm, 3) >= 5.0, iterations=1)
    lab, n = ndimage.label(tree)
    if n: tree = np.isin(lab, 1 + np.nonzero(ndimage.sum(tree, lab, range(1, n + 1)) >= 6)[0])
    broad = tree & (ndimage.uniform_filter(lum, 5) > 62)
    M = MARGIN; core = np.s_[M:M + TILE, M:M + TILE]
    # rasters for this tile (1 m, core only, plus the margin for distances)
    def raster(draw):
        im = Image.new('L', (SAT_N, SAT_N), 0); draw(ImageDraw.Draw(im)); return np.asarray(im) > 0
    to_px = lambda x, z: ((x - (rx0 - M)), (z - (rz0 - M)))
    path_m = raster(lambda d: [d.line([to_px(x, z) for x, z in p['pts']], fill=255, width=int(p['w']), joint='curve') for p in paths
                               if p['pts'][:, 0].max() > rx0 - M - 20 and p['pts'][:, 0].min() < rx1 + M + 20
                               and p['pts'][:, 1].max() > rz0 - M - 20 and p['pts'][:, 1].min() < rz1 + M + 20]
                    + [d.polygon([to_px(q[0], q[1]) for q in jn['ring']], fill=255) for jn in juncs
                       if rx0 - M - 60 < jn['c'][0] < rx1 + M + 60 and rz0 - M - 60 < jn['c'][1] < rz1 + M + 60])
    tb = [b for b in buildings if rx0 - M < b['pts'][:, 0].mean() < rx1 + M and rz0 - M < b['pts'][:, 1].mean() < rz1 + M]
    bld_m = raster(lambda d: [d.polygon([to_px(x, z) for x, z in b['pts']], fill=255) for b in tb if len(b['pts']) >= 3])
    gx0i, gz0i = int((rx0 - M - GX0) / WM), int((rz0 - M - GZ0) / WM)
    wsub = np.zeros((SAT_N // 2, SAT_N // 2), bool)
    a0, b0 = max(0, gz0i), max(0, gx0i); a1, b1 = min(GWH, gz0i + SAT_N // 2), min(GWW, gx0i + SAT_N // 2)
    if a1 > a0 and b1 > b0: wsub[a0 - gz0i:a1 - gz0i, b0 - gx0i:b1 - gx0i] = gwater[a0:a1, b0:b1]
    water_m = np.kron(wsub, np.ones((2, 2), bool))[:SAT_N, :SAT_N]
    # pond beds that really hold water (from the carved global grid), for painting mud
    hi0, hj0 = int(round((rz0 - GZ0) / HSTEP)), int(round((rx0 - GX0) / HSTEP))
    pid_core = pond_gid[hi0:hi0 + HN, hj0:hj0 + HN]
    wet_h = np.zeros((HN, HN), bool)
    for k, pnd in enumerate(ponds_g, 1):
        (sa, sb), wet = pnd['wet']
        ia0, ia1 = max(sa.start, hi0), min(sa.stop, hi0 + HN); ja0, ja1 = max(sb.start, hj0), min(sb.stop, hj0 + HN)
        if ia1 <= ia0 or ja1 <= ja0: continue
        wet_h[ia0 - hi0:ia1 - hi0, ja0 - hj0:ja1 - hj0] |= wet[ia0 - sa.start:ia1 - sa.start, ja0 - sb.start:ja1 - sb.start]
    wet_core = np.asarray(Image.fromarray(wet_h.astype(np.uint8) * 255).resize((TILE, TILE), Image.BILINEAR)) > 100

    # ---- surface classes (core, 1 m)
    surf = np.zeros((TILE, TILE), np.uint8)
    surf[tree[core]] = 1
    surf[wet_core] = 5
    surf[bld_m[core]] = 6
    yy, xx = np.mgrid[0:TILE, 0:TILE]
    ex = ((rx0 + xx + .5 - TRACK_C[0]) / 40) ** 2 + ((rz0 + yy + .5 - TRACK_C[1]) / 88) ** 2
    surf[(ex < 1.0) & (ex > 0.62) & (surf <= 1)] = 7
    del yy, xx, ex
    tilefmt.write_bytes(out, 'surface.bin', surf.tobytes(), PACK)

    # ---- ground colours (2048^2 over the core)
    big = np.asarray(Image.fromarray(sat.astype(np.uint8)).filter(ImageFilter.GaussianBlur(10))).astype(np.float32)[core]
    big = np.asarray(Image.fromarray(big.astype(np.uint8)).resize((TEXN, TEXN), Image.BILINEAR)).astype(np.float32)
    land = OPEN[((big[:, :, None, :] - REF[None, None]) ** 2).sum(-1).argmin(-1)]
    land = ndimage.median_filter(land, size=(9, 9, 1))
    s2 = np.asarray(Image.fromarray(surf).resize((TEXN, TEXN), Image.NEAREST))
    col = land
    # ---- towns: dry yellow lawns -> green, grey paved lots -> grey; OSM parks green and parking grey anywhere
    def lu_mask(polys):
        im = Image.new('L', (TEXN, TEXN), 0); d = ImageDraw.Draw(im); k = TEXN / TILE
        for q in polys:
            if q[:, 0].max() < rx0 or q[:, 0].min() > rx1 or q[:, 1].max() < rz0 or q[:, 1].min() > rz1: continue
            d.polygon([((x - rx0) * k, (z - rz0) * k) for x, z in q], fill=255)
        return np.asarray(im) > 0
    bd = ndimage.gaussian_filter(bld_m[core][::4, ::4].astype(np.float32), 15)             # 4 m cells, ~60 m
    town = np.asarray(Image.fromarray((bd > TOWN_DENSITY).astype(np.uint8) * 255).resize((TEXN, TEXN), Image.BILINEAR)) > 127
    lots = lu_mask(lu_lots)
    if town.any() or lots.any():
        sharp = np.asarray(Image.fromarray(sat.astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))).astype(np.float32)[core]
        sharp = np.asarray(Image.fromarray(sharp.astype(np.uint8)).resize((TEXN, TEXN), Image.BILINEAR)).astype(np.float32)
        mx, mn = sharp.max(2), sharp.min(2)
        paved = (mx - mn < 0.13 * mx) & (sharp.mean(2) > 105)
        paved = ndimage.binary_closing(ndimage.binary_opening(paved, iterations=4), iterations=2)      # no small specks
        col[town & (land == OPEN[2]).all(2)] = LAWN
        col[(town | lots) & paved] = LOT
        del sharp, mx, mn, paved
    col[lu_mask(lu_green)] = LAWN
    col[lu_mask(lu_grey)] = LOT
    for c, rgb in SURF_COL.items(): col[s2 == c] = np.array(rgb, np.float32)
    tone = ndimage.gaussian_filter(rng.standard_normal((TEXN // 8, TEXN // 8)).astype(np.float32), 4)
    col *= 1 + ndimage.zoom(tone / (tone.std() + 1e-6), 8, order=1)[:TEXN, :TEXN, None] * 0.05
    tilefmt.write_ground(out, Image.fromarray(np.clip(col, 0, 255).astype(np.uint8)), PACK)

    # ---- heights: core + margin from the global grid
    hz0, hx0 = hi0 - HM, hj0 - HM
    hpad = np.pad(gh, HM, mode='edge')[hz0 + HM:hz0 + HM + HN + 2 * HM, hx0 + HM:hx0 + HM + HN + 2 * HM]
    tilefmt.write_bytes(out, 'height.bin', hpad.astype('<f4').tobytes(), PACK)
    pid_pad = np.pad(pond_gid, HM)[hz0 + HM:hz0 + HM + HN + 2 * HM, hx0 + HM:hx0 + HM + HN + 2 * HM]

    # ---- trees (7 m jittered grid, core only)
    SP = 7.0
    gx, gz = np.meshgrid(np.arange(rx0 + SP / 2, rx1, SP), np.arange(rz0 + SP / 2, rz1, SP))
    gx = gx.ravel() + rng.uniform(-SP * .45, SP * .45, gx.size); gz = gz.ravel() + rng.uniform(-SP * .45, SP * .45, gz.size)
    gx = np.clip(gx, rx0 + 0.01, rx1 - 0.01); gz = np.clip(gz, rz0 + 0.01, rz1 - 0.01)
    px = np.clip((gx - (rx0 - M)).astype(int), 0, SAT_N - 1); pz = np.clip((gz - (rz0 - M)).astype(int), 0, SAT_N - 1)
    path_d = ndimage.distance_transform_edt(~path_m); bld_d = ndimage.distance_transform_edt(~bld_m)
    keep = tree[pz, px] & (path_d[pz, px] > 1.2) & (bld_d[pz, px] > 4) & ~water_m[pz, px]
    edge = ndimage.binary_dilation(tree, iterations=3) & ~tree
    keep |= edge[pz, px] & (rng.random(gx.size) < 0.12) & (path_d[pz, px] > 3) & (bld_d[pz, px] > 6) & ~water_m[pz, px]
    hgt = np.clip(ndimage.maximum_filter(chm, 3)[pz, px] * rng.uniform(0.85, 1.1, gx.size), 6, 48)
    T = np.stack([gx, gz, hgt, broad[pz, px].astype(np.float32)], 1)[keep].astype('<f4')
    tilefmt.write_bytes(out, 'trees.bin', T.tobytes(), PACK)

    # ---- strips: exact pieces for drawing, padded pieces for physics (a strip's width can reach over the edge)
    render, phys = [], []
    piece = lambda p, pc: {'kind': p['kind'], 'w': p['w'], **p['meta'], 'pts': np.round(pc[:, :2], 2).tolist(),
                           'yc': [[round(float(y), 3), round(float(c), 4)] for y, c in pc[:, 2:4]]}
    for p in paths:
        o = p['out']
        if roadnet.arclen(o)[-1] < 0.5: continue                     # fully swallowed by its junctions
        if o[:, 0].max() < rx0 - 60 or o[:, 0].min() > rx1 + 60 or o[:, 1].max() < rz0 - 60 or o[:, 1].min() > rz1 + 60: continue
        for pc in clip_polyline(o, tile_rect(tx, tz)):
            q = piece(p, pc)                                     # stop line at an end that is the road's real end
            st = [bool(p.get('stopA')) and np.allclose(pc[0, :2], o[0, :2]), bool(p.get('stopB')) and np.allclose(pc[-1, :2], o[-1, :2])]
            if any(st): q['stop'] = st
            render.append(q)
        for pc in clip_polyline(o, tile_rect(tx, tz, pad=p['w'])): phys.append(piece(p, pc))
    pr = tile_rect(tx, tz, pad=40)
    tj = [jn for jn in juncs if rx0 <= jn['c'][0] < rx1 and rz0 <= jn['c'][1] < rz1]
    pj = [jn for jn in juncs if any(pr[0] <= q[0] <= pr[2] and pr[1] <= q[1] <= pr[3] for q in jn['ring'])]
    # ---- ponds touching this tile
    tponds = {}
    for k in np.unique(pid_pad[pid_pad > 0]):
        tponds[int(k)] = ponds_g[k - 1]['level']
    tilefmt.write_bytes(out, 'tile.json', json.dumps({'tx': tx, 'tz': tz, 'buildings': [{'pts': np.round(b['pts'], 2).tolist(), 'h': b['h']} for b in tb
                                                   if rx0 <= b['pts'][:, 0].mean() < rx1 and rz0 <= b['pts'][:, 1].mean() < rz1],
               'paths': render, 'physPaths': phys, 'junctions': tj, 'physJunctions': pj, 'ponds': tponds}).encode(), PACK)
    tilefmt.write_bytes(out, 'ponds.bin', pid_pad.astype(np.uint16).tobytes(), PACK)
    world_tiles.append([tx, tz])
    log(f'tile {tx},{tz}: trees {len(T)}, buildings {len(tb)}, strips {len(render)}, ponds {len(tponds)} ({time.time() - t1:.0f}s)')

# ---------------------------------------------------------------- 7. world.json
json.dump({'tile': TILE, 'hstep': HSTEP, 'hn': HN, 'hm': HM, 'surfN': TILE, 'tiles': world_tiles,
           'extent': [GX0, GZ0, GX1, GZ1], 'spawn': SPAWN_OLD.round(2).tolist(),
           'ponds': [p['level'] for p in ponds_g], **({'packed': tilefmt.PACKED} if PACK else {})},
          open(os.path.join(ASSETS, 'world.json'), 'w'), indent=1)
log('done')
