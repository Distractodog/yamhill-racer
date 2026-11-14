"""Compact v3 geometry; preserve flags, widths, topology and pond levels.

yc[0] is a height (centimetres), yc[1] a cross-slope (0.001). The
encoder checks their combined error over the complete road width, rather
than incorrectly comparing the dimensionless slope with a height tolerance.
"""
import copy
import json
import math


def number(value, places):
    if not math.isfinite(value):
        raise ValueError('Nonfinite geometry')
    n = round(value, places)
    return int(n) if n == int(n) else n


def compact(tile):
    out = copy.deepcopy(tile)
    for b in out.get('buildings', []):
        b['pts'] = [[number(x, 2), number(z, 2)] for x, z in b['pts']]
        b['h'] = number(b['h'], 2)
    for key in ('paths', 'physPaths'):
        for road in out.get(key, []):
            road['pts'] = [[number(x, 2), number(z, 2)] for x, z in road['pts']]
            if 'yc' in road:
                yc = []
                for y, c in road['yc']:
                    yy, cc = number(y, 2), number(c, 3)
                    if abs(y-yy)+road['w']/2*abs(c-cc) > .01:
                        # Wider future roads retain source precision when the
                        # proposed rounding cannot meet the physics bound.
                        yy, cc = y, c
                    yc.append([yy, cc])
                road['yc'] = yc
    for key in ('junctions', 'physJunctions'):
        for j in out.get(key, []):
            j['c'] = [number(v, 2) for v in j['c']]
            j['ring'] = [[*(number(v, 2) for v in p[:3]), *p[3:]] for p in j['ring']]
    return out


def encode(tile):
    return json.dumps(compact(tile), separators=(',', ':'), ensure_ascii=False, allow_nan=False).encode('utf-8')
