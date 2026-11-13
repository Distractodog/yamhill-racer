"""Plans the timed challenges along the real road / trail network and writes game/assets/challenges.json.

Reads only the built tiles (game/assets/tiles/*/tile.json): every road/trail strip is a chain of points; strips that
end at the same spot (tile cuts) or at the same junction piece are joined. A shortest-path search (weighted by how
well each surface suits the challenge) goes through each challenge's waypoints. Checkpoints are dropped along the
route every `gap` metres. Run after rebuilding the tiles:  .venv/bin/python tools/challenge_routes.py
"""
import json, math, os, sys, heapq, glob
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import align
from fetch_tiles import K

info = json.load(open(os.path.join(ROOT, 'data', 'raw', 'naip_info.json')))['extent']
OLD_SIZE = (info['xmax'] - info['xmin']) * K
def trailmap_to_world(px, py):            # pixel on Ethan's trail map → world metres
    sx, sy = align.map_to_sat(np.array([px]), np.array([py]))[0]
    return float((sx - 1024) * OLD_SIZE / 2048), float((sy - 1024) * OLD_SIZE / 2048)

MAIN_BUILDING = trailmap_to_world(700, 1440)      # drive just south of the Main Building
LONG_WALK_TOP = trailmap_to_world(850, 95)
SHERIDAN = (3800, 1400)
WILLAMINA = (-3640, 3330)

# cost per metre on each surface
ROAD = {'asphalt': 1.0, 'gravel': 1.6, 'trail': 8.0}
TRAIL = {'trail': 1.0, 'gravel': 1.3, 'asphalt': 2.0}
# jump ramps: one per `ramp_every` m of route, on straights at least `run` m long (room to fly and land)
class RAMP: up = 11; top = 2; down = 18          # same shape as RAMP in game/src/data.js
RAMP_LEN = RAMP.up + RAMP.top + RAMP.down
CHALLENGES = [
    dict(id='long-walk', name='Long Walk climb', desc='Main Building to the top of the Long Walk, on the trails.',
         via=[MAIN_BUILDING, LONG_WALK_TOP], cost=TRAIL, gap=180, ramp_every=800, run=60, bend=0.45, gate_clear=35),
    dict(id='sheridan', name='Sheridan sprint', desc='Campus to downtown Sheridan on the roads.',
         via=[MAIN_BUILDING, SHERIDAN], cost=ROAD, gap=450, ramp_every=1400, run=300, bend=0.3, gate_clear=70),
    dict(id='willamina', name='Willamina run', desc='Campus to downtown Willamina on the roads.',
         via=[MAIN_BUILDING, WILLAMINA], cost=ROAD, gap=450, ramp_every=1400, run=300, bend=0.3, gate_clear=70),
]

# ---------------------------------------------------------------- graph
pts, kinds, widths, ys = [], [], [], []  # node coords; per-node kind/width of its strip; road height
adj = {}
def add_node(x, z, kind, w, y=0.0):
    pts.append((x, z)); kinds.append(kind); widths.append(w); ys.append(y); adj[len(pts) - 1] = []; return len(pts) - 1
def link(a, b, kind):
    L = math.dist(pts[a], pts[b]); adj[a].append((b, L, kind)); adj[b].append((a, L, kind))

ends, juncs = [], []
for f in sorted(glob.glob(os.path.join(ROOT, 'game', 'assets', 'tiles', '*', 'tile.json'))):
    t = json.load(open(f))
    for p in t['paths']:
        if p['kind'] not in ROAD or len(p['pts']) < 2: continue
        prev = None
        for (x, z), (y, _) in zip(p['pts'], p['yc']):
            n = add_node(x, z, p['kind'], p['w'], y)
            if prev is not None: link(prev, n, p['kind'])
            prev = n
        ends += [(len(pts) - len(p['pts'])), len(pts) - 1]
    for j in t['junctions']:
        cx, cz = j['c'][:2]
        r = max(math.dist((cx, cz), q[:2]) for q in j['ring'])
        juncs.append((add_node(cx, cz, j['kind'], 10, j['c'][2]), r))

P = np.array(pts)
from scipy.spatial import cKDTree
tree = cKDTree(P)
jset = {n for n, _ in juncs}
strip_ids = np.array([i for i in range(len(pts)) if i not in jset])
stree = cKDTree(P[strip_ids])                              # strip points only (junction centres have no real width)
E = np.array(ends)
etree = cKDTree(P[E])
for i, j in etree.query_pairs(2.5):                       # strips cut at tile edges, or ending at the same point
    link(E[i], E[j], kinds[E[i]])
for n, r in juncs:                                        # strip ends that open onto a junction piece
    for i in etree.query_ball_point(pts[n], r + 3): link(n, E[i], kinds[n])
print('nodes', len(pts), 'strip ends', len(E), 'junctions', len(juncs))

def nearest(x, z, cost):
    best = None
    for d, i in zip(*tree.query((x, z), k=40)):
        if kinds[i] in cost and (best is None or d * cost[kinds[i]] < best[0]): best = (d * cost[kinds[i]], i)
    return best[1]

def route(a, b, cost):
    dist, prev, q = {a: 0}, {}, [(0, a)]
    while q:
        d, n = heapq.heappop(q)
        if n == b: break
        if d > dist[n]: continue
        for m, L, k in adj[n]:
            nd = d + L * cost[k]
            if nd < dist.get(m, 1e18): dist[m] = nd; prev[m] = n; heapq.heappush(q, (nd, m))
    if b not in prev: raise SystemExit(f'no route {pts[a]} -> {pts[b]}')
    out = [b]
    while out[-1] != a: out.append(prev[out[-1]])
    return out[::-1]

def resample(line, step):
    out, carry = [line[0]], 0.0
    for (ax, az), (bx, bz) in zip(line, line[1:]):
        L = math.hypot(bx - ax, bz - az); d = step - carry
        while d <= L: out.append((ax + (bx - ax) * d / L, az + (bz - az) * d / L)); d += step
        carry = L - (d - step)
    if math.dist(out[-1], line[-1]) > 1: out.append(line[-1])
    return out

result = []
for c in CHALLENGES:
    nodes = []
    for (ax, az), (bx, bz) in zip(c['via'], c['via'][1:]):
        r = route(nearest(ax, az, c['cost']), nearest(bx, bz, c['cost']), c['cost'])
        nodes += r if not nodes else r[1:]
    line = [pts[n] for n in nodes]
    line = [p for i, p in enumerate(line) if i == 0 or math.dist(p, line[i - 1]) > 0.3]
    fine = resample(line, 2.0)
    length = sum(math.dist(a, b) for a, b in zip(fine, fine[1:]))
    # gates: start (a bit along so the car starts behind it), checkpoints every ~gap m, finish at the end
    cum = np.concatenate([[0], np.cumsum([math.dist(a, b) for a, b in zip(fine, fine[1:])])])
    def at(s):
        i = int(np.clip(np.searchsorted(cum, s), 1, len(fine) - 1))
        (ax, az), (bx, bz) = fine[i - 1], fine[i]
        j0, j1 = max(0, i - 4), min(len(fine) - 1, i + 3)                # heading over ~14 m, smooths kinks
        hx, hz = fine[j1][0] - fine[j0][0], fine[j1][1] - fine[j0][1]
        w =widths[int(tree.query((bx, bz))[1])]
        return dict(x=round(bx, 2), z=round(bz, 2), yaw=round(math.atan2(hx, hz), 4), w=max(14, w + 6))
    n_cp = max(1, round((length - 20) / c['gap']))
    gates = [at(12)] + [at(12 + (length - 12) * k / n_cp) for k in range(1, n_cp)] + [at(length - 1)]
    start = at(0)
    gate_s = [12] + [12 + (length - 12) * k / n_cp for k in range(1, n_cp)] + [length - 1]

    # ---- ramps
    F = np.array(fine)
    _, near = tree.query(F)
    fy = np.array([ys[i] for i in near])
    fw = np.array([widths[strip_ids[i]] for i in stree.query(F)[1]])
    jpts = np.array([pts[n] for n, _ in juncs]); jtree = cKDTree(jpts)
    def ok(s0):
        i0, i1 = np.searchsorted(cum, [s0 - 30, s0 + c['run']])
        if i0 < 0 or i1 >= len(F): return None
        seg = F[i0:i1 + 1]; a, b = seg[0], seg[-1]; d = b - a; L = np.hypot(*d)
        off = np.abs((seg[:, 0] - a[0]) * d[1] - (seg[:, 1] - a[1]) * d[0]) / L      # bend away from a straight line
        w = fw[i0:i1 + 1].min()
        if off.max() > w * c['bend']: return None
        k = np.searchsorted(cum, s0)
        # the road ahead may climb, but well under the ramp's own ~20% kick, or you'd fly into the hill
        u = cum[k + 10:i1 + 1] - cum[k]
        rise = (fy[k + 10:i1 + 1] - fy[k] - 0.10 * u).max()
        if rise > 0.8: return None
        if min(abs(s0 - g) for g in gate_s) < c['gate_clear']: return None
        if jtree.query_ball_point(F[k:np.searchsorted(cum, s0 + RAMP_LEN + 15)], 22, return_length=True).max() > 0: return None
        return off.max() + max(0, rise) * 2                                             # lower = better
    n_r = max(1, round(length / c['ramp_every']))
    ramps = []
    for k in range(n_r):                      # best spot in each equal slice of the route (skipping its ends)
        lo, hi = 150 + (length - 400) * k / n_r, 150 + (length - 400) * (k + 1) / n_r
        cands = [(sc, s0) for s0 in np.arange(lo + 60, hi - 60, 5.0) if (sc := ok(s0)) is not None]
        if not cands: continue
        s0 = min(cands)[1]; g = at(s0)
        i = np.searchsorted(cum, s0)
        ramps.append(dict(x=g['x'], z=g['z'], yaw=g['yaw'], w=round(float(fw[i]) + 2, 1), s=round(float(s0))))
    # ---- jumps that help: a dip in the road (down >= 3 m and back up within 30-140 m, straight across). Flying over
    # it from a ramp at the lip beats driving down into it and back out. Kept clear of the other ramps.
    dips = []
    for s0 in np.arange(150, length - 250, 5.0):
        k = np.searchsorted(cum, s0 + RAMP.up)               # the lip
        y0 = fy[k]
        rim = None; low = 0
        for j in range(k + 1, len(F)):
            u = cum[j] - cum[k]
            if u > 160: break
            low = min(low, fy[j] - y0)
            if u >= 30 and fy[j] - y0 >= -0.5 and low <= -3: rim = (j, u); break
        if not rim or rim[1] > 140: continue
        i0, i1 = np.searchsorted(cum, s0 - 30), min(len(F) - 1, rim[0] + 15)
        seg = F[i0:i1 + 1]; a, b = seg[0], seg[-1]; d = b - a; L = np.hypot(*d)
        off = np.abs((seg[:, 0] - a[0]) * d[1] - (seg[:, 1] - a[1]) * d[0]) / L
        if off.max() > fw[i0:i1 + 1].min() * 0.5: continue           # flight stays inside the walls
        if min(abs(s0 - g) for g in gate_s) < c['gate_clear']: continue
        if jtree.query_ball_point(F[np.searchsorted(cum, s0):k + 8], 22, return_length=True).max() > 0: continue
        dips.append((low, s0, rim[1]))
    for low, s0, span in sorted(dips):                       # deepest dips first
        if any(abs(s0 - r['s']) < 250 for r in ramps): continue
        g = at(s0); i = np.searchsorted(cum, s0)
        ramps.append(dict(x=g['x'], z=g['z'], yaw=g['yaw'], w=round(float(fw[i]) + 2, 1), s=round(float(s0)),
                          dip=round(float(-low), 1), span=round(float(span))))
    ramps.sort(key=lambda r: r['s'])

    # ---- track edges for the invisible walls: centre line every 4 m with the half-width of the road there
    # at junctions the wall opens out to the whole junction piece (its ring radius), so hairpin turns have room
    jrad = np.minimum(np.array([r for _, r in juncs]), 14.0)     # ring radius can reach far down a road stub: cap it
    def half_width(j):
        hw = float(fw[j]) / 2
        for q in jtree.query_ball_point(F[j], jrad.max()):
            d = float(np.hypot(*(F[j] - jpts[q])))
            if d < jrad[q]: hw = max(hw, float(jrad[q]) - d * 0.5)
        return hw
    track = [[round(float(F[j][0]), 2), round(float(F[j][1]), 2), round(half_width(j), 2)]
             for j in list(range(0, len(F), 2)) + [len(F) - 1]]
    simple = resample(line, 8.0)
    result.append(dict(id=c['id'], name=c['name'], desc=c['desc'], length=round(length),
                       start=dict(x=start['x'], z=start['z'], yaw=start['yaw']), gates=gates, ramps=ramps, track=track,
                       route=[[round(x, 1), round(z, 1)] for x, z in simple]))
    surf = {}
    for a, b in zip(nodes, nodes[1:]): surf[kinds[b]] = surf.get(kinds[b], 0) + math.dist(pts[a], pts[b])
    print(f"{c['name']}: {length:.0f} m, {len(gates) - 1} gates after the start, {len(ramps)} ramps at",
          [(r['s'], f"dip {r['dip']} m over {r['span']} m") if 'dip' in r else r['s'] for r in ramps], 'surfaces',
          {k: round(v) for k, v in surf.items()})

if os.environ.get("DRY"): sys.exit()
with open(os.path.join(ROOT, 'game', 'assets', 'challenges.json'), 'w') as f:
    json.dump(result, f, separators=(',', ':'))
