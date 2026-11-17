"""Check that each fixed jump ramp's footprint avoids bridges, tapers and gores.

python tools/fixed_ramp_test.py [assets]
"""
import json
import math
from pathlib import Path
import sys

from shapely.geometry import LineString, Polygon
from shapely.ops import substring
import tilefmt


def check(assets):
    assets = Path(assets)
    world = json.loads((assets / 'world.json').read_text())
    ramps = json.loads((assets / 'ramps.json').read_text())
    failures = []
    for ramp in ramps:
        x, z, yaw, width = (ramp[k] for k in ('x', 'z', 'yaw', 'w'))
        footprint = LineString([(x, z), (x + math.sin(yaw) * 31, z + math.cos(yaw) * 31)]).buffer(width / 2, cap_style=2)
        checked = 0
        for tx, tz in world['tiles']:
            if abs(tx * 2000 - x) > 1100 or abs(tz * 2000 - z) > 1100:
                continue
            checked += 1
            tile = tilefmt.read_json(assets / 'tiles' / f'{tx}_{tz}')
            for p in tile['physPaths']:
                line = LineString([q[:2] for q in p['pts']])
                regions = []
                if p.get('bridge'):
                    regions.append(('bridge', line.buffer(p['w'] / 2)))
                for side, lo, hi, w0, w1 in p.get('widen', []):
                    regions.append(('taper', substring(line, lo, hi).buffer(p['w'] / 2 + max(w0, w1))))
                for kind, region in regions:
                    if footprint.intersects(region):
                        failures.append(f"{ramp['name']}: overlaps {kind} in {tx}_{tz}")
            for j in tile['physJunctions']:
                if j.get('gore') and footprint.intersects(Polygon([q[:2] for q in j['ring']])):
                    failures.append(f"{ramp['name']}: overlaps gore in {tx}_{tz}")
        if not checked:
            failures.append(f"{ramp['name']}: no tile coverage")
    if failures:
        raise AssertionError('\n'.join(failures))
    print(f'PASS: {len(ramps)} fixed ramp footprints avoid bridges, tapers and gores')


if __name__ == '__main__':
    check(sys.argv[1] if len(sys.argv) > 1 else 'game/assets')
