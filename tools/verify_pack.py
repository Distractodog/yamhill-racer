"""Checks a packed assets folder against the unpacked one it came from (see tools/tilefmt.py).

  .venv/bin/python tools/verify_pack.py game/assets ../yr-assets-packed [tx,tz ...]      (default: every tile)

Per tile: heights, surface, ponds, trees and tile.json must be byte-identical after unpacking; the ground picture is
JPEG, so it prints the mean / max colour difference (0-255 per channel). One tile at a time (low memory).
Exits 1 if any array differs.
"""
import json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import tilefmt


def main(src, dst, only):
    world = json.load(open(os.path.join(dst, 'world.json')))
    if world.get('packed') not in (1, 2):
        sys.exit('world.json must specify supported packed version 1 or 2')
    tiles = [tuple(map(int, t.split(','))) for t in only] if only else [tuple(t) for t in world['tiles']]
    bad, means = 0, []
    for tx, tz in tiles:
        s, d = os.path.join(src, 'tiles', f'{tx}_{tz}'), os.path.join(dst, 'tiles', f'{tx}_{tz}')
        diffs = [n for n in ('height.bin', 'surface.bin', 'ponds.bin', 'trees.bin', 'tile.json')
                 if tilefmt.read_bytes(s, n) != tilefmt.read_bytes(d, n)]
        a = np.asarray(tilefmt.read_ground(s), np.int16); b = np.asarray(tilefmt.read_ground(d), np.int16)
        g = np.abs(a - b); means.append(g.mean())
        print(f'tile {tx},{tz}: arrays {"IDENTICAL" if not diffs else "DIFFER: " + ", ".join(diffs)} · '
              f'ground diff mean {g.mean():.2f} max {g.max()} (99.9% of pixels <= {np.percentile(g, 99.9):.0f})', flush=True)
        bad += bool(diffs)
        del a, b, g
    print(f'{len(tiles)} tiles checked, {bad} with differing arrays, ground mean diff {np.mean(means):.2f}')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    if len(sys.argv) < 3: sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
