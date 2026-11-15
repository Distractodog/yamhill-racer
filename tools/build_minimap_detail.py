"""Bake sharp 1 m/pixel close-up maps from existing world tiles (no terrain rebuild)."""
import json
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
import tilefmt
from imagecodec_v3 import encode_detail
from campusmap_v3 import paint_track
from minimap_roads import paint_roads

ROAD = {
    'asphalt': ((65, 70, 79), (245, 245, 235), 14),
    'gravel': ((226, 209, 169), (112, 96, 69), 10),
    'trail': ((218, 151, 83), (103, 65, 31), 8),
}

def bake_detail(world, assets, tx, tz):
    size = world['tile']
    folder = assets / 'tiles' / f'{tx}_{tz}'
    tile = tilefmt.read_json(folder)
    x0, z0 = tx*size-size/2, tz*size-size/2
    def px(p): return p[0]-x0, p[1]-z0
    ground = np.asarray(tilefmt.read_ground(folder).resize((size,size), Image.Resampling.LANCZOS)).copy()
    surface = np.frombuffer(tilefmt.read_bytes(folder,'surface.bin'), np.uint8).reshape(size,size)
    ground[surface == 5] = (86,150,205)
    img = Image.fromarray(ground)
    draw = ImageDraw.Draw(img)
    for building in tile['buildings']:
        draw.polygon([px(p) for p in building['pts']],fill=(210,206,198),outline=(105,101,95),width=1)
    paint_roads(draw, [tile], px, 1, ROAD)
    paint_track(img, x0, z0, 1)
    return img


def bake_details(world, assets):
    size = world['tile']
    dst = assets / 'minimap-detail'
    dst.mkdir(exist_ok=True)
    total = 0
    for tx, tz in world['tiles']:
        img = bake_detail(world, assets, tx, tz)
        path = dst / f'{tx}_{tz}.webp'
        path.write_bytes(encode_detail(img))
        total += path.stat().st_size
    print(f'Detailed minimap: {len(world["tiles"])} tiles, {total/1e6:.1f} MB, 1 m/pixel',flush=True)
    return {'tile':size,'mpp':1,'path':'minimap-detail/','tiles':world['tiles']}

if __name__ == '__main__':
    assets = Path(__file__).resolve().parents[1] / 'game/assets'
    world = json.loads((assets/'world.json').read_text())
    details = bake_details(world,assets)
    meta = json.loads((assets/'minimap.json').read_text())
    meta['detail'] = details
    (assets/'minimap.json').write_text(json.dumps(meta))
