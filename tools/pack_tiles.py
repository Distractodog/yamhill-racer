"""Packs a built assets folder (see tools/tilefmt.py for the formats): tiles get ~3-5x smaller, arrays byte-identical.

  .venv/bin/python tools/pack_tiles.py game/assets ../yr-assets-packed

Copies everything else in the assets folder unchanged and adds "packed": 1 to world.json. Works one tile at a time and
one file at a time, so memory stays small (~50 MB) whatever the number of tiles. Prints sizes before and after.
"""
import json, os, shutil, sys, time
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tilefmt


def du(path):
    return sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs)


def pack_tile(src, dst):
    os.makedirs(dst, exist_ok=True)
    for name in ('height.bin', 'surface.bin', 'ponds.bin', 'tile.json', 'trees.bin'):
        tilefmt.write_bytes(dst, name, tilefmt.read_bytes(src, name))
    with Image.open(os.path.join(src, 'ground.png')) as im:
        tilefmt.write_ground(dst, im.convert('RGB'))


def main(src, dst):
    if os.path.abspath(src) == os.path.abspath(dst): sys.exit('pack into a different folder')
    os.makedirs(dst, exist_ok=True)
    # everything except the tiles and world.json: copied as is
    for name in sorted(os.listdir(src)):
        if name in ('tiles', 'world.json'): continue
        s, d = os.path.join(src, name), os.path.join(dst, name)
        if os.path.isdir(s): shutil.copytree(s, d, dirs_exist_ok=True)
        else: shutil.copy2(s, d)
    world = json.load(open(os.path.join(src, 'world.json')))
    t0, before, after = time.time(), 0, 0
    for i, (tx, tz) in enumerate(world['tiles']):
        s, d = os.path.join(src, 'tiles', f'{tx}_{tz}'), os.path.join(dst, 'tiles', f'{tx}_{tz}')
        if tilefmt.is_packed(s): sys.exit(f'{s} is already packed')
        pack_tile(s, d)
        b, a = du(s), du(d); before += b; after += a
        print(f'[{time.time() - t0:5.0f}s] {i + 1}/{len(world["tiles"])} tile {tx},{tz}: {b / 1e6:.2f} -> {a / 1e6:.2f} MB', flush=True)
    world['packed'] = tilefmt.PACKED
    json.dump(world, open(os.path.join(dst, 'world.json'), 'w'), indent=1)
    n = len(world['tiles'])
    print(f'tiles: {before / 1e6:.0f} MB -> {after / 1e6:.0f} MB ({before / max(after, 1):.1f}x smaller), '
          f'{after / n / 1e6:.2f} MB per tile on average')


if __name__ == '__main__':
    if len(sys.argv) != 3: sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
