"""Rivers and streams (OSM waterway lines) as water, for build_tiles.py.

OSM draws rivers here only as centre lines (waterway=river / stream / canal), so each line gets a width (OSM `width`,
else a default per name / kind). The water is a run of flat pools stepping down the river: the lowest ground across
the bed is sampled every 2 m along the line, narrow pits (< CLOSE_M) are ignored, and the level is the running minimum
from the source (OSM draws rivers in the flow direction; a line whose start is clearly lower is turned round), so the
water only ever runs downhill and is never above the lowest ground across the bed: no water floats over a culvert
embankment or a bump in the lidar. Where that level would be more than MAX_CUT below the ground (a road embankment
over a culvert, an OSM line drawn beside its channel) the stream is left dry rather than cut into a canyon. A new
pool starts every STEP_DROP metres of fall (or every POOL_LEN metres). Each pool is a "pond" to the game: an id in
ponds.bin and a level (tile.json `rivers`), so the game's water code works unchanged.

On the global height grid (after the ponds, before the roads are carved):
  bed     vertices within the river's half-width are lowered below that pool's level (a shallow bowl)
  banks   the two vertex rings just outside are raised to 0.15 m above the highest water within two cells
  ids     the bed plus one ring get the pool id (the game draws a water quad on any cell touching an id)
Each vertex belongs to the river whose edge is nearest (so a creek can't raise a bank inside the river it joins).
Roads crossing a stream are carved afterwards and fill it back in (a culvert). Intermittent / seasonal streams,
culverts and tunnels are left out, and so is water inside a pond (the pond's water rules there).
"""
import math
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
from PIL import Image, ImageDraw

WIDTH = {'river': 16.0, 'canal': 6.0, 'stream': 4.0}             # metres, when OSM has no `width`
NAMED = {'South Yamhill River': 30.0, 'Yamhill River': 40.0, 'North Yamhill River': 22.0, 'Willamina Creek': 9.0,
         'Mill Creek': 7.0, 'Salt Creek': 7.0, 'Deer Creek': 6.0, 'Baker Creek': 6.0}
DEPTH = {'river': 1.8, 'canal': 1.0, 'stream': 0.6}             # deepest point below the water
MAX_CUT = {'river': 3.0, 'canal': 1.5, 'stream': 1.5}           # water further below the ground than this: left dry
STEP_DROP, POOL_LEN, SAMPLE, CLOSE_M = 0.4, 300.0, 2.0, 30.0


def from_osm(tags, pts):
    """A river dict for one OSM way, or None if it isn't flowing water we draw."""
    kind = tags.get('waterway')
    if kind not in WIDTH or tags.get('intermittent') == 'yes' or tags.get('seasonal') == 'yes' or tags.get('tunnel'):
        return None
    try: w = float(str(tags.get('width', '')).split()[0])
    except (ValueError, IndexError): w = 0.0
    w = w if 1.0 <= w <= 120 else NAMED.get(tags.get('name'), WIDTH[kind])
    return {'kind': kind, 'w': w, 'pts': np.asarray(pts, float), 'name': tags.get('name') or kind}


def _arclen(p): return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(p, axis=0).T))])


def _near_max(vi, vj, val, qi, qj, Wd, r=2):
    """Per query vertex (qi, qj): the largest val of the vertices (vi, vj) within r cells (-inf if none)."""
    lin = vi.astype(np.int64) * Wd + vj; o = np.argsort(lin); lin, val = lin[o], val[o]
    best = np.full(len(qi), -np.inf)
    for di in range(-r, r + 1):
        for dj in range(-r, r + 1):
            jj = qj + dj; t = (qi + di).astype(np.int64) * Wd + jj
            k = np.minimum(np.searchsorted(lin, t), len(lin) - 1)
            hit = (lin[k] == t) & (jj >= 0) & (jj < Wd)
            best = np.where(hit, np.maximum(best, val[k]), best)
    return best


def build(gh, gx0, gz0, hstep, rivers, pond_gid, pond_lv, first_id, log=print):
    """Carves the rivers into gh and writes their pool ids into pond_gid (where there is no pond).
    pond_lv[id] = water level of pond id. Returns (levels, wet): levels[k] is the water level of id first_id + k;
    wet = bool grid of river beds."""
    H, Wd = gh.shape
    hfun = lambda x, z: ndimage.map_coordinates(gh, [(z - gz0) / hstep, (x - gx0) / hstep], order=1, mode='nearest')
    lines, levels, n_dry, flipped = [], [], 0, []
    for r in rivers:
        pts = r['pts']; cum = _arclen(pts); L = cum[-1]
        if L < 10: continue
        s = np.linspace(0, L, int(L / SAMPLE) + 2)
        q = np.column_stack([np.interp(s, cum, pts[:, 0]), np.interp(s, cum, pts[:, 1])])
        tg = np.gradient(q, axis=0); tg /= np.maximum(np.hypot(*tg.T), 1e-9)[:, None]
        hw = r['w'] / 2
        offs = np.arange(-(hw + 4), hw + 4.01, SAMPLE)
        low = hfun(q[:, 0, None] + tg[:, 1, None] * offs, q[:, 1, None] - tg[:, 0, None] * offs).min(1)
        gi = ((q[:, 1] - gz0) / hstep).round().astype(int); gj = ((q[:, 0] - gx0) / hstep).round().astype(int)
        out = (gi < 0) | (gi >= H) | (gj < 0) | (gj >= Wd)                # off the grid (lines run past the map edge)
        if out.all(): continue
        pond = pond_gid[np.clip(gi, 0, H - 1), np.clip(gj, 0, Wd - 1)]
        low = np.where(pond > 0, pond_lv[pond], low)                    # through a pond: its water, not its carved bed
        low[out] = np.inf                                               # unknown: no say in the level, left dry
        ins = low[~out]; n = max(1, len(ins) // 10)
        if np.median(ins[:n]) < np.median(ins[-n:]) - 2.0:              # clearly drawn against the flow: turn it round
            q, low, pond, out = q[::-1], low[::-1], pond[::-1], out[::-1]; flipped.append(r['name'])
        lv = np.minimum.accumulate(ndimage.grey_closing(low, size=max(1, int(CLOSE_M / SAMPLE)), mode='nearest'))
        with np.errstate(invalid='ignore'):                             # inf - inf off the grid
            dry = out | (pond > 0) | ~np.isfinite(lv) | (low - lv > MAX_CUT[r['kind']])
        n_dry += int(dry.sum())
        if dry.all(): continue
        lv = np.where(np.isfinite(lv), lv, lv[~dry][0])                  # (the start, if it is off the grid)
        # pools: a new one every STEP_DROP of fall or POOL_LEN of length (both only grow along the river)
        key = np.floor((lv[0] - lv) / STEP_DROP).astype(np.int64) * 100000 + np.floor(s / POOL_LEN).astype(np.int64)
        run = np.cumsum(np.r_[True, np.diff(key) != 0]) - 1
        used = np.unique(run[~dry])
        idx = np.full(run[-1] + 1, -1); idx[used] = np.arange(len(used))
        pid = np.where(dry, 0, first_id + len(levels) + idx[run])
        levels += [round(float(lv[(run == u) & ~dry].mean()), 3) for u in used]
        lines.append((q, hw, pid, DEPTH[r['kind']]))
    if not lines: return [], np.zeros_like(gh, bool)
    log(f'rivers: {len(rivers)} lines, {sum(len(l[0]) for l in lines)} samples '
        f'({n_dry} dry), {len(levels)} pools (ids {first_id}..{first_id + len(levels) - 1})')
    if flipped: log(f'rivers: {len(flipped)} drawn uphill in OSM, turned round:', ', '.join(sorted(set(flipped))[:12]))
    assert first_id + len(levels) < 65535, 'too many river pools for uint16 ponds.bin: raise STEP_DROP / POOL_LEN'
    LV = np.array([0.0] + levels)                                       # by id - first_id + 1 (0 = dry)
    # candidate vertices: each river line drawn on the grid, wide enough for bed + banks
    img = Image.new('L', (Wd, H), 0); d = ImageDraw.Draw(img)
    for q, hw, _, _ in lines:
        d.line([((x - gx0) / hstep, (z - gz0) / hstep) for x, z in q], fill=255,
               width=int(math.ceil((max(hw, 0.75 * hstep) * 2 + 6 * hstep) / hstep)))
    vi, vj = np.nonzero(np.asarray(img) > 0); del img
    vx, vz = gx0 + vj * hstep, gz0 + vi * hstep
    # nearest river edge: e = distance to the line - its half-width (one tree per width, so a wide river wins)
    e = np.full(len(vi), np.inf); pid = np.zeros(len(vi), np.int64); dep = np.zeros(len(vi))
    hws = np.array([max(l[1], 0.75 * hstep) for l in lines])
    for hw in np.unique(hws):
        sel = [l for l, h in zip(lines, hws) if h == hw]
        P = np.vstack([l[0] for l in sel]); PID = np.concatenate([l[2] for l in sel])
        DEP = np.concatenate([np.full(len(l[0]), l[3]) for l in sel])
        dist, k = cKDTree(P).query(np.column_stack([vx, vz]), workers=-1)
        better = dist - hw < e
        e = np.where(better, dist - hw, e); pid = np.where(better, PID[k], pid); dep = np.where(better, DEP[k], dep)
    lvl = LV[np.where(pid > 0, pid - first_id + 1, 0)]
    free = (pond_gid[vi, vj] == 0) & (pid > 0)
    wet = free & (e <= 0)
    ids = free & (e <= 1.05 * hstep)                                     # bed + one ring
    rim = free & ~wet & (e <= 2.05 * hstep)
    bed = lvl - np.minimum(dep, 0.25 + np.maximum(-e, 0) * 0.3)
    gh[vi[wet], vj[wet]] = np.minimum(gh[vi[wet], vj[wet]], bed[wet])
    top = _near_max(vi[ids], vj[ids], lvl[ids], vi[rim], vj[rim], Wd) + 0.15     # highest water nearby (pool steps)
    gh[vi[rim], vj[rim]] = np.maximum(gh[vi[rim], vj[rim]], np.where(np.isfinite(top), top, lvl[rim] + 0.15))
    pond_gid[vi[ids], vj[ids]] = pid[ids]
    # any other vertex next to river water (where a stretch runs dry, at the grid edge, beside a pond) stays above it
    # too: the game draws the water up to it at the highest level next to it
    nb = pond_gid[vi, vj] == 0
    top = _near_max(vi[ids], vj[ids], lvl[ids], vi[nb], vj[nb], Wd, r=1) + 0.15
    gh[vi[nb], vj[nb]] = np.maximum(gh[vi[nb], vj[nb]], top)
    wet_g = np.zeros_like(gh, bool); wet_g[vi[wet], vj[wet]] = True
    log(f'rivers: bed vertices {int(wet.sum())}, banks raised {int(rim.sum())}')
    return levels, wet_g
