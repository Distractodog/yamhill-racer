"""Bake a small road-only routing graph from existing tiles; no terrain rebuild.
Run after a tile rebuild: python3 tools/build_navigation.py
Connections follow challenge_routes.py's tile seams and junction pieces.
"""
import gzip
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
assets = ROOT / 'game/assets'
manifest = json.loads((assets / 'world.json').read_text())
nodes, edges, ends, junctions = [], [], [], []
def node(p, y=0):
    nodes.append([round(p[0], 2), round(p[1], 2), round(y, 2)])
    return len(nodes) - 1
def simplify(points, heights):
    # Keep bends and height changes within 0.5 m; preserve exact strip ends.
    keep = {0, len(points)-1}
    stack = [(0, len(points)-1)]
    while stack:
        a,b = stack.pop()
        ax,az = points[a]; bx,bz = points[b]
        dx,dz = bx-ax,bz-az; length2 = dx*dx+dz*dz
        best, index = 0.5, None
        for i in range(a+1,b):
            x,z = points[i]
            t = max(0,min(1,((x-ax)*dx+(z-az)*dz)/length2)) if length2 else 0
            error = max(math.hypot(x-ax-t*dx,z-az-t*dz), abs(heights[i][0]-heights[a][0]-t*(heights[b][0]-heights[a][0])))
            if error > best: best,index = error,i
        if index is not None:
            keep.add(index); stack.extend(((a,index),(index,b)))
    return sorted(keep)
for tx, tz in manifest['tiles']:
    folder = assets / 'tiles' / f'{tx}_{tz}'
    path = folder / 'tile.json'
    t = json.loads(path.read_bytes() if path.exists() else gzip.decompress((folder / 'tile.json.gz').read_bytes()))
    for road in t['paths']:
        if road['kind'] not in ('asphalt', 'gravel') or len(road['pts']) < 2:
            continue
        ids = [node(road['pts'][i], road['yc'][i][0]) for i in simplify(road['pts'], road['yc'])]
        edges.extend([a, b, road['w']] for a, b in zip(ids, ids[1:]))
        ends.extend((ids[0], ids[-1]))
    for j in t['junctions']:
        if j['kind'] in ('asphalt', 'gravel'):
            junctions.append((node(j['c'], j['c'][2]), max(math.dist(j['c'][:2], p[:2]) for p in j['ring'])))
# Index strip ends so baking remains fast as the map expands.
bins = {}
for n in ends:
    x, z, _ = nodes[n]
    bins.setdefault((math.floor(x / 40), math.floor(z / 40)), []).append(n)
def nearby(n, radius):
    x, z, y = nodes[n]
    for bx in range(math.floor((x-radius)/40), math.floor((x+radius)/40)+1):
        for bz in range(math.floor((z-radius)/40), math.floor((z+radius)/40)+1):
            for m in bins.get((bx,bz), []):
                if m != n and math.dist(nodes[m][:2], [x,z]) <= radius and abs(nodes[m][2]-y) < 3:
                    yield m
for n in ends:
    edges.extend([n,m,0] for m in nearby(n,2.5) if m > n)
for n, radius in junctions:
    edges.extend([n,m,min(10,radius*2)] for m in nearby(n,radius+3))
# Never route beyond the playable circular wall. Clip boundary-crossing roads.
rim = manifest.get('rim')
if rim:
    clipped = []
    radius = rim['r'] - 8  # leave room for a vehicle at the wall
    for a, b, width in edges:
        pa, pb = nodes[a], nodes[b]
        dx, dz = pb[0]-pa[0], pb[1]-pa[1]
        ox, oz = pa[0]-rim['cx'], pa[1]-rim['cz']
        aa = dx*dx+dz*dz; bb = 2*(ox*dx+oz*dz); cc = ox*ox+oz*oz-radius*radius
        if aa < 1e-12:
            if cc <= 0: clipped.append([a,b,width])
            continue
        disc = bb*bb-4*aa*cc
        if disc < 0: continue
        lo = max(0,(-bb-math.sqrt(disc))/(2*aa)); hi = min(1,(-bb+math.sqrt(disc))/(2*aa))
        if hi <= lo: continue
        if lo > 0: a = node([pa[0]+lo*dx,pa[1]+lo*dz],pa[2]+lo*(pb[2]-pa[2]))
        if hi < 1: b = node([pa[0]+hi*dx,pa[1]+hi*dz],pa[2]+hi*(pb[2]-pa[2]))
        clipped.append([a,b,width])
    edges = clipped
output = assets / 'navigation.json'
output.write_text(json.dumps({'nodes': nodes, 'edges': edges}, separators=(',',':'))+'\n')
print(f'{len(nodes)} nodes, {len(edges)} edges, {output.stat().st_size:,} bytes')
