"""Measure decoded RGB jumps across every shared ground-picture border.

Usage: python tools/ground_seam_audit.py ASSETS [--report report.json]
Run through the heavy gate for a full map. Geometry seams have a separate Node test.
"""
import argparse
import json
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter1d


def audit(assets):
    assets = Path(assets)
    world = json.loads((assets / 'world.json').read_text())
    keys = set(map(tuple, world['tiles']))
    edges = {}
    for x, z in sorted(keys):
        folder = assets / 'tiles' / f'{x}_{z}'
        with Image.open(folder / ('ground.webp' if world.get('packed') else 'ground.png')) as im:
            a = np.asarray(im.convert('RGB'), dtype=np.int16)
            edges[x, z] = [a[:, 0].copy(), a[:, -1].copy(), a[0].copy(), a[-1].copy()]
    rows = []
    for x, z in sorted(keys):
        for dx, dz, end, start in [(1, 0, 1, 0), (0, 1, 3, 2)]:
            if (x + dx, z + dz) not in keys:
                continue
            delta = edges[x, z][end] - edges[x + dx, z + dz][start]
            difference = np.abs(delta)
            rows.append({'a': [x, z], 'b': [x + dx, z + dz],
                         'mean_rgb_jump': float(difference.mean()), 'max_rgb_jump': int(difference.max()),
                         'low_frequency_rgb_jump': float(np.abs(gaussian_filter1d(delta.astype(float), 8, axis=0)).mean())})
    return {'tiles': len(keys), 'borders': len(rows),
            'mean_rgb_jump': float(np.mean([r['mean_rgb_jump'] for r in rows])),
            'low_frequency_rgb_jump': float(np.mean([r['low_frequency_rgb_jump'] for r in rows])),
            'worst': sorted(rows, key=lambda r: r['mean_rgb_jump'], reverse=True)[:20]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('assets')
    parser.add_argument('--report')
    args = parser.parse_args()
    report = audit(args.assets)
    print(json.dumps(report, indent=2))
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
