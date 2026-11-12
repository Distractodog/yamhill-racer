"""Bakes game/assets/minimap.jpg: one north-up picture of the whole map for the in-game map (M).

Reads what build_tiles.py already made (no raw data needed): each tile's ground.png, surface.bin (ponds) and
tile.json (roads, trails, buildings). Drawn at 2 m/px, then shrunk to OUT_MPP so lines are smooth.

  .venv/bin/python tools/build_minimap.py      (~20 s)
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'game' / 'assets'
DRAW_MPP, OUT_MPP = 2.0, 4.0
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
W, H = int((ex1 - ex0) / DRAW_MPP), int((ez1 - ez0) / DRAW_MPP)
img = Image.new('RGB', (W, H), (60, 90, 50))
tile_px = int(T / DRAW_MPP)


def px(x, z):
    return ((x - ex0) / DRAW_MPP, (z - ez0) / DRAW_MPP)


tiles = []
for tx, tz in world['tiles']:
    d = ASSETS / 'tiles' / f'{tx}_{tz}'
    x0, z0 = tx * T - T / 2, tz * T - T / 2
    ground = np.asarray(Image.open(d / 'ground.png').convert('RGB').resize((tile_px, tile_px), Image.LANCZOS)).copy()
    surf = np.fromfile(d / 'surface.bin', np.uint8).reshape(T, T)
    step = int(DRAW_MPP)
    wet = surf[::step, ::step][:tile_px, :tile_px] == 5            # pond bed
    ground[wet] = WATER
    img.paste(Image.fromarray(ground), (int((x0 - ex0) / DRAW_MPP), int((z0 - ez0) / DRAW_MPP)))
    tiles.append(json.loads((d / 'tile.json').read_text()))

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

out = img.resize((int(W * DRAW_MPP / OUT_MPP), int(H * DRAW_MPP / OUT_MPP)), Image.LANCZOS)
dst = ASSETS / 'minimap.jpg'
out.save(dst, quality=84, optimize=True)
meta = {'extent': world['extent'], 'mpp': OUT_MPP, 'size': list(out.size)}
(ASSETS / 'minimap.json').write_text(json.dumps(meta))
print(dst, out.size, f'{dst.stat().st_size / 1e6:.2f} MB')
