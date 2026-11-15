#!/usr/bin/env python3
"""Inventory shallow shared-node road meets; no network or tile mutation.

python3 tools/ramp_audit.py --raw <raw-directory> --json /tmp/ramps-audit.json
Angles use the first noncoincident OSM segment on each arm (outward from node).
If the cache omits node IDs, exact geometry coordinates are explicitly marked
as surrogates; no shared-node topology is claimed for those rows.
Rows are unique node/main-way/branch-way pairs, not unique physical interchanges.
"""
import argparse
from collections import Counter, defaultdict
from itertools import combinations
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLASSES = 'motorway trunk primary secondary tertiary unclassified residential living_street service track'.split()
TYPES = ('diverge / exit', 'merge / on-ramp', 'Y-split')


def oneway(tags):
    value = tags.get('oneway', '')
    if value == '-1':
        return -1
    if value in ('yes', '1', 'true') or (value not in ('no', '0', 'false') and
            (tags.get('junction') == 'roundabout' or tags.get('highway') == 'motorway')):
        return 1
    return 0


def road_info(way):
    tags = way['tags']
    return dict(way=way['id'], highway=tags['highway'], name=tags.get('name', '(unnamed)'),
                ref=tags.get('ref', ''), oneway=oneway(tags), lanes=tags.get('lanes', 'unknown'),
                lanes_forward=tags.get('lanes:forward', 'unknown'),
                lanes_backward=tags.get('lanes:backward', 'unknown'))


def arms(way, index):
    """(unit outward vector, legal incoming, legal outgoing) at every arm."""
    p = way['points'][index]
    direction = oneway(way['tags'])
    for step in (-1, 1):
        j = index + step
        while 0 <= j < len(way['points']):
            q = way['points'][j]
            dx, dz = q[0] - p[0], q[1] - p[1]
            length = math.hypot(dx, dz)
            if length > 0.01:
                yield ((dx / length, dz / length), direction == 0 or direction == -step,
                       direction == 0 or direction == step)
                break
            j += step


def audit(raw, manifest):
    extent = json.loads((raw / 'naip_info.json').read_text())['extent']
    cx = (extent['xmin'] + extent['xmax']) / 2
    cy = (extent['ymin'] + extent['ymax']) / 2
    radius = 6378137.0
    lat = 2 * math.atan(math.exp(cy / radius)) - math.pi / 2
    scale = math.cos(lat)

    def project(q):
        mx = radius * math.radians(q['lon'])
        my = radius * math.log(math.tan(math.pi / 4 + math.radians(q['lat']) / 2))
        return ((mx - cx) * scale, (cy - my) * scale)

    world = json.loads(manifest.read_text())
    tiles = {tuple(t) for t in world['tiles']}
    size = world['tile']
    def in_map(p):
        return (math.floor(p[0] / size + .5), math.floor(p[1] / size + .5)) in tiles

    elements = json.loads((raw / 'osm_region.json').read_text())['elements']
    roads, nodes = [], defaultdict(list)
    incomplete = 0
    for e in elements:
        tags = e.get('tags', {})
        if e.get('type') != 'way' or tags.get('highway', '').removesuffix('_link') not in CLASSES:
            continue
        if not e.get('geometry') or (e.get('nodes') and len(e['geometry']) != len(e['nodes'])):
            incomplete += 1
            continue
        e['points'] = [project(q) for q in e['geometry']]
        # This Overpass cache uses out geom without node IDs. Never proximity-snap.
        e['nodes'] = [str(n) for n in e['nodes']] if e.get('nodes') else [
            f"coord:{q['lat']:.7f},{q['lon']:.7f}" for q in e['geometry']]
        roads.append(e)
        for i, (node, p) in enumerate(zip(e['nodes'], e['points'])):
            if in_map(p):
                nodes[node].append((e, i))

    rows = []
    for node, members in sorted(nodes.items()):
        for (a, ai), (b, bi) in combinations(members, 2):
            if a['id'] == b['id']:
                continue
            al = a['tags']['highway'].endswith('_link')
            bl = b['tags']['highway'].endswith('_link')
            if not ((al != bl) or any(w['tags'].get('junction') or oneway(w['tags']) for w in (a, b))):
                continue
            # Prefer a non-link road, then the higher class, then a through way.
            def rank(w, i):
                h = w['tags']['highway']
                return (h.endswith('_link'), CLASSES.index(h.removesuffix('_link')),
                        not (0 < i < len(w['nodes']) - 1), w['id'])
            if rank(b, bi) < rank(a, ai):
                a, b, ai, bi = b, a, bi, ai
            matches = []
            for ma in arms(a, ai):
                for ba in arms(b, bi):
                    dot = sum(u * v for u, v in zip(ma[0], ba[0]))
                    angle = math.degrees(math.acos(max(-1, min(1, dot))))
                    if angle < 30:
                        matches.append((angle, ma, ba))
            if not matches:
                continue
            angle, ma, ba = min(matches)
            incoming, outgoing = ba[1:]
            typ = TYPES[0] if outgoing and not incoming else TYPES[1] if incoming and not outgoing else TYPES[2]
            # Main travel is away from meet for exit, toward meet for merge.
            travel = ma[0] if typ != TYPES[1] else tuple(-v for v in ma[0])
            legal = ma[2] if typ != TYPES[1] else ma[1]
            side = ba[0][0] * travel[1] - ba[0][1] * travel[0]
            x, z = a['points'][ai]
            rows.append(dict(node=node, x=round(x, 2), z=round(z, 2), main=road_info(a),
                ramp=road_info(b), angle=round(angle, 2), type=typ,
                direction='both' if incoming and outgoing else 'into meet' if incoming else 'away from meet',
                side='left' if side > 0 else 'right', main_travel=list(travel),
                legal_main_travel=legal,
                approach=[round(x - travel[0] * 32, 2), round(z - travel[1] * 32, 2)],
                yaw=math.atan2(travel[0], travel[1]),
                detection='link' if al != bl else 'junction/oneway',
                verdict='NOT VERIFIED — awaiting driver and overhead PNG review'))
    # A node pair may occur twice on closed ways; keep its sharpest shallow arm.
    unique = {}
    for row in rows:
        key = (row['node'], row['main']['way'], row['ramp']['way'])
        if key not in unique or row['angle'] < unique[key]['angle']:
            unique[key] = row
    rows = list(unique.values())
    for row in rows:
        row['nearby_merge'] = None
        if row['type'] == TYPES[0]:
            candidates = [r for r in rows if r['type'] == TYPES[1] and
                (r['main']['name'], r['main']['ref']) == (row['main']['name'], row['main']['ref']) and
                sum(a * b for a, b in zip(r['main_travel'], row['main_travel'])) > .5]
            if candidates:
                near = min(candidates, key=lambda r: math.hypot(row['x'] - r['x'], row['z'] - r['z']))
                row['nearby_merge'] = dict(node=near['node'], distance_m=round(math.hypot(row['x'] - near['x'], row['z'] - near['z']), 1))
        m = row['main']
        row['owner_candidate'] = (row['type'] == TYPES[0] and row['legal_main_travel'] and m['oneway'] == 0 and
            ('18' in m['ref'].replace(';', ' ').split() or 'OR 18' in m['ref']) and
            row['nearby_merge'] is not None)
    def order(row):
        return (not row['owner_candidate'], row['side'] != 'left' if row['owner_candidate'] else False, row['main']['lanes'] != '2',
                (row['nearby_merge'] or {}).get('distance_m', float('inf')) if row['owner_candidate'] else 0,
                row['x'], row['z'], row['node'], row['main']['way'], row['ramp']['way'])
    rows.sort(key=order)
    for i, row in enumerate(rows, 1):
        row['id'] = f'RJ-{i:03d}'
        row['screenshots'] = dict(driver=f"{row['id']}-driver.png", overhead=f"{row['id']}-overhead.png")
    return dict(schema=1, tile_count=len(tiles), road_way_count=len(roads),
        in_map_link_way_count=sum(w['tags']['highway'].endswith('_link') and any(in_map(p) for p in w['points']) for w in roads),
        incomplete_road_ways=incomplete, node_identity='exact-coordinate surrogate where node IDs absent', counts=dict(Counter(r['type'] for r in rows)), rows=rows)


def markdown(data):
    lines = ['# Ramp / merge / split audit', '',
        'OSM geometry inventory for the current world manifest. The director accepts this geometry-based audit because no newer OSM export with node IDs exists. Visual review is pending; no screenshot was run by this worker.', '',
        f"Manifest scope: **{data['tile_count']} tiles**, {data['road_way_count']} source road ways, "
        f"{data['in_map_link_way_count']} link ways with a vertex in-map; {data['incomplete_road_ways']} incomplete road geometries skipped.", '',
        '| Type | Meets |', '|---|---:|']
    lines += [f"| {t} | {data['counts'].get(t, 0)} |" for t in TYPES]
    lines += [f"| Total | {len(data['rows'])} |", '', '## Owner’s spot: closest candidates, not visually confirmed', '']
    candidates = [r for r in data['rows'] if r['owner_candidate']][:3]
    for r in candidates:
        m, merge = r['main'], r['nearby_merge']
        lines.append(f"- **{r['id']}**, ({r['x']}, {r['z']}), shared vertex {r['node']}: {m['name']} ({m['ref']}), "
            f"two-way, lanes={m['lanes']}; {r['angle']}° {r['side']} exit, nearest same-name/ref, similarly directed merge {merge['distance_m']} m away "
            f"(shared vertex {merge['node']}). " + ('Two total lanes supports one each way; **right exit, so it fails the requested left-exit detail**.' if m['lanes'] == '2' else
            'Lane count does not establish one lane each way; weaker candidate.'))
    lines += ['', '**Requested left exit not found in the supplied cache.** The director will ask the owner to locate that spot. These are the closest right-exit alternatives. Row 1 is the strongest geometry/tag candidate, not a confirmed identification of the owner’s screenshot. '
        'Proximity is straight-line distance with main travel headings within 60°, not proof that the merge feeds the same carriageway or travel direction.', '',
        '## Method and limitations', '',
        '- The supplied OSM cache has no node IDs (only way geometry). Shared vertices are exact 7-decimal latitude/longitude keys (`coord:lat,lon`), not invented OSM node IDs. Coincident but topologically distinct nodes cannot be distinguished: shared-node topology remains unproven, and the director accepts this exact-coordinate method for RJ-0. No distance tolerance is used.',
        '- The cache contains only 42 link ways (30 trunk, 8 tertiary, 2 primary, 2 secondary), fewer than the brief’s older 66-way inventory. Iterating all 468 manifest tiles does not establish that this cache covers them: the known western Hwy 18 examples are absent. Source completeness remains a limitation of the accepted audit; no newer export is available.',
        '- Projection matches `build_tiles.py`: Mercator minus the NAIP extent centre, scaled by cosine of the centre latitude; z points south.',
        '- Use the actual manifest tile union, not its bounding rectangle. All source road ways remain available for shared-node topology; only meets inside a tile are emitted.',
        '- Match the builder’s drivable highway classes. A pair qualifies when exactly one way is `_link`, or either way has `junction=*` or legal one-way travel. Link/link and non-link pairs can therefore enter through the second rule.',
        '- Measure outward arm angle using the first noncoincident OSM segment: strictly less than 30°. One row per shared node/main-way/branch-way pair; choose the smallest angle. This includes branch meets at interior way nodes.',
        '- Main road: non-link first, then highway class, then interior/through way. Classify branch travel away as exit, toward as merge, and bidirectional as Y-split. `oneway=-1`, roundabouts and implicit motorway one-way are handled. Classification describes OSM travel, not observed game markings.',
        '- Left/right is relative to the inferred main travel for that branch. `legal_main_travel=false` flags an incompatible main arm; these rows remain in the fixed test set but cannot rank as owner candidates.',
        '- Unknown lanes remain unknown. Two total lanes on a two-way road is candidate evidence, not proof of a lane in each direction. No geographic crossing without a shared node is invented as a junction.',
        '- Known builder issue: `_link` is stripped before width/class assignment; trunk links inherit 17 m width. The current visual state, gore, tapers and line overlap require PNG review.', '',
        '## Run and review', '', '```sh',
        'python3 tools/ramp_audit.py --raw <main-checkout>/data/raw --json /tmp/ramps-audit.json',
        '# Director: reuse the game server at 127.0.0.1:8173, then run behind the machine-wide heavy gate:',
        'node tools/ramp_shots.mjs /tmp/ramps-audit.json /tmp/ramp-shots', '```', '',
        'The script writes driver and overhead PNGs for every row plus `results.json` (page errors, frame timings, failures). '
        'Optional `--ids RJ-001,RJ-002` selects rows; `YR_URL` overrides the default game server URL. Startup clicks the spawn map when blocked and waits until spawn selection completes before capturing views. Update each verdict after opening both PNGs. '
        'The worker only syntax-checked this script; screenshot coverage, page errors, FPS and visual verdicts are **NOT VERIFIED**.', '',
        'Survey frame timings include the extra camera/streaming override and are diagnostic only, not a game performance baseline.', '',
        '## Fixed test set', '',
        '| ID / shared vertex | x, z (m) | Main way: class; name/ref; direction; lanes | Ramp way / class; travel | Angle / side | Type | PNGs (in output folder) | Verdict |',
        '|---|---|---|---|---|---|---|---|']
    for r in data['rows']:
        m, b = r['main'], r['ramp']
        direction = 'two-way' if m['oneway'] == 0 else 'one-way reverse OSM' if m['oneway'] == -1 else 'one-way OSM'
        cells = [f"{r['id']} / {r['node']}", f"{r['x']}, {r['z']}",
            f"{m['way']}: {m['highway']}; {m['name']} {m['ref']}; {direction}; {m['lanes']} (fwd {m['lanes_forward']}, back {m['lanes_backward']})",
            f"{b['way']} / {b['highway']}; {r['direction']} (oneway={b['oneway']})",
            f"{r['angle']}° / {r['side']}" + ('' if r['legal_main_travel'] else ' (main direction conflict)'), r['type'],
            ', '.join(r['screenshots'].values()), r['verdict']]
        lines.append('| ' + ' | '.join(str(c).replace('|', '\\|') for c in cells) + ' |')
    return '\n'.join(lines) + '\n'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--raw', type=Path, default=ROOT / 'data/raw')
    p.add_argument('--world', type=Path, default=ROOT / 'game/assets/world.json')
    p.add_argument('--json', type=Path, required=True)
    p.add_argument('--markdown', type=Path, default=ROOT / 'docs/research/ramps-audit.md')
    args = p.parse_args()
    if args.json.resolve().is_relative_to(ROOT):
        p.error('--json must be outside the repository')
    data = audit(args.raw, args.world)
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(data, indent=2) + '\n')
    args.markdown.parent.mkdir(parents=True, exist_ok=True)
    args.markdown.write_text(markdown(data))
    print(json.dumps({k: v for k, v in data.items() if k != 'rows'}, indent=2))
    print('Top candidates:', [(r['id'], r['node'], r['nearby_merge']) for r in data['rows'] if r['owner_candidate']][:3])


if __name__ == '__main__':
    main()
