"""Feather baked ground colours across shared tile borders, with bounded memory.

The palette, surface masks and independent tile noise can all introduce a step,
even where the overlapping source NAIP pixels agree. Blend the final colours.
Two separable passes join the low-frequency colours at corners too. Only the
outer 64 pixels change; geometry and surface classes are untouched. Sharp natural
features remain distinct rather than being mirrored across a border. Inputs must
be lossless PNGs.
"""
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter1d
import tilefmt


def blend_edge(image, neighbour, axis, end, width=64):
    """Fade a shared edge-colour correction inwards without reflecting features."""
    a = np.swapaxes(image, 0, axis)
    b = np.swapaxes(neighbour, 0, axis)
    width = min(width, len(a) // 2)
    weight = (.5 * (1 - np.arange(width) / (width - 1)))[:, None, None]
    if end:
        own, other_edge = a[-width:][::-1], b[0]
    else:
        own, other_edge = a[:width], b[-1]
    correction = other_edge.astype(float) - own[0].astype(float)
    # Palette boundaries/individual trees can cross between the two edge pixels.
    # Correct gradual colour differences, not those real high-frequency features.
    correction = gaussian_filter1d(correction, 8, axis=0, mode='nearest')
    own[:] = np.clip(np.rint(own + weight * correction), 0, 255).astype(np.uint8)


def feather(tiles_dir, tiles, packed=False, width=64, log=print):
    root = Path(tiles_dir)
    keys = set(map(tuple, tiles))
    load = lambda path: np.array(Image.open(path).convert('RGB'))
    def source(x, z):
        if (x, z) in keys:
            return load(root / f'{x}_{z}/ground.png')
        # Extend the irregular map boundary using the nearest real tile's edge.
        # Both sides of a three-tile corner must see the SAME missing neighbour;
        # skipping it on only one side would reintroduce a seam in the z-pass.
        nx, nz = min(keys, key=lambda k: ((k[0] - x) ** 2 + (k[1] - z) ** 2, k))
        a = load(root / f'{nx}_{nz}/ground.png')
        h, w = a.shape[:2]
        rows = np.clip(np.arange(h) + (z - nz) * h, 0, h - 1)
        cols = np.clip(np.arange(w) + (x - nx) * w, 0, w - 1)
        return a[rows[:, None], cols]
    # Keep the x-pass immutable while doing the z-pass, independent of tile order.
    with TemporaryDirectory(prefix='.ground-seams-', dir=root.parent) as tmp:
        tmp = Path(tmp)
        extended = keys | {(x, z + dz) for x, z in keys for dz in (-1, 1)}
        log(f'ground colours: joining {len(keys)} tiles, {width}-pixel feather')
        for index, (tx, tz) in enumerate(sorted(extended), 1):
            a = source(tx, tz)
            for dx in (-1, 1):
                blend_edge(a, source(tx + dx, tz), 1, dx > 0, width)
            Image.fromarray(a).save(tmp / f'{tx}_{tz}.png')
            if index % 128 == 0:
                log(f'ground colours: horizontal pass {index}/{len(extended)}')
        for index, (tx, tz) in enumerate(sorted(keys), 1):
            a = load(tmp / f'{tx}_{tz}.png')
            for dz in (-1, 1):
                b = load(tmp / f'{tx}_{tz + dz}.png')
                blend_edge(a, b, 0, dz > 0, width)
            out = root / f'{tx}_{tz}'
            tilefmt.write_ground(out, Image.fromarray(a), packed)
            if packed:
                (out / 'ground.png').unlink()
            if index % 128 == 0:
                log(f'ground colours: vertical pass {index}/{len(keys)}')
    log(f'ground colours: {len(keys)} tiles feathered across {width} pixels per shared edge')
