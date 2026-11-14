"""Bakes game/assets/minimap.jpg: one north-up picture of the whole map for the in-game map (M).

Reads what build_tiles.py already made (no raw data needed): each tile's ground.png, surface.bin (ponds) and
tile.json (roads, trails, buildings). Drawn at 2 m/px, then shrunk to OUT_MPP so lines are smooth.

  .venv/bin/python tools/build_minimap.py      (~20 s)
"""
import json, os
from pathlib import Path
import sys

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import tilefmt                                      # reads packed or plain tile files
ASSETS = Path(os.environ.get('YR_ASSETS', ROOT / 'game' / 'assets'))
DRAW_MPP, OUT_MPP = 2.0, 5.0
ROAD = {  # (fill colour, outline colour, width in metres on the map; a bit wider than real so they read)
    'asphalt': ((70, 73, 82), (235, 235, 230), 14),
    'gravel': ((222, 205, 165), (120, 104, 76), 10),
    'trail': ((214, 148, 86), (110, 70, 35), 8),
}
WATER = (86, 150, 205)
BUILDING = (205, 200, 192)

world = json.loads((ASSETS / 'world.json').read_text())
T = world['tile']
ex0, ez0, ex1, ez1 = world['extent']
if ex1 - ex0 > 30000:                 # the round map: draw at 4 m, keep 5 m/px (the default sharpness)
    DRAW_MPP, OUT_MPP = 4.0, 5.0
W, H = int((ex1 - ex0) / DRAW_MPP), int((ez1 - ez0) / DRAW_MPP)
img = Image.new('RGB', (W, H), (34, 40, 36))          # off the map (the map is a set of tiles, not a rectangle)
tile_px = int(T / DRAW_MPP)


def px(x, z):
    return ((x - ex0) / DRAW_MPP, (z - ez0) / DRAW_MPP)


tiles = []
for tx, tz in world['tiles']:
    d = ASSETS / 'tiles' / f'{tx}_{tz}'
    x0, z0 = tx * T - T / 2, tz * T - T / 2
    ground = np.asarray(tilefmt.read_ground(d).resize((tile_px, tile_px), Image.LANCZOS)).copy()
    surf = np.frombuffer(tilefmt.read_bytes(d, 'surface.bin'), np.uint8).reshape(T, T)
    step = int(DRAW_MPP)
    wet = surf[::step, ::step][:tile_px, :tile_px] == 5            # pond bed
    ground[wet] = WATER
    img.paste(Image.fromarray(ground), (int((x0 - ex0) / DRAW_MPP), int((z0 - ez0) / DRAW_MPP)))
    tiles.append(tilefmt.read_json(d))

draw = ImageDraw.Draw(img)
for tile in tiles:
    for b in tile['buildings']:
        draw.polygon([px(*p) for p in b['pts']], fill=BUILDING, outline=(120, 115, 108))
# outlines first, then fills, per kind (trails under gravel under asphalt), so crossings look joined
for kind in ('trail', 'gravel', 'asphalt'):
    fill, edge, w = ROAD[kind]
    lines = [[px(*p) for p in path['pts']] for tile in tiles for path in tile['paths'] if path['kind'] == kind]
    # junction pieces (roads are trimmed back where they meet): a spoke from the centre to each road end
    for tile in tiles:
        for jn in tile.get('junctions', []):
            if jn['kind'] != kind: continue
            r = jn['ring']
            for k in range(len(r)):
                if r[k][3] == 0:                         # this ring edge is a road end: its midpoint joins the road
                    q = r[(k + 1) % len(r)]
                    lines.append([px(jn['c'][0], jn['c'][1]), px((r[k][0] + q[0]) / 2, (r[k][1] + q[1]) / 2)])
    for pass_col, pass_w in ((edge, w + 4), (fill, w)):
        lw = max(1, round(pass_w / DRAW_MPP))
        for pts in lines:
            if len(pts) > 1:
                draw.line(pts, fill=pass_col, width=lw, joint='curve')

rim = world.get('rim')
if rim:                               # round map: shade everything beyond the rim, draw the rim as a circle
    dx2 = (ex0 + (np.arange(W) + .5) * DRAW_MPP - rim['cx']) ** 2
    dz2 = (ez0 + (np.arange(H) + .5) * DRAW_MPP - rim['cz']) ** 2
    outside = dz2[:, None] + dx2[None, :] > rim['r'] ** 2          # bool H x W (no big index grids)
    a = np.asarray(img).copy(); a[outside] = (a[outside] * 0.35 + np.array((34, 40, 36)) * 0.65).astype(np.uint8)
    img = Image.fromarray(a); del a, outside
    draw = ImageDraw.Draw(img)
    cx, cz = px(rim['cx'], rim['cz']); rr = rim['r'] / DRAW_MPP
    draw.ellipse([cx - rr, cz - rr, cx + rr, cz + rr], outline=(194, 243, 255), width=max(2, int(round(30 / DRAW_MPP))))
out = img.resize((int(W * DRAW_MPP / OUT_MPP), int(H * DRAW_MPP / OUT_MPP)), Image.LANCZOS)
dst = ASSETS / 'minimap.jpg'
quality = 30
while True:                            # 5 m/px is the sharpness; drop quality until the file is under 3 MB
    out.save(dst, quality=quality, optimize=True)
    if dst.stat().st_size <= 3_000_000 or quality <= 20: break
    quality -= 2
meta = {'extent': world['extent'], 'mpp': OUT_MPP, 'size': list(out.size)}
if rim: meta['rim'] = {'cx': rim['cx'], 'cz': rim['cz'], 'r': rim['r']}
(ASSETS / 'minimap.json').write_text(json.dumps(meta))
print(dst, out.size, f'{dst.stat().st_size / 1e6:.2f} MB', 'q', quality)
