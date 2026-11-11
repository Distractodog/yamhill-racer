"""Reads the user's trail map (reference/Delphiantrailsmap.png) and turns it into game-space data.

Coordinates:
  "map" coords  = pixels of Delphiantrailsmap.png (1448 x 2048).
  "game" coords = world pixels of the whole stitched world. game = (map - ORIGIN) * S.
Every area (campus, woods-*) is a rectangle cut out of that one big world, so neighbouring areas line up.
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage
from skimage.morphology import skeletonize

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REF = os.path.join(ROOT, 'reference', 'Delphiantrailsmap.png')

S = 2.5                      # game px per map px
ORIGIN = (150, 50)           # map px that becomes game (0,0)
MAP_END = (1440, 1850)       # map px that becomes the bottom-right corner
GW = int(round((MAP_END[0] - ORIGIN[0]) * S))   # 3225
GH = int(round((MAP_END[1] - ORIGIN[1]) * S))   # 4500


def g(x, y):
    """map px -> game px"""
    return ((x - ORIGIN[0]) * S, (y - ORIGIN[1]) * S)


def gp(pts):
    return [g(x, y) for x, y in pts]


# Colours used on the map.
COLORS = {
    'black': [(4, 7, 7), (0, 0, 0)],
    'longwalk': [(232, 29, 37), (237, 28, 36)],
    'overgrown': [(139, 92, 0)],
    'odyssey': [(66, 167, 222)],
    'ripps': [(255, 242, 0), (237, 233, 18)],
    'agony': [(100, 0, 64)],
    'waterfall': [(0, 12, 140)],
    'water': [(152, 213, 244)],
    'road': [(198, 199, 199)],
}
# Background colours a pixel may be closer to instead (so anti-aliased edges don't leak in).
BACKGROUND = [(166, 200, 94), (200, 221, 118), (255, 255, 255), (141, 159, 104), (157, 170, 117)]

# Parts of the map that are not terrain (legend boxes, compass) or that we deliberately drop.
EXCLUDE = [
    (1080, 15, 1448, 482),    # "Hiking Trail" legend
    (0, 1525, 442, 2048),     # "Delphian School" legend
    (1160, 1760, 1420, 2048), # compass
    (750, 1330, 796, 1452),   # footpath that runs through where we draw the Main Building
    (583, 1440, 632, 1484),   # short connector that would cross the Odyssey twice
]
TRAILS = ['black', 'longwalk', 'overgrown', 'odyssey', 'ripps', 'agony', 'waterfall']


def _load():
    a = np.asarray(Image.open(REF).convert('RGB')).astype(np.int32)
    keys, cols = [], []
    for k, cl in COLORS.items():
        for c in cl:
            keys.append(k); cols.append(c)
    for c in BACKGROUND:
        keys.append('_bg'); cols.append(c)
    cols = np.array(cols)
    best = np.full(a.shape[:2], 1e9); lab = np.full(a.shape[:2], -1)
    for i, c in enumerate(cols):
        d = np.abs(a - c).sum(2)
        m = d < best
        best[m] = d[m]; lab[m] = i
    masks = {}
    # white building blocks (with their black outlines) are drawn by us, not traced
    white = (a.min(2) >= 245)
    wl, _ = ndimage.label(white)
    sizes = np.bincount(wl.ravel())
    small = np.isin(wl, np.nonzero((sizes < 20000))[0]) & white
    bld = ndimage.binary_dilation(small, iterations=4)
    bld[:1000] = False      # out in the woods the trails run right up to the cabins; keep them joined
    for k in COLORS:
        idx = [i for i, kk in enumerate(keys) if kk == k]
        tol = 150 if k in ('black', 'water', 'road') else 70
        m = np.isin(lab, idx) & (best < tol)
        if k in ('black', 'road'):
            m &= ~bld
        masks[k] = m
    # the grey roads and the two little ponds have thin dark outlines that look like trail pixels
    road = masks['road']
    near_road = ndimage.binary_dilation(road, iterations=3)
    wat = masks['water'].copy(); wat[:1200] = False
    near_pond = ndimage.binary_dilation(wat, iterations=4)
    masks['black'] = masks['black'] & ~near_road & ~near_pond
    for k in COLORS:
        m = masks[k]
        for x0, y0, x1, y1 in EXCLUDE:
            m[y0:y1, x0:x1] = False
        masks[k] = m
    return masks


def _clean(m, min_span=30):
    lab, n = ndimage.label(m, structure=np.ones((3, 3)))
    out = np.zeros_like(m)
    for i, sl in enumerate(ndimage.find_objects(lab), 1):
        span = max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start)
        if span >= min_span:
            out[sl] |= lab[sl] == i
    return out


_cache = {}


def map_masks():
    if 'm' in _cache:
        return _cache['m']
    raw = _load()
    out = {}
    for k in TRAILS:
        m = raw[k]
        if k == 'black':
            # remove the black number discs ("1".."8", "P"): blobs that are thick everywhere
            thick = ndimage.binary_erosion(m, iterations=3)
            blobs = ndimage.binary_dilation(thick, iterations=6)
            m = m & ~blobs
        m = ndimage.binary_closing(ndimage.binary_dilation(m, iterations=1), iterations=2)
        out[k] = _clean(m, 25)
    out['water'] = ndimage.binary_fill_holes(_clean(raw['water'], 10))
    out['road'] = _clean(raw['road'], 40)
    _cache['m'] = out
    return out


def skeleton_points(mask):
    """Centre-line pixels of a map mask, returned in game coords (float arrays xs, ys)."""
    sk = skeletonize(mask)
    ys, xs = np.nonzero(sk)
    return (xs + 0.5 - ORIGIN[0]) * S, (ys + 0.5 - ORIGIN[1]) * S


def game_raster_from_points(xs, ys):
    """Rasterise skeleton points into the game grid, joining neighbours so the line is continuous."""
    r = np.zeros((GH, GW), bool)
    xi = np.clip(np.round(xs).astype(int), 0, GW - 1); yi = np.clip(np.round(ys).astype(int), 0, GH - 1)
    r[yi, xi] = True
    # skeleton points are S px apart; a small dilation joins them into a line
    return ndimage.binary_dilation(r, structure=np.ones((3, 3)), iterations=1)


def game_raster_from_mask(mask):
    """Upscale a filled map mask (water) to game resolution, smoothly."""
    x0, y0 = ORIGIN; x1, y1 = MAP_END
    sub = (mask[y0:y1, x0:x1].astype(np.uint8) * 255)
    im = Image.fromarray(sub).resize((GW, GH), Image.BILINEAR)
    return np.asarray(im) > 127
