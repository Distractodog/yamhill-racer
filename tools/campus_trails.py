"""Campus trace cleanup, before graph junctions, profiles and terrain carving.

An 8-connected skeleton must not keep a diagonal shortcut when an orthogonal
pixel already connects the same corner: that creates tiny triangular loops and
false degree-3 junctions. Smooth at metre scale, not at input-vertex density.
"""
import numpy as np
from scipy import ndimage
from skimage.morphology import skeletonize


def trace_skeleton(mask, min_len_px):
    ys, xs = np.nonzero(skeletonize(mask))
    on = set(zip(ys.tolist(), xs.tolist()))
    neighbours = {}
    for y, x in sorted(on):
        neighbours[y, x] = [(y + dy, x + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                            if (dy or dx) and (y + dy, x + dx) in on
                            and not (dy and dx and ((y + dy, x) in on or (y, x + dx) in on))]
    degree = {p: len(n) for p, n in neighbours.items()}
    nodes = {p for p, d in degree.items() if d != 2}
    used, paths = set(), []
    for start in sorted(nodes) + sorted(on - nodes):
        for nxt in neighbours[start]:
            edge = tuple(sorted((start, nxt)))
            if edge in used:
                continue
            used.add(edge)
            path, prev, cur = [start, nxt], start, nxt
            while cur not in nodes and cur != start:
                candidates = [p for p in neighbours[cur] if p != prev and tuple(sorted((cur, p))) not in used]
                if not candidates:
                    break
                p = candidates[0]
                used.add(tuple(sorted((cur, p))))
                path.append(p)
                prev, cur = cur, p
            if not ((degree[path[0]] == 1 or degree[path[-1]] == 1) and len(path) < min_len_px):
                paths.append(path)
    return paths


def smooth_trail(points, width=12):
    """Remove sub-width tracing kinks; keep junction endpoints and closed loops.

    Regular 1 m samples prevent Chaikin's input-density-dependent tight bends.
    Limit displacement to 2 m: this cleans raster jitter, not real switchbacks.
    Tight real turns still require an audited route edit or narrower trail.
    """
    p = np.asarray(points, dtype=float)
    if len(p) < 3:
        return p
    keep = np.r_[True, np.linalg.norm(np.diff(p, axis=0), axis=1) > 1e-6]
    p = p[keep]
    if len(p) < 3:
        return p
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))]
    closed = np.linalg.norm(p[0] - p[-1]) < 1e-6
    q = np.column_stack([np.interp(np.linspace(0, s[-1], max(3, int(np.ceil(s[-1])) + 1)), s, p[:, k]) for k in (0, 1)])
    source = q[:-1] if closed else q
    smooth = ndimage.gaussian_filter1d(source, max(1, width / 4), axis=0, mode='wrap' if closed else 'nearest')
    delta = smooth - source
    length = np.linalg.norm(delta, axis=1)
    delta *= np.minimum(1, 2 / np.maximum(length, 1e-9))[:, None]
    if not closed:
        ramp = np.minimum(np.arange(len(q)), np.arange(len(q))[::-1]) / max(1, width / 2)
        delta *= np.minimum(1, ramp)[:, None]
    result = source + delta
    return np.vstack([result, result[0]]) if closed else result


def limit_trail_profile(points, max_grade=.55):
    """Remove interior height spikes while keeping both junction heights exact.

    On a short connector whose endpoints already demand a steeper grade, use
    that unavoidable average grade. Rebuilding must not open a junction seam.
    Such connectors remain in the audit for a junction/route layout decision.
    """
    p = np.asarray(points)
    if len(p) < 3:
        return
    ds = np.linalg.norm(np.diff(p[:, :2], axis=0), axis=1)
    s = np.r_[0, np.cumsum(ds)]
    if s[-1] < 1e-6:
        return
    y0, yn = p[0, 2], p[-1, 2]
    grade = max(max_grade, abs(yn - y0) / s[-1] + 1e-9)
    lo = np.maximum(y0 - grade * s, yn - grade * (s[-1] - s))
    hi = np.minimum(y0 + grade * s, yn + grade * (s[-1] - s))
    y = np.clip(p[:, 2], lo, hi)
    for i in range(1, len(y)):
        y[i] = np.clip(y[i], y[i-1] - grade * ds[i-1], y[i-1] + grade * ds[i-1])
    for i in range(len(y)-2, -1, -1):
        y[i] = np.clip(y[i], y[i+1] - grade * ds[i], y[i+1] + grade * ds[i])
    y[0], y[-1] = y0, yn
    p[:, 2] = y
