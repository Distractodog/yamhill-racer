"""Plans the timed challenges along the real road / trail network and writes game/assets/challenges.json.

Reads only the built tiles (game/assets/tiles/*/tile.json): every road/trail strip is a chain of points; strips that
end at the same spot (tile cuts) or at the same junction piece are joined. A shortest-path search (weighted by how
well each surface suits the challenge) goes through each challenge's waypoints. Checkpoints are dropped along the
route every `gap` metres. Run after rebuilding the tiles:  .venv/bin/python tools/challenge_routes.py
"""
import json, math, os, sys, heapq, glob
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tilefmt
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
DIRT = {'trail': 1.0, 'gravel': 1.1, 'asphalt': 4.0}      # dirt bike: trails + gravel, keep off the tarmac
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
    # dirt bike: campus trails + gravel roads, jumps every few hundred metres
    dict(id='bike-south-loop', vehicle='bike', name='South woods loop', desc='Round the trail loop south of campus, with jumps.',
         via=[(-860, 440), (-760, 820), (-150, 640), (-110, 520), (-180, 400), (-310, 330)], cost=DIRT, gap=200,
         ramp_every=350, run=45, bend=0.5, gate_clear=30),
    dict(id='bike-north-scramble', vehicle='bike', name='North woods scramble', desc='Campus up through the north trails to the far ridge, jumps all the way.',
         via=[(-600, 40), (-1140, -380), (-1000, -820), (-560, -1000), (-260, -760)], cost=DIRT, gap=220,
         ramp_every=330, run=45, bend=0.5, gate_clear=30),
    dict(id='bike-gravel-run', vehicle='bike', name='Gravel run', desc='Campus out along the gravel roads to the northeast fields.',
         via=[(-200, -60), (250, -280), (720, -1240), (1300, -1240)], cost={'gravel': 1.0, 'trail': 1.1, 'asphalt': 3.0}, gap=300,
         ramp_every=450, run=70, bend=0.4, gate_clear=40),
]

# ---------------------------------------------------------------- graph
pts, kinds, widths, ys = [], [], [], []  # node coords; per-node kind/width of its strip; road height
adj = {}
def add_node(x, z, kind, w, y=0.0):
    pts.append((x, z)); kinds.append(kind); widths.append(w); ys.append(y); adj[len(pts) - 1] = []; return len(pts) - 1
def link(a, b, kind):
    L = math.dist(pts[a], pts[b]); adj[a].append((b, L, kind)); adj[b].append((a, L, kind))

ends, juncs = [], []
for f in sorted(glob.glob(os.path.join(ROOT, 'game', 'assets', 'tiles', '*'))):
    if not os.path.isdir(f): continue
    t = tilefmt.read_json(f)                     # packed (tile.json.gz) or plain tile.json
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

_trees = {}
def trees_near(x, z, r):
    """Tree trunks (x, z) within r of a point, from the built tiles' trees.bin."""
    out, T2 = [], 2000.0                       # tile size (world.json 'tile')
    for tx in range(math.floor((x - r + T2 / 2) / T2), math.floor((x + r + T2 / 2) / T2) + 1):
        for tz in range(math.floor((z - r + T2 / 2) / T2), math.floor((z + r + T2 / 2) / T2) + 1):
            if (tx, tz) not in _trees:
                d = os.path.join(ROOT, 'game', 'assets', 'tiles', f'{tx}_{tz}')
                _trees[(tx, tz)] = np.frombuffer(tilefmt.read_bytes(d, 'trees.bin'), '<f4').reshape(-1, 4)[:, :2] if os.path.isdir(d) else np.zeros((0, 2))
            T = _trees[(tx, tz)]
            if len(T): out.extend(T[np.hypot(T[:, 0] - x, T[:, 1] - z) < r])
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
        if hw > fw[j] / 2:                   # opened out at a junction: stay 1.8 m short of trees in the gap between
            for tx_, tz_ in trees_near(F[j][0], F[j][1], hw + 2.5):   # the roads (they're only kept clear of strips)
                hw = max(float(fw[j]) / 2, min(hw, float(np.hypot(tx_ - F[j][0], tz_ - F[j][1])) - 1.8))
        return hw
    # U-turns at an acute fork (> 100 degrees within ~20 m): the inside of the turn is open, or the corridors of the
    # two legs leave a walled-off V that a car cutting the corner gets pinned in
    _hd = np.arctan2(np.gradient(F[:, 0]), np.gradient(F[:, 1]))
    def turn_at(j, k=10):
        a, b = max(0, j - k), min(len(F) - 1, j + k)
        return abs((_hd[b] - _hd[a] + np.pi) % (2 * np.pi) - np.pi)
    _hw0 = half_width
    def half_width(j):
        return max(_hw0(j), 11.0) if turn_at(j) > math.radians(100) else _hw0(j)
    track = [[round(float(F[j][0]), 2), round(float(F[j][1]), 2), round(half_width(j), 2)]
             for j in list(range(0, len(F), 2)) + [len(F) - 1]]
    simple = resample(line, 8.0)
    result.append(dict(id=c['id'], vehicle=c.get('vehicle', 'car'), name=c['name'], desc=c['desc'], length=round(length),
                       start=dict(x=start['x'], z=start['z'], yaw=start['yaw']), gates=gates, ramps=ramps, track=track,
                       route=[[round(x, 1), round(z, 1)] for x, z in simple]))
    surf = {}
    for a, b in zip(nodes, nodes[1:]): surf[kinds[b]] = surf.get(kinds[b], 0) + math.dist(pts[a], pts[b])
    print(f"{c['name']}: {length:.0f} m, {len(gates) - 1} gates after the start, {len(ramps)} ramps at",
          [(r['s'], f"dip {r['dip']} m over {r['span']} m") if 'dip' in r else r['s'] for r in ramps], 'surfaces',
          {k: round(v) for k, v in surf.items()})

# ---------------------------------------------------------------- jet races: rings in the air
# Each course starts on a long straight road (take-off run), then flies through rings at set heights above the ground.
# Ring height = the highest ground within 150 m + the course's clearance (trees are up to ~40 m), so you can always
# fly through without hitting a hill. Rings face along the course (from the previous ring to the next one).
WJ = json.load(open(os.path.join(ROOT, 'game', 'assets', 'world.json')))
HN = WJ['hn'] + 2 * WJ['hm']; HS = WJ['hstep']; TT = WJ['tile']
_h = {}
def tile_h(tx, tz):
    k = (tx, tz)
    if k not in _h:
        f = os.path.join(ROOT, 'game', 'assets', 'tiles', f'{tx}_{tz}')
        _h[k] = np.frombuffer(tilefmt.read_bytes(f, 'height.bin'), np.float32).reshape(HN, HN) if os.path.isdir(f) else None
    return _h[k]
def ground(x, z):
    tx, tz = math.floor((x + TT / 2) / TT), math.floor((z + TT / 2) / TT)
    H = tile_h(tx, tz)
    if H is None: return 0.0
    gx0, gz0 = tx * TT - TT / 2 - WJ['hm'] * HS, tz * TT - TT / 2 - WJ['hm'] * HS
    j = int(np.clip(round((x - gx0) / HS), 0, HN - 1)); i = int(np.clip(round((z - gz0) / HS), 0, HN - 1))
    return float(H[i, j])
def ground_max(x, z, r=150):
    return max(ground(x + dx, z + dz) for dx in range(-r, r + 1, 30) for dz in range(-r, r + 1, 30))

HWY_RAMP = json.load(open(os.path.join(ROOT, 'game', 'assets', 'ramps.json')))[0]
AIR = [
    dict(id='jet-hwy18-sortie', name='Hwy 18 sortie', desc='Take off on Hwy 18 and race the rings southwest over Sheridan to campus.',
         start=(HWY_RAMP['x'] - math.sin(HWY_RAMP['yaw']) * 2600, HWY_RAMP['z'] - math.cos(HWY_RAMP['yaw']) * 2600, HWY_RAMP['yaw']),
         rings=[(HWY_RAMP['x'] - math.sin(HWY_RAMP['yaw']) * 600, HWY_RAMP['z'] - math.cos(HWY_RAMP['yaw']) * 600, 50),
                (11500, -2400, 110), (9800, -400, 80), (7000, 800, 140), (3900, 1300, 70), (2000, 1000, 120),
                (300, 600, 90), (-560, 380, 60)], r=45),
    # a smooth oval round the valley (rings every 30°, so every turn is gentle), clockwise on the map from the road
    # east of campus, out past Willamina and back
    dict(id='jet-valley-loop', name='Valley loop', desc='Off the long road east of campus, a big loop round the valley past Willamina.',
         start=(1056, 1700, 3.1336),
         rings=[(-1300 + 2600 * math.cos(math.radians(t)), 800 - 2400 * math.sin(math.radians(t)), c)
                for t, c in zip(range(30, 390, 30), [120, 160, 110, 140, 90, 150, 100, 130, 80, 120, 90, 60])], r=45),
]
for a in AIR:
    sx, sz, syaw = a['start']
    pts = [(sx, sz)] + [(x, z) for x, z, _ in a['rings']]
    # Keep every approach inside the real map, with room for a ring and the jet's wings.
    available = set(map(tuple, WJ['tiles']))
    for p, q in zip(pts, pts[1:]):
        n = max(1, math.ceil(math.dist(p, q) / 20))
        for i in range(n + 1):
            x = p[0] + (q[0] - p[0]) * i / n; z = p[1] + (q[1] - p[1]) * i / n
            for dx in (-100, 100):
                for dz in (-100, 100):
                    assert (math.floor((x + dx + TT / 2) / TT), math.floor((z + dz + TT / 2) / TT)) in available, f"{a['id']}: flight corridor outside map near {x:.0f}, {z:.0f}"
    gates = [dict(x=round(sx + math.sin(syaw) * 14, 2), z=round(sz + math.cos(syaw) * 14, 2), yaw=round(syaw, 4), w=34)]
    for k, (x, z, clr) in enumerate(a['rings']):
        px, pz = pts[k]; nx, nz = pts[k + 2] if k + 2 < len(pts) else (x + (x - px), z + (z - pz))
        yaw = math.atan2(x - px, z - pz)          # faces the way you come in from the previous ring
        y = ground_max(x, z) + clr
        gates.append(dict(x=round(x, 1), z=round(z, 1), y=round(y, 1), yaw=round(yaw, 4), r=a['r'], w=a['r'] * 2))
    length = sum(math.dist(p, q) for p, q in zip(pts, pts[1:]))
    route = []
    for p, q in zip(pts, pts[1:]):
        n = max(1, int(math.dist(p, q) // 200))
        route += [[round(p[0] + (q[0] - p[0]) * i / n, 1), round(p[1] + (q[1] - p[1]) * i / n, 1)] for i in range(n)]
    route.append([round(pts[-1][0], 1), round(pts[-1][1], 1)])
    result.append(dict(id=a['id'], vehicle='jet', name=a['name'], desc=a['desc'], length=round(length),
                       start=dict(x=round(sx, 2), z=round(sz, 2), yaw=round(syaw, 4)), gates=gates, ramps=[], route=route))
    print(f"{a['name']}: {length:.0f} m, {len(gates) - 1} rings, heights", [g['y'] for g in gates[1:]])

if os.environ.get("DRY"):
    if os.environ.get("DRY_OUT"): json.dump(result, open(os.environ["DRY_OUT"], "w"))
    sys.exit()
with open(os.path.join(ROOT, 'game', 'assets', 'challenges.json'), 'w') as f:
    json.dump(result, f, separators=(',', ':'))
