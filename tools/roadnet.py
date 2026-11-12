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

Coordinates are world metres (x east, z south). Edge points are [x, z] in the graph and [x, z, y, c] once profiled:
y = road height on the centre line, c = cross slope (height change per metre to the left of travel direction).
"""
import math
from collections import Counter, defaultdict
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

RANK = {'asphalt': 3, 'gravel': 2, 'trail': 1}
SHARP = math.radians(150)          # road pairs meeting closer than this get a filleted corner
FILLET = {'asphalt': 4.0, 'gravel': 3.5, 'trail': 2.5}


def _key(p): return (round(float(p[0]), 2), round(float(p[1]), 2))


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
                edges.append({'a': nid(seg[0]), 'b': nid(seg[-1]), 'pts': seg, 'kind': p['kind'], 'w': p['w']})
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
            if A['kind'] != B['kind'] or A['w'] != B['w']: continue
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


def profiles(nodes, edges, J, Hfun, Hsmooth, grad, blend=18.0, sigma=6.0, max_grade=0.08):
    """Each edge's smooth height along its length; junction planes fitted to the roads meeting there; then each
    edge pinned to its junction planes near its ends, trimmed and resampled every <= 2 m."""
    for e in edges:                                               # free profile: terrain smoothed along the road
        pts = e['pts']; cum = arclen(pts); L = cum[-1]
        s = np.linspace(0, L, max(2, int(math.ceil(L)) + 1)); ds = s[1] - s[0]
        q = at_s(pts, s, cum)[:, :2]
        free = ndimage.gaussian_filter1d(Hfun(q[:, 0], q[:, 1]), max(0.5, sigma / max(ds, 1e-3)), mode='nearest')
        e['_prof'] = (cum, L, s, q, free)
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
    """Grid heights under / next to roads set to just below the road surface, blended back to the ground."""
    X, Z, Y, C, NX, NZ, HW, GX, GZ = [], [], [], [], [], [], [], [], []
    for e in edges:
        o = e['out']; cum = arclen(o); L = cum[-1]
        if L < 0.5: continue                                       # swallowed by its junctions (not drawn either)
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
        use[sl] = np.isfinite(eb) & (eb < inner + outer) & ~protect[vi[sl], vj[sl]]
    vi, vj, new, old = vi[use], vj[use], new[use], old[use]
    gh[vi, vj] = new
    return len(vi), float(np.abs(new - old).max()) if len(vi) else 0.0


def harmonize(edges, J):
    """Where two strips overlap side by side (ramps merging, roads doubled up in OSM), the lesser one takes the
    bigger one's surface height there, so their tops meet instead of one floating over the other."""
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
    for ei, e in enumerate(edges):
        o = e['out']; n = len(o)
        if n < 3: continue
        hw = e['w'] / 2; tgt = o[:, 2].copy(); w = np.zeros(n)
        for k, near in enumerate(tree.query_ball_point(o[:, :2], hw + 9.5)):
            for q in near:
                f = EI[q]
                if f == ei or pr[f] <= pr[ei]: continue
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
