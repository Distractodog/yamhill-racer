"""Road network: turns loose OSM ways + traced trails into a connected graph and builds what the game draws.

  build_graph      ways -> nodes (junctions / dead ends) + edges (polylines between nodes); ways that share a point
                   are split there, so every crossing that OSM marks becomes a junction
  snap_dead_ends   a dead end that stops just short of another road (trails were cut at road edges; OSM gaps)
                   is extended onto that road's centre line and becomes a junction
  merge_deg2       two edges meeting end to end with the same kind and width become one (no seam)
  contract_short   very short edges between junctions (median bits, double nodes) collapse into one junction
  junction_layout  per node: how far each road is trimmed back so the junction piece can take over
  profiles         per edge: a smooth height along the road (terrain smoothed along its length) that meets each
                   junction's tilted plane exactly; also a cross slope (only non-zero near junctions)
  junction_rings   per node: the junction polygon (road ends joined by curved fillets / end caps), with heights
  carve            moves the height grid under and beside every road to just below the road surface, then blends
                   back to the real ground, so terrain can never poke through a road

Bridges (edge attr 'bridge', from OSM bridge=*): the deck is a straight line between its abutments, at the highest
ground within 6 m of each end (the lidar is bare earth: under a bridge it shows the river / the road below); a bridge
OSM splits mid-span stays one straight deck (deck_heights). Decks are not nudged off water, not smoothed into the
ground and never carved under: under_bridges only lowers ground that pokes up into a deck, and carve never raises
ground under a deck (the river or the road below stays). harmonize never matches a bridge with a road on another
level, and a dead end of an ordinary road is never joined onto the middle of a bridge. A deck over another road is
lifted to clear it by 5.8 m (clear_overpasses: a smooth hump spread along the deck and its approaches).

Coordinates are world metres (x east, z south). Edge points are [x, z] in the graph and [x, z, y, c] once profiled:
y = road height on the centre line, c = cross slope (height change per metre to the left of travel direction).
"""
import heapq, math
from collections import Counter, defaultdict
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

RANK = {'asphalt': 3, 'gravel': 2, 'trail': 1}
SHARP = math.radians(150)          # road pairs meeting closer than this get a filleted corner
FILLET = {'asphalt': 4.0, 'gravel': 3.5, 'trail': 2.5}


def _key(p): return (round(float(p[0]), 2), round(float(p[1]), 2))


def is_bridge(e): return bool(e.get('attr', {}).get('bridge'))


def arclen(pts):
    return np.concatenate([[0.0], np.cumsum(np.hypot(*np.diff(pts[:, :2], axis=0).T))])


def at_s(pts, s, cum=None):
    """Points (all columns) at arc lengths s along a polyline."""
    cum = arclen(pts) if cum is None else cum
    s = np.clip(np.atleast_1d(s), 0, cum[-1])
    k = np.clip(np.searchsorted(cum, s, side='right') - 1, 0, len(pts) - 2)
    seg = np.maximum(cum[k + 1] - cum[k], 1e-9)
    t = ((s - cum[k]) / seg)[:, None]
    return pts[k] * (1 - t) + pts[k + 1] * t


def cut(pts, s0, s1, cum=None):
    """Sub-polyline between arc lengths s0 < s1 (end points interpolated, inner vertices kept)."""
    cum = arclen(pts) if cum is None else cum
    inner = pts[(cum > s0 + 1e-6) & (cum < s1 - 1e-6)]
    return np.vstack([at_s(pts, s0, cum), inner, at_s(pts, s1, cum)])


def incidence(nodes, edges):
    inc = [[] for _ in nodes]
    for ei, e in enumerate(edges):
        if e is None: continue
        inc[e['a']].append((ei, 0)); inc[e['b']].append((ei, 1))
    return inc


def oriented(e, end):
    """Edge points running away from the given end (0 = a, 1 = b)."""
    return e['pts'] if end == 0 else e['pts'][::-1]


# ---------------------------------------------------------------- graph
def build_graph(paths):
    keyid, nodes = {}, []
    def nid(p):
        k = _key(p)
        if k not in keyid: keyid[k] = len(nodes); nodes.append(np.array(p[:2], float))
        return keyid[k]
    use, clean = Counter(), []
    for p in paths:
        pts = np.asarray(p['pts'], float)
        keep = [0] + [i for i in range(1, len(pts)) if _key(pts[i]) != _key(pts[i - 1])]
        pts = pts[keep]
        if len(pts) < 2: continue
        ks = [_key(q) for q in pts]
        for k in ks: use[k] += 1
        use[ks[0]] += 1; use[ks[-1]] += 1
        clean.append((p, pts, ks))
    edges = []
    for p, pts, ks in clean:
        start = 0
        for i in range(1, len(pts)):
            if use[ks[i]] > 1 or i == len(pts) - 1:
                seg = pts[start:i + 1]
                edges.append({'a': nid(seg[0]), 'b': nid(seg[-1]), 'pts': seg, 'kind': p['kind'], 'w': p['w'],
                              'attr': p.get('attr', {})})        # OSM class etc. (build_tiles: ROAD_ATTR)
                start = i
    return nodes, edges


def set_end(e, end, node, pos):
    e['a' if end == 0 else 'b'] = node
    e['pts'] = e['pts'].copy(); e['pts'][0 if end == 0 else -1, :2] = pos


def snap_dead_ends(nodes, edges, extra={'trail': 10.0, 'gravel': 4.0, 'asphalt': 4.0}):
    """Dead ends stopping just short of another road get joined onto it (a new junction on that road)."""
    inc = incidence(nodes, edges)
    S = []                                        # samples every 2 m: (edge, s, x, z)
    for ei, e in enumerate(edges):
        if e is None: continue
        cum = arclen(e['pts']); s = np.linspace(0, cum[-1], max(2, int(cum[-1] / 2) + 1))
        q = at_s(e['pts'], s, cum)
        S += [(ei, s[k], q[k, 0], q[k, 1]) for k in range(len(s))]
    S = np.array(S); tree = cKDTree(S[:, 2:4])
    splits = defaultdict(list)                    # edge -> [(s, node)]
    joins = []                                    # (edge, end, edge to join, s)
    blen = {oj: arclen(o['pts'])[-1] for oj, o in enumerate(edges) if o is not None and is_bridge(o)}
    for n, l in enumerate(inc):
        if len(l) != 1: continue
        ei, end = l[0]; e = edges[ei]; P = nodes[n]
        op = oriented(e, end); cum = arclen(op)
        if cum[-1] < 1: continue
        t = at_s(op, min(6, cum[-1]), cum)[0, :2] - P; t /= np.linalg.norm(t) or 1
        best = None
        for k in tree.query_ball_point(P, 24.0):
            oj = int(S[k, 0])
            if oj == ei: continue
            o = edges[oj]; d = np.hypot(S[k, 2] - P[0], S[k, 3] - P[1])
            if d > o['w'] / 2 + extra[e['kind']]: continue
            if d > 1 and np.dot([S[k, 2] - P[0], S[k, 3] - P[1]], t) / d > 0.3: continue   # don't snap back over itself
            if oj in blen and not is_bridge(e) and 4 <= S[k, 1] <= blen[oj] - 4: continue    # a road below a deck
            score = d - o['w'] / 2
            if best is None or score < best[0]: best = (score, oj, S[k, 1])
        if best: joins.append((ei, end, best[1], best[2]))
    # turn join targets into nodes: near an existing end -> that node; else split the target edge there
    for ei, end, oj, s in joins:
        o = edges[oj]; L = arclen(o['pts'])[-1]
        if s < 4: tn = o['a']
        elif s > L - 4: tn = o['b']
        else:
            near = [q for q in splits[oj] if abs(q[0] - s) < 4]
            if near: tn = near[0][1]
            else:
                tn = len(nodes); nodes.append(at_s(o['pts'], s)[0, :2].copy()); splits[oj].append((s, tn))
        e = edges[ei]
        op = oriented(e, end)
        ext = np.vstack([nodes[tn][None, :], op])
        e['pts'] = ext if end == 0 else ext[::-1]
        e['a' if end == 0 else 'b'] = tn
    for oj, lst in splits.items():
        o = edges[oj]; cum = arclen(o['pts']); lst.sort()
        cuts = [(0.0, o['a'])] + lst + [(cum[-1], o['b'])]
        first = True
        for (s0, n0), (s1, n1) in zip(cuts[:-1], cuts[1:]):
            piece = cut(o['pts'], s0, s1, cum)
            piece[0, :2] = nodes[n0]; piece[-1, :2] = nodes[n1]
            ne = {**o, 'a': n0, 'b': n1, 'pts': piece}
            if first: edges[oj] = ne; first = False
            else: edges.append(ne)
    return len(joins)


def merge_deg2(nodes, edges):
    merged = 0
    while True:
        inc = incidence(nodes, edges); touched = set(); did = 0
        for n, l in enumerate(inc):
            if len(l) != 2: continue
            (e1, end1), (e2, end2) = l
            if e1 == e2 or e1 in touched or e2 in touched: continue
            A, B = edges[e1], edges[e2]
            if A['kind'] != B['kind'] or A['w'] != B['w'] or A.get('attr') != B.get('attr'): continue
            pa = A['pts'] if end1 == 1 else A['pts'][::-1]
            pb = B['pts'] if end2 == 0 else B['pts'][::-1]
            na = A['a'] if end1 == 1 else A['b']; nb = B['b'] if end2 == 0 else B['a']
            edges[e1] = {**A, 'a': na, 'b': nb, 'pts': np.vstack([pa, pb[1:]])}
            edges[e2] = None; touched |= {e1, e2}; did += 1
        merged += did
        if not did: return merged


def contract_short(nodes, edges, min_len=14.0, stub=7.0):
    """Collapse tiny edges between junctions into one junction; drop tiny dead-end stubs."""
    inc = incidence(nodes, edges); deg = [len(l) for l in inc]
    parent = list(range(len(nodes)))
    def find(a):
        while parent[a] != a: parent[a] = parent[parent[a]]; a = parent[a]
        return a
    removed = 0
    for ei, e in enumerate(edges):
        if e is None: continue
        L = arclen(e['pts'])[-1]
        if e['a'] == e['b']:
            if L < 20: edges[ei] = None; removed += 1
            continue
        if L < stub and (deg[e['a']] == 1 or deg[e['b']] == 1): edges[ei] = None; removed += 1; continue
        if L < min_len and deg[e['a']] >= 3 and deg[e['b']] >= 3:
            ra, rb = find(e['a']), find(e['b'])
            if ra != rb: parent[rb] = ra
            edges[ei] = None; removed += 1
    groups = defaultdict(list)
    for n in range(len(nodes)): groups[find(n)].append(n)
    for r, mem in groups.items():
        if len(mem) > 1: nodes[r] = np.mean([nodes[m] for m in mem], 0)
    for ei, e in enumerate(edges):
        if e is None: continue
        ra, rb = find(e['a']), find(e['b'])
        if (ra, rb) != (e['a'], e['b']):
            set_end(e, 0, ra, nodes[ra]); set_end(e, 1, rb, nodes[rb])
        if ra == rb and arclen(e['pts'])[-1] < 20: edges[ei] = None; removed += 1
    return removed


def compact(nodes, edges):
    """Drop deleted edges and unused nodes; renumber."""
    edges = [e for e in edges if e is not None]
    used = sorted({e['a'] for e in edges} | {e['b'] for e in edges})
    remap = {o: i for i, o in enumerate(used)}
    nodes = [nodes[o] for o in used]
    for e in edges: e['a'] = remap[e['a']]; e['b'] = remap[e['b']]
    return nodes, edges


# ---------------------------------------------------------------- junction layout (2D)
def junction_layout(nodes, edges):
    """Per node: the roads meeting there sorted by angle, and how far each one is trimmed back."""
    inc = incidence(nodes, edges)
    for e in edges: e['trim'] = [0.0, 0.0]
    J = []
    for n, l in enumerate(inc):
        P = nodes[n]; items = []
        for ei, end in l:
            e = edges[ei]; op = oriented(e, end); cum = arclen(op); L = cum[-1]
            t = at_s(op, min(8.0, 0.4 * L), cum)[0, :2] - P; t /= np.linalg.norm(t) or 1
            items.append({'ei': ei, 'end': end, 't': t, 'ang': math.atan2(t[1], t[0]), 'h': e['w'] / 2, 'L': L, 'kind': e['kind']})
        items.sort(key=lambda it: it['ang'])
        m = len(items)
        for k, it in enumerate(items):
            if m == 1: it['alpha'] = 2 * math.pi; continue
            nx = items[(k + 1) % m]
            a = (nx['ang'] - it['ang']) % (2 * math.pi)
            it['alpha'] = a if a > 1e-6 else 2 * math.pi
        for k, it in enumerate(items):
            if m == 1: it['d'] = 0.0; continue
            pv, nx = items[k - 1], items[(k + 1) % m]
            d, sharp = 0.0, False
            for other, a in ((nx, it['alpha']), (pv, pv['alpha'])):
                if a < SHARP:
                    sharp = True
                    a = max(a, math.radians(12))
                    d = max(d, (other['h'] + it['h'] * math.cos(a)) / math.sin(a))
            d = d + FILLET[it['kind']] if sharp else 1.0
            it['d'] = float(min(d, 35.0, 0.45 * it['L']))
            edges[it['ei']]['trim'][it['end']] = it['d']
        J.append({'n': n, 'P': P, 'items': items})
    return J


# ---------------------------------------------------------------- heights
def _smoothstep(x):
    x = np.clip(x, 0, 1); return x * x * (3 - 2 * x)


def deck_heights(nodes, edges, Hfun, reach=6.0):
    """Deck height at every node on a bridge. Abutments (a bridge meeting an ordinary road, or a bridge end) take the
    highest ground within `reach` m of them on the bridge; nodes between bridge edges (OSM splits a bridge mid-span
    where a tag changes) are interpolated by length along the bridge, so the deck never dips to the river there."""
    inc = incidence(nodes, edges)
    B = [ei for ei, e in enumerate(edges) if is_bridge(e)]
    on = sorted({edges[ei][k] for ei in B for k in ('a', 'b')})
    if not on: return {}
    def abut(n):                                                  # highest ground near n on its bridge edges
        ys = []
        for ei, end in inc[n]:
            e = edges[ei]
            if not is_bridge(e): continue
            op = oriented(e, end); cum = arclen(op); r = min(reach, cum[-1] / 4)
            q = at_s(op, np.linspace(0, r, max(2, int(math.ceil(r)) + 1)), cum)
            ys.append(float(Hfun(q[:, 0], q[:, 1]).max()))
        return max(ys)
    fixed = {n: abut(n) for n in on if len(inc[n]) == 1 or any(not is_bridge(edges[ei]) for ei, _ in inc[n])}
    parent = {n: n for n in on}                                   # bridge pieces: a piece with no abutment at all
    def find(a):                                                  # (a loop of bridge ways) keeps its own ground
        while parent[a] != a: parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for ei in B: parent[find(edges[ei]['a'])] = find(edges[ei]['b'])
    anchored = {find(n) for n in fixed}
    fixed.update({n: abut(n) for n in on if find(n) not in anchored})
    free = [n for n in on if n not in fixed]; idx = {n: k for k, n in enumerate(free)}
    y = dict(fixed)
    if free:                                                      # each free node: length-weighted mean of its neighbours
        A = np.zeros((len(free), len(free))); b = np.zeros(len(free))
        for ei in B:
            e = edges[ei]; w = 1.0 / max(arclen(e['pts'])[-1], 1.0)
            for p, o in ((e['a'], e['b']), (e['b'], e['a'])):
                if p not in idx or p == o: continue
                A[idx[p], idx[p]] += w
                if o in idx: A[idx[p], idx[o]] -= w
                else: b[idx[p]] += w * fixed[o]
        y.update(zip(free, np.linalg.lstsq(A, b, rcond=None)[0].tolist()))
    return y


def _crosses(a, b):
    """True if polylines a and b ([x, z] rows) cross or touch anywhere."""
    p, r = a[:-1, None, :2], (a[1:] - a[:-1])[:, None, :2]
    q, t = b[None, :-1, :2], (b[1:] - b[:-1])[None, :, :2]
    cr = lambda u, v: u[..., 0] * v[..., 1] - u[..., 1] * v[..., 0]
    den = cr(r, t); ok = np.abs(den) > 1e-9; den = np.where(ok, den, 1)
    u, v = cr(q - p, t) / den, cr(q - p, r) / den
    return bool((ok & (u >= 0) & (u <= 1) & (v >= 0) & (v <= 1)).any())


def clear_overpasses(nodes, edges, clear=5.8, reach=80.0, kinds=('asphalt', 'gravel')):
    """A deck over another road is lifted so its surface is at least `clear` m above that road (underside ~5 m):
    a hump, flat over the road below, easing off as a half cosine of road distance (no kinks) along the rest of the
    deck and up to `reach` m beyond each deck end, into every road met there. Works on the free profiles
    (e['_prof']), before the junction planes are fitted, so planes and junction pieces follow it. Bridges over water
    only keep their straight deck. Returns per lifted deck: (deck edge ids, lift m, steepest grade of the deck road
    where lifted, taper m on each side, steepest grade of the lift alone)."""
    inc = incidence(nodes, edges)
    B = [ei for ei, e in enumerate(edges) if is_bridge(e)]
    low = [ei for ei, e in enumerate(edges) if not is_bridge(e) and e['kind'] in kinds]
    if not B or not low: return []
    bdeg = Counter()
    for ei in B: bdeg[edges[ei]['a']] += 1; bdeg[edges[ei]['b']] += 1
    LP = np.vstack([edges[ei]['_prof'][3] for ei in low]); LY = np.concatenate([edges[ei]['_prof'][4] for ei in low])
    LI = np.concatenate([np.full(len(edges[ei]['_prof'][3]), ei) for ei in low]); tree = cKDTree(LP)
    lift, out, done = {}, [], set()
    for b0 in B:
        if b0 in done: continue
        seq = []                                                  # the deck: bridge edges end to end, from one end
        comp, stack = {b0}, [edges[b0]['a'], edges[b0]['b']]
        while stack:
            m = stack.pop()
            for ei, _ in inc[m]:
                if is_bridge(edges[ei]) and ei not in comp: comp.add(ei); stack += [edges[ei]['a'], edges[ei]['b']]
        done |= comp
        ends = sorted({edges[ei][k] for ei in comp for k in ('a', 'b') if bdeg[edges[ei][k]] == 1})
        if len(ends) != 2 or any(bdeg[edges[ei][k]] > 2 for ei in comp for k in ('a', 'b')): continue   # branching / loop
        n = ends[0]
        while len(seq) < len(comp):
            ei, end = next((ei, end) for ei, end in inc[n] if ei in comp and ei not in {x for x, _ in seq})
            seq.append((ei, end == 0)); n = edges[ei]['b'] if end == 0 else edges[ei]['a']
        U, off = {}, 0.0                                          # deck coordinate of every free-profile sample
        for ei, f in seq:
            _, L, s, _, _ = edges[ei]['_prof']; U[ei] = off + (s if f else L - s); off += L
        touch = comp | {x for ei, _ in seq for k in ('a', 'b') for x, _ in inc[edges[ei][k]]}
        need, at, cross = [], [], {}
        for ei, _ in seq:
            _, _, _, q, free = edges[ei]['_prof']; hw = edges[ei]['w'] / 2
            for k, near in enumerate(tree.query_ball_point(q, hw + 10.0)):
                for j in near:
                    le = LI[j]
                    if le in touch or np.hypot(*(q[k] - LP[j])) > hw + edges[le]['w'] / 2: continue
                    if le not in cross:                           # the road below crosses the deck somewhere
                        cross[le] = any(_crosses(edges[d]['pts'], edges[le]['pts']) for d, _ in seq)
                    if cross[le]: need.append(LY[j] + clear - free[k]); at.append(U[ei][k])
        if not need or max(need) <= 0: continue
        H, u0, u1 = max(need), min(at), max(at)
        below = {le for le, c in cross.items() if c}
        # each side: road distance from the flat top, out through the deck end into every road beyond it (Dijkstra,
        # through junctions: all roads at a lifted junction ease off alike); the taper ends `reach` m past the deck
        # end, or sooner if it would reach a junction of the road below (that road is never lifted)
        sides = []
        for src, d0 in ((ends[0], u0), (n, off - u1)):
            R = d0 + reach; dist = {src: d0}; heap = [(d0, src)]
            while heap:
                d, m = heapq.heappop(heap)
                if d > dist.get(m, np.inf) or d > R: continue
                for ei, end in inc[m]:
                    if ei in comp or ei in below: continue
                    o = edges[ei]['b'] if end == 0 else edges[ei]['a']; dn = d + edges[ei]['_prof'][1]
                    if dn < dist.get(o, np.inf): dist[o] = dn; heapq.heappush(heap, (dn, o))
            stop = [dist[m] for le in below for m in (edges[le]['a'], edges[le]['b']) if m in dist]
            sides.append((dist, max(min([R] + stop), d0 + 1e-6)))
        bell = lambda d, R: H * (1 + np.cos(np.pi * np.clip(d / R, 0, 1))) / 2
        road = set()                                              # the deck road's approaches: straight on at each end
        for m in (ends[0], n):
            dk = next((ei, end) for ei, end in inc[m] if ei in comp)
            td = oriented(edges[dk[0]], dk[1]); td = td[min(2, len(td) - 1), :2] - td[0, :2]
            on = [(np.dot(td, oriented(edges[ei], end)[1, :2] - oriented(edges[ei], end)[0, :2]) /
                   (np.linalg.norm(td) * np.linalg.norm(oriented(edges[ei], end)[1, :2] - oriented(edges[ei], end)[0, :2]) + 1e-9), ei)
                  for ei, end in inc[m] if ei not in comp]
            if on: road.add(min(on)[1])
        mine = {}
        for ei, _ in seq:
            u = U[ei]; mine[ei] = np.where(u < u0, bell(u0 - u, sides[0][1]), np.where(u > u1, bell(u - u1, sides[1][1]), H))
        for ei in {ei for dist, _ in sides for m in dist for ei, _ in inc[m]} - comp - below:
            e = edges[ei]; _, L, s, _, _ = e['_prof']; l = None
            for dist, R in sides:
                da, db = dist.get(e['a'], np.inf), dist.get(e['b'], np.inf)
                if min(da, db) >= R: continue
                v = bell(np.minimum(da + s, db + L - s), R); l = v if l is None else np.maximum(l, v)
            if l is not None: mine[ei] = l
        grade = 0.0                                               # of the deck road (deck + its two approaches)
        for ei, l in mine.items():
            lift[ei] = np.maximum(lift.get(ei, 0.0), l)
            _, _, s, _, free = edges[ei]['_prof']; k = l > 0.01
            if len(s) > 2 and k.any() and (ei in comp or ei in road):
                grade = max(grade, float(np.abs(np.gradient(free + l, s))[k].max()))
        out.append(([ei for ei, _ in seq], round(H, 2), round(grade, 3), round(sides[0][1], 1), round(sides[1][1], 1),
                    round(H * np.pi / 2 / min(s[1] for s in sides), 3)))
    for ei, l in lift.items():
        cum, L, s, q, free = edges[ei]['_prof']; edges[ei]['_prof'] = (cum, L, s, q, free + l)
    return out


def profiles(nodes, edges, J, Hfun, Hsmooth, grad, blend=18.0, sigma=6.0, max_grade=0.08, log=None):
    """Each edge's smooth height along its length; junction planes fitted to the roads meeting there; then each
    edge pinned to its junction planes near its ends, trimmed and resampled every <= 2 m."""
    deck = deck_heights(nodes, edges, Hfun)
    for e in edges:                                               # free profile: terrain smoothed along the road
        pts = e['pts']; cum = arclen(pts); L = cum[-1]
        s = np.linspace(0, L, max(2, int(math.ceil(L)) + 1)); ds = s[1] - s[0]
        q = at_s(pts, s, cum)[:, :2]
        if is_bridge(e):                                          # deck: straight from abutment to abutment
            free = deck[e['a']] + (deck[e['b']] - deck[e['a']]) * s / max(L, 1e-6)
        else:
            free = ndimage.gaussian_filter1d(Hfun(q[:, 0], q[:, 1]), max(0.5, sigma / max(ds, 1e-3)), mode='nearest')
        e['_prof'] = (cum, L, s, q, free)
    lifted = clear_overpasses(nodes, edges)
    if log:
        log(f'overpasses: {len(lifted)} decks lifted over a road below (lift m / max grade of the deck road / '
            f'steepest grade of the lift itself / taper m each side):',
            ', '.join(f'{h}/{g}/{lg}/{l:.0f}+{r:.0f}' for _, h, g, l, r, lg in lifted[:40]))
    planes = {}
    for j in J:                                                   # plane fit (ridge: slope pulled toward flat)
        if len(j['items']) < 2: continue
        P = j['P']; rows, ys = [], []
        for it in j['items']:
            cum, L, s, q, free = edges[it['ei']]['_prof']
            dist = s if it['end'] == 0 else L - s
            k = dist <= it['d'] + 10
            rows.append(q[k] - P); ys.append(free[k])
        R = np.vstack(rows); y = np.concatenate(ys)
        A = np.column_stack([np.ones(len(R)), R]); lam = np.diag([0.0, 40.0, 40.0])
        coef = np.linalg.solve(A.T @ A + lam, A.T @ y)
        g = coef[1:]; gn = np.hypot(*g)
        if gn > max_grade: g = g * (max_grade / gn)
        planes[j['n']] = (P, float(np.mean(y - R @ g)), g)
    plane_y = lambda pl, x, z: pl[1] + pl[2][0] * (x - pl[0][0]) + pl[2][1] * (z - pl[0][1])
    for e in edges:
        pts = e['pts']; cum, L, s, q, free = e.pop('_prof')
        tg = np.gradient(q, axis=0); tg /= np.maximum(np.hypot(*tg.T), 1e-9)[:, None]
        nrm = np.stack([tg[:, 1], -tg[:, 0]], 1)                       # left of travel direction
        ws, ys, cs = [], [], []
        for end, dist in ((0, s), (1, L - s)):
            pl = planes.get(e['a'] if end == 0 else e['b'])
            if pl is None: continue
            w = 1 - _smoothstep((dist - e['trim'][end]) / blend)
            ws.append(w); ys.append(plane_y(pl, q[:, 0], q[:, 1])); cs.append(nrm @ pl[2])
        if ws:
            W = np.sum(ws, 0); norm = np.maximum(W, 1)
            y = (sum(w * yy for w, yy in zip(ws, ys)) + np.maximum(0, 1 - W) * free) / norm
            c = sum(w * cc for w, cc in zip(ws, cs)) / norm
        else:
            y, c = free, np.zeros_like(free)
        s0, s1 = e['trim'][0], L - e['trim'][1]
        if s1 - s0 < 0.6: mid = (s0 + s1) / 2; s0, s1 = mid - 0.3, mid + 0.3
        sub = cut(pts[:, :2], s0, s1, cum)
        sc = arclen(sub); n = max(1, int(math.ceil(sc[-1] / 2.0)))
        so = np.linspace(0, sc[-1], n + 1)
        xy = np.round(at_s(sub, so, sc), 2)
        keep = np.concatenate([[True], np.hypot(*np.diff(xy, axis=0).T) > 0.05])
        xy = xy[keep]
        if len(xy) < 2: xy = np.round(np.vstack([at_s(sub, 0.0, sc), at_s(sub, sc[-1], sc)]), 2)
        sa = s0 + arclen(xy)
        out = np.column_stack([xy, np.interp(sa, s, y), np.interp(sa, s, c)])
        for end, idx, other in ((0, 0, 1), (1, -1, -2)):           # exact match with the junction plane at the ends
            pl = planes.get(e['a'] if end == 0 else e['b'])
            if pl is None: continue
            t = out[idx if end == 0 else idx, :2] - out[other, :2] if end == 1 else out[1, :2] - out[0, :2]
            t = t / (np.linalg.norm(t) or 1)
            out[idx, 2] = plane_y(pl, out[idx, 0], out[idx, 1]); out[idx, 3] = t[1] * pl[2][0] - t[0] * pl[2][1]
        e['out'] = out
    return planes, plane_y


def junction_rings(J, edges, planes, plane_y):
    """Junction polygons: road ends joined by fillets (or an end cap for dead ends), with heights."""
    out = []
    for j in J:
        items = j['items']; m = len(items)
        if m == 0: continue
        ends = []
        for it in items:
            o = edges[it['ei']]['out']; op = o if it['end'] == 0 else o[::-1]
            P = op[0]; t = op[1, :2] - op[0, :2]; t = t / (np.linalg.norm(t) or 1)
            prv = P[:2] + it['h'] * np.array([t[1], -t[0]])
            nxt = P[:2] + it['h'] * np.array([-t[1], t[0]])
            ends.append((P, t, prv, nxt))
        C = j['P'] if m >= 2 else ends[0][0][:2]
        pl = planes.get(j['n'])
        hy = (lambda x, z: plane_y(pl, x, z)) if pl else (lambda x, z, y0=ends[0][0][2]: y0)
        ring = []                                 # [x, z, flag]: flag 1 = the edge to the next point is open (skirt)
        for k, it in enumerate(items):
            P, t, prv, nxt = ends[k]
            ring.append([*prv, 0]); ring.append([*nxt, 1])
            A = nxt; nP, nt, nprv, _ = ends[(k + 1) % m]; B = nprv
            a = it['alpha']
            pts = []
            if m >= 2:
                # follow the two road edges: a curve through where they cross (if ahead of both ends), else straight
                M = np.array([[-t[0], nt[0]], [-t[1], nt[1]]])
                if abs(np.linalg.det(M)) > 1e-3:
                    su = np.linalg.solve(M, B - A)
                    if su[0] > 0 and su[1] > 0 and max(su) < 40:
                        Cc = A - t * su[0]
                        for u in np.linspace(0, 1, 7)[1:-1]:
                            pts.append((1 - u) ** 2 * A + 2 * u * (1 - u) * Cc + u * u * B)
            else:                                 # dead end: round cap
                a0 = math.atan2(A[1] - C[1], A[0] - C[0]); r0 = np.hypot(*(A - C))
                for u in np.linspace(0, 1, 13)[1:-1]:
                    ang = a0 + math.pi * u
                    pts.append(C + r0 * np.array([math.cos(ang), math.sin(ang)]))
            ring += [[*p, 1] for p in pts]
        ring = np.array(ring)
        ys = np.array([hy(x, z) for x, z in ring[:, :2]])
        kind = max((it['kind'] for it in items), key=RANK.get)
        out.append({'kind': kind, 'c': [round(float(C[0]), 2), round(float(C[1]), 2), round(float(hy(*C)), 3)],
                    'ring': [[round(float(x), 2), round(float(z), 2), round(float(y), 3), int(f)]
                             for (x, z, f), y in zip(ring, ys)]})
    return out


# ---------------------------------------------------------------- carve the terrain
def carve(gh, gx0, gz0, hstep, edges, juncs, protect, drop=0.1, inner=6.0, outer=10.0):
    """Grid heights under / next to roads set to just below the road surface, blended back to the ground.
    protect: per grid vertex, the lowest height carving may set (-inf = free, inf = never touched; pond rims).
    Bridge decks are skipped, and ground under a deck is only ever lowered (the river / road below stays open)."""
    X, Z, Y, C, NX, NZ, HW, GX, GZ = [], [], [], [], [], [], [], [], []
    for e in edges:
        o = e['out']; cum = arclen(o); L = cum[-1]
        if L < 0.5 or is_bridge(e): continue                       # swallowed by its junctions / a deck
        s = np.linspace(0, L, max(2, int(math.ceil(L / 3)) + 1)); q = at_s(o, s, cum)
        tg = np.gradient(q[:, :2], axis=0) if len(q) > 2 else np.repeat(q[1:2, :2] - q[0:1, :2], len(q), 0)
        tg /= np.maximum(np.hypot(*tg.T), 1e-9)[:, None]
        X.append(q[:, 0]); Z.append(q[:, 1]); Y.append(q[:, 2]); C.append(q[:, 3])
        NX.append(tg[:, 1]); NZ.append(-tg[:, 0]); HW.append(np.full(len(q), e['w'] / 2))
        grade = np.gradient(q[:, 2], s) if len(q) > 1 else np.zeros(len(q))     # slope along the road
        GX.append(grade * tg[:, 0]); GZ.append(grade * tg[:, 1])
    for j in juncs:
        c = np.array(j['c']); r = np.array(j['ring'])[:, :3]
        for k in range(len(r)):
            a, b = r[k], r[(k + 1) % len(r)]
            n = int(max(np.hypot(*(a[:2] - c[:2])), np.hypot(*(b[:2] - c[:2]))) / 3.0) + 2
            uu, vv = np.meshgrid(np.linspace(0, 1, n), np.linspace(0, 1, n)); ok = uu + vv <= 1
            u, v = uu[ok], vv[ok]; p = c + (a - c) * u[:, None] + (b - c) * v[:, None]
            X.append(p[:, 0]); Z.append(p[:, 1]); Y.append(p[:, 2]); z0 = np.zeros(len(p))
            C.append(z0); NX.append(z0); NZ.append(z0); HW.append(z0)
            M = np.array([[a[0] - c[0], a[1] - c[1]], [b[0] - c[0], b[1] - c[1]]])       # the triangle's slope
            g = np.linalg.solve(M, [a[2] - c[2], b[2] - c[2]]) if abs(np.linalg.det(M)) > 1e-6 else np.zeros(2)
            GX.append(np.full(len(p), g[0])); GZ.append(np.full(len(p), g[1]))
    X, Z, Y, C, NX, NZ, HW, GX, GZ = (np.nan_to_num(np.concatenate(a)) for a in (X, Z, Y, C, NX, NZ, HW, GX, GZ))
    # separate trees for strip and junction samples, so dense junction samples can't crowd out a nearby road
    isj = HW == 0; idx_s, idx_j = np.nonzero(~isj)[0], np.nonzero(isj)[0]
    trees = [(cKDTree(np.column_stack([X[ix], Z[ix]])), ix) for ix in (idx_s, idx_j) if len(ix)]
    reach = HW.max() + inner + outer
    # candidate grid vertices: near any sample (coarse pre-mask on the grid itself)
    H, Wd = gh.shape
    m = np.zeros_like(gh, bool)
    ii = np.clip(((Z - gz0) / hstep).round().astype(int), 0, H - 1); jj = np.clip(((X - gx0) / hstep).round().astype(int), 0, Wd - 1)
    m[ii, jj] = True
    m = ndimage.binary_dilation(m, iterations=int(math.ceil(reach / hstep)) + 1)
    vi, vj = np.nonzero(m)
    vx, vz = gx0 + vj * hstep, gz0 + vi * hstep
    under = np.zeros(len(vi), bool)                             # under a bridge deck
    DP, _, DHW = _deck_samples(edges)
    if len(DP):
        dd, dk = cKDTree(DP).query(np.column_stack([vx, vz]), distance_upper_bound=DHW.max(), workers=-1)
        under = dd <= DHW[np.minimum(dk, len(DP) - 1)]
    old = gh[vi, vj].copy(); new = old.copy(); use = np.zeros(len(vi), bool)
    for c0 in range(0, len(vi), 60000):                         # in chunks (k neighbours per vertex)
        sl = slice(c0, c0 + 60000); px, pz = vx[sl], vz[sl]
        ds, ks = [], []
        for tr, ix in trees:
            dd, k0 = tr.query(np.column_stack([px, pz]), k=40, distance_upper_bound=reach, workers=-1)
            ds.append(dd); ks.append(np.where(np.isfinite(dd), ix[np.minimum(k0, len(ix) - 1)], 0))
        d, k = np.hstack(ds), np.hstack(ks)
        valid = np.isfinite(d); kk = np.where(valid, k, 0)
        rx, rz = px[:, None] - X[kk], pz[:, None] - Z[kk]
        o_raw = rx * NX[kk] + rz * NZ[kk]; along = np.abs(rx * NZ[kk] - rz * NX[kk])
        strip = HW[kk] > 0
        # distance outside that road's edge (strip samples every 3 m: use the sideways offset when beside the sample)
        e = np.where(strip & (along <= 1.6), np.abs(o_raw) - HW[kk], d - HW[kk])
        e = np.where(valid, e, np.inf)
        target = np.where(valid, Y[kk] + GX[kk] * rx + GZ[kk] * rz + C[kk] * np.clip(o_raw, -HW[kk], HW[kk]) - drop, np.inf)
        # under / beside any road (within `inner` of its edge): below every such road. Further out: blend back.
        hard = np.where(e < inner, target, np.inf).min(1)
        eb = e.min(1); soft = target[np.arange(len(px)), e.argmin(1)]
        w = _smoothstep((eb - inner) / outer)
        o = old[sl]
        blend = np.where(np.isfinite(soft), soft, o) * (1 - w) + o * w
        new[sl] = np.where(np.isfinite(hard), hard, np.where(np.isfinite(soft), blend, o))
        new[sl] = np.where(under[sl], np.minimum(new[sl], o), new[sl])
        fl = protect[vi[sl], vj[sl]]
        new[sl] = np.maximum(new[sl], np.where(np.isfinite(fl), fl, -np.inf))       # rims: no lower than the floor
        use[sl] = np.isfinite(eb) & (eb < inner + outer) & (fl < np.inf)
    vi, vj, new, old = vi[use], vj[use], new[use], old[use]
    gh[vi, vj] = new
    return len(vi), float(np.abs(new - old).max()) if len(vi) else 0.0


def _deck_samples(edges, step=1.0, side=1.5):
    """Bridge decks every `step` m: points, the deck's lowest height across its width (+ `side` m), half-widths."""
    P, Y, HW = [], [], []
    for e in edges:
        if not is_bridge(e): continue
        o = e['out']; cum = arclen(o)
        if cum[-1] < 0.5: continue
        q = at_s(o, np.linspace(0, cum[-1], max(2, int(cum[-1] / step) + 1)), cum); hw = e['w'] / 2 + side
        P.append(q[:, :2]); Y.append(q[:, 2] - np.abs(q[:, 3]) * hw); HW.append(np.full(len(q), hw))
    if not P: return np.zeros((0, 2)), np.zeros(0), np.zeros(0)
    return np.vstack(P), np.concatenate(Y), np.concatenate(HW)


def under_bridges(gh, gx0, gz0, hstep, edges, protect=None, below=0.35):
    """Under a bridge deck the ground stays as it is (river, road below), except where it would poke up into the
    deck (abutments, bumps): there it is lowered to `below` m under the deck. Returns (vertices lowered, max drop)."""
    P, Y, HW = _deck_samples(edges)
    if not len(P): return 0, 0.0
    H, Wd = gh.shape; r = int(math.ceil(HW.max() / hstep)) + 1
    ci, cj = np.round((P[:, 1] - gz0) / hstep).astype(int), np.round((P[:, 0] - gx0) / hstep).astype(int)
    di, dj = [a.ravel() for a in np.mgrid[-r:r + 1, -r:r + 1]]
    vi, vj = (ci[:, None] + di).ravel(), (cj[:, None] + dj).ravel()
    ok = (vi >= 0) & (vi < H) & (vj >= 0) & (vj < Wd)
    lin = np.unique(vi[ok].astype(np.int64) * Wd + vj[ok]); vi, vj = lin // Wd, lin % Wd
    dist, k = cKDTree(P).query(np.column_stack([gx0 + vj * hstep, gz0 + vi * hstep]), workers=-1)
    m = dist <= HW[k]
    if protect is not None: m &= protect[vi, vj] < np.inf                   # pond beds are never touched
    vi, vj, top = vi[m], vj[m], Y[k[m]] - below
    low = gh[vi, vj] > top
    drop = gh[vi[low], vj[low]] - top[low]
    gh[vi[low], vj[low]] = top[low]
    return int(low.sum()), float(drop.max()) if len(drop) else 0.0


def harmonize(edges, J):
    """Where two strips overlap side by side (ramps merging, roads doubled up in OSM), the lesser one takes the
    bigger one's surface height there, so their tops meet instead of one floating over the other. A bridge and an
    ordinary road are never matched (an overpass and the road under it keep their own heights)."""
    prio = lambda e: (RANK[e['kind']], e['w'], arclen(e['out'])[-1])
    P, Y, C, NX, NZ, HW, EI = [], [], [], [], [], [], []
    for ei, e in enumerate(edges):
        o = e['out']
        if len(o) < 2: continue
        tg = np.gradient(o[:, :2], axis=0); tg /= np.maximum(np.hypot(*tg.T), 1e-9)[:, None]
        P.append(o[:, :2]); Y.append(o[:, 2]); C.append(o[:, 3]); NX.append(tg[:, 1]); NZ.append(-tg[:, 0])
        HW.append(np.full(len(o), e['w'] / 2)); EI.append(np.full(len(o), ei))
    P, Y, C, NX, NZ, HW, EI = map(np.concatenate, (P, Y, C, NX, NZ, HW, EI))
    tree = cKDTree(P); pr = [prio(e) for e in edges]; changed = 0
    br = [is_bridge(e) for e in edges]
    for ei, e in enumerate(edges):
        o = e['out']; n = len(o)
        if n < 3: continue
        hw = e['w'] / 2; tgt = o[:, 2].copy(); w = np.zeros(n)
        for k, near in enumerate(tree.query_ball_point(o[:, :2], hw + 9.5)):
            for q in near:
                f = EI[q]
                if f == ei or pr[f] <= pr[ei] or br[f] != br[ei]: continue      # a deck and a road under it
                off = (o[k, 0] - P[q, 0]) * NX[q] + (o[k, 1] - P[q, 1]) * NZ[q]
                along = abs((o[k, 0] - P[q, 0]) * NZ[q] - (o[k, 1] - P[q, 1]) * NX[q])
                if along > 1.5: continue
                ov = (HW[q] + hw - abs(off)) / hw                 # how much of this road lies on the other
                if ov <= 0.15: continue
                wk = min(1.0, ov)
                if wk > w[k]: w[k] = wk; tgt[k] = Y[q] + C[q] * np.clip(off, -HW[q], HW[q])
        if not w.any(): continue
        w = ndimage.gaussian_filter1d(ndimage.maximum_filter1d(w, 5), 2.5)
        w = np.minimum(w, 1); w[0] = w[-1] = 0                    # ends stay matched to their junctions
        o[:, 2] = o[:, 2] * (1 - w) + tgt * w; changed += 1
    return changed
