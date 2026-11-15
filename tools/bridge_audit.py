#!/usr/bin/env python3
"""Inventory bridge risks; no game assets are read or modified.

Requires Shapely >= 2. Use --osm with a read-only raw export and --json with
an output outside the repository. Projection metadata defaults beside the OSM.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
TYPES = ('river bridge', 'creek bridge', 'overpass', 'underpass', 'rail', 'culvert-only')
ROAD_CLASSES = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
                'unclassified', 'residential', 'service', 'track', 'living_street'}


def active(value):
    return value is not None and str(value).lower() not in ('no', 'false', '0', '')


def layer(tags):
    try:
        return float(tags.get('layer', 0))
    except (ValueError, TypeError):
        return None


def tagged(tags):
    return active(tags.get('bridge')) or active(tags.get('tunnel')) or layer(tags) != 0


def point_parts(geometry):
    if geometry.geom_type == 'Point':
        return [geometry]
    if geometry.geom_type in ('MultiPoint', 'GeometryCollection'):
        return [p for g in geometry.geoms for p in point_parts(g)]
    return []


def line_parts(geometry):
    if geometry.geom_type == 'LineString':
        return [geometry] if geometry.length else []
    if hasattr(geometry, 'geoms'):
        return [p for g in geometry.geoms for p in line_parts(g)]
    return []


def label(way):
    t = way['tags']
    return t.get('name') or t.get('ref') or f"unnamed {t.get('highway') or t.get('waterway') or t.get('railway') or 'way'}"


def audit(osm, world, info):
    # Same Web Mercator -> local metre projection as build_tiles.lonlat_to_world.
    e = info['extent']
    cx, cy = (e['xmin'] + e['xmax']) / 2, (e['ymin'] + e['ymax']) / 2
    radius = 6378137.0
    lat_c = 2 * math.atan(math.exp(cy / radius)) - math.pi / 2
    k = math.cos(lat_c)

    def project(q):
        mx = radius * math.radians(q['lon'])
        my = radius * math.log(math.tan(math.pi / 4 + math.radians(q['lat']) / 2))
        return (mx - cx) * k, (cy - my) * k

    size = world['tile']
    region = unary_union([box(tx * size - size / 2, tz * size - size / 2,
                             tx * size + size / 2, tz * size + size / 2)
                          for tx, tz in world['tiles']])
    ways = []
    missing = []
    for item in osm['elements']:
        if item['type'] != 'way':
            continue
        tags = item.get('tags', {})
        if not (tags.get('highway') or tags.get('waterway') or tags.get('railway') or tagged(tags)):
            continue
        geo = item.get('geometry', [])
        if len(geo) < 2 or any('lon' not in q or 'lat' not in q for q in geo):
            missing.append(item['id'])
            continue
        coords = [project(q) for q in geo]
        full = LineString(coords)
        clipped = full.intersection(region)
        if not line_parts(clipped):
            continue
        ways.append({'id': item['id'], 'tags': tags, 'line': clipped,
                     'full': full, 'vertices': set(coords), 'nodes': item.get('nodes')})
    roads = [w for w in ways if w['tags'].get('highway')]
    others = [w for w in ways if w['tags'].get('waterway') or w['tags'].get('railway')]
    rows, covered = [], set()
    shared_node_crossings = 0
    overlap_pairs = set()

    def add(a, b, p, kind, evidence):
        deck = a
        if b and b['tags'].get('highway'):
            # Higher layer wins; bridge/tunnel tags disambiguate absent layers.
            def height_key(w):
                t = w['tags']
                return (layer(t) or 0, int(active(t.get('bridge'))) - int(active(t.get('tunnel'))))
            deck = max((a, b), key=height_key)
        other = b if deck is a else a
        d = deck['full'].project(p)
        p0 = deck['full'].interpolate(max(0, d - 3))
        p1 = deck['full'].interpolate(min(deck['full'].length, d + 3))
        yaw = math.atan2(p1.x - p0.x, p1.y - p0.y)
        selected = [a] + ([b] if b else [])
        rows.append({'osm_way_ids': [w['id'] for w in selected],
                     'roads': [{'way_id': w['id'], 'name': label(w),
                                'class': w['tags'].get('highway'),
                                'rendered_class': w['tags'].get('highway', '').replace('_link', '') in ROAD_CLASSES}
                               for w in selected if w['tags'].get('highway')],
                     'x': round(p.x, 2), 'z': round(p.y, 2),
                     'length_m': round(deck['line'].length, 1),
                     'layer': {str(w['id']): w['tags'].get('layer', '0') for w in selected},
                     'tags': {str(w['id']): w['tags'] for w in selected},
                     'type': kind, 'under': label(other) if other else 'unknown (tag-only candidate)',
                     'deck_way_id': deck['id'], 'yaw': round(yaw, 6),
                     'evidence': evidence, 'state': 'NOT VERIFIED — director screenshot review required',
                     'verdict': None})
        covered.update(w['id'] for w in selected if tagged(w['tags']))

    tree = STRtree([w['line'] for w in roads])
    for i, a in enumerate(roads):
        for j in tree.query(a['line'], predicate='intersects'):
            j = int(j)
            if j <= i:
                continue
            b = roads[j]
            intersection = a['line'].intersection(b['line'])
            if line_parts(intersection):
                overlap_pairs.add((a['id'], b['id']))
            for p in point_parts(intersection):
                # Check sharing AT this crossing, not somewhere else on the ways.
                common = a['vertices'] & b['vertices']
                if a['nodes'] is not None and b['nodes'] is not None:
                    node_ids = set(a['nodes']) & set(b['nodes'])
                    common = {q for n, q in zip(a['nodes'], a['full'].coords) if n in node_ids}
                if any(p.distance(Point(q)) < 0.001 for q in common):
                    shared_node_crossings += 1
                    continue
                kind = 'underpass' if any(active(w['tags'].get('tunnel')) or (layer(w['tags']) or 0) < 0 for w in (a, b)) else 'overpass'
                add(a, b, p, kind, 'road/road point intersection without shared vertex (node IDs unavailable)' if a['nodes'] is None or b['nodes'] is None else 'road/road crossing without shared OSM node')
    if others:
        tree = STRtree([w['line'] for w in others])
        for a in roads:
            for j in tree.query(a['line'], predicate='intersects'):
                b = others[int(j)]
                for p in point_parts(a['line'].intersection(b['line'])):
                    t = b['tags']
                    kind = ('rail' if t.get('railway') else 'culvert-only' if active(t.get('tunnel'))
                            else 'river bridge' if t.get('waterway') == 'river' else 'creek bridge')
                    add(a, b, p, kind, 'road/rail intersection' if kind == 'rail' else 'road/waterway intersection; bridge existence not assumed')
    # Every tagged way remains represented, including waterways without a road hit.
    for a in ways:
        if not tagged(a['tags']) or a['id'] in covered:
            continue
        t = a['tags']
        kind = ('rail' if t.get('railway') else 'culvert-only' if t.get('waterway') and active(t.get('tunnel'))
                else 'underpass' if active(t.get('tunnel')) or (layer(t) or 0) < 0
                else 'river bridge' if t.get('waterway') == 'river'
                else 'creek bridge' if t.get('waterway') else 'overpass')
        # Longest in-map fragment avoids a representative point outside the map.
        fragment = max(line_parts(a['line']), key=lambda g: g.length)
        add(a, None, fragment.interpolate(0.5, normalized=True), kind, 'tag-only; what lies below is unknown')

    def priority(row):
        road_cross = row['evidence'].startswith('road/road')
        return (0 if road_cross else 1 if row['type'] == 'river bridge' else 2,
                0 if row['deck_way_id'] == 163129655 else 1,
                -row['length_m'], tuple(row['osm_way_ids']), row['x'], row['z'])
    rows.sort(key=priority)
    for i, row in enumerate(rows, 1):
        row['id'] = f'BR-{i:03d}'
        row['screenshots'] = [f"{row['id']}-side.png", f"{row['id']}-driver.png"]
    return {'schema_version': 1, 'tile_count': len(world['tiles']),
            'counts': {t: sum(r['type'] == t for r in rows) for t in TYPES},
            'coverage': {'in_map_highway_ways': len(roads),
                         'tagged_in_map_ways': sum(tagged(w['tags']) for w in ways),
                         'tagged_ways_represented': len(covered),
                         'railway_ways_in_export': sum(bool(e.get('tags', {}).get('railway')) for e in osm['elements']),
                         'ways_missing_geometry': missing,
                         'shared_vertex_crossings_excluded': shared_node_crossings,
                         'road_pairs_with_linear_overlap': len(overlap_pairs),
                         'ways_with_node_ids': sum(w['nodes'] is not None for w in ways)},
            'rows': rows}


def markdown(result):
    lines = ['# Bridge and overpass audit', '',
             f"Coverage: **{result['tile_count']} manifest tiles**, {len(result['rows'])} candidate rows. "
             'Clipped to the union of the actual tile squares, not the bounding rectangle.', '',
             f"OSM source SHA-256: `{result.get('source_sha256', 'not recorded')}`.", '',
             '## Counts', '', '| Type | Rows |', '|---|---:|']
    lines += [f'| {t} | {result["counts"][t]} |' for t in TYPES]
    c = result['coverage']
    lines += ['', f"In-map highway ways: {c['in_map_highway_ways']}; tagged ways: {c['tagged_in_map_ways']}; "
              f"tagged ways represented: {c['tagged_ways_represented']}; "
              f"ways missing geometry: {len(c['ways_missing_geometry'])}.", '',
              '## Method and limits', '',
              '- Shapely 2 STRtree finds all point intersections: highway/highway and highway/waterway (rail if present). '
              'All highway classes are included; JSON marks classes supported by the road baker. '
              'Each crossing is a row; remaining bridge/tunnel/nonzero-layer ways get a tag-only row. '
              'Disabled bridge/tunnel values and numeric layer zero do not count as active tags.',
              '- Input contains geometry but no node IDs. Shared vertices at the crossing substitute for shared OSM nodes; '
              'coincident distinct nodes cannot be distinguished. This is a geometry audit, not proven topology.',
              f"- Excluded {c['shared_vertex_crossings_excluded']} connected point crossings; "
              f"{c['road_pairs_with_linear_overlap']} road pairs have linear overlap (not isolated crossing points). "
              'Tagged overlapping ways are still included. Multi-crossing ways can occur in several rows; counts are candidates, not unique structures.',
              f"- Railway ways in export: {c['railway_ways_in_export']}. Zero rail rows means no rail source coverage, not no railway bridges.",
              '- Culvert-only means the waterway is explicitly tunnel-tagged; untagged stream crossings remain creek candidates. '
              'Tag-only overpasses have unknown obstacles. Layer values are listed per way; absent layer is 0.',
              '- Length is the inferred deck way length inside the map, not a measured physical span. '
              'Heading follows that way; layer/bridge/tunnel tags choose the probable upper road at road crossings.',
              '- Tag-only waterway rows have no identified deck road. Their driver PNG is a locator view along the waterway; '
              'the director must identify a road before treating that image as deck evidence.',
              '- Priority is a static risk estimate: road crossings without a shared vertex first (longest deck way first), '
              'then river crossings (Sheridan Bridge first), then remaining candidates. '
              'The first five are the requested likely clipping spots, **not visually confirmed worst defects**. '
              'No terrain-height or valley-profile measurements were made.',
              '- Every state and verdict is pending. Director must inspect both screenshots and record one of '
              '“deck dips into the valley”, “roads clip through each other”, or “fine”, with a one-line verdict. '
              'No screenshot has been generated or reviewed by this worker.', '',
              '## Reproduce and capture', '', '```sh',
              'python tools/bridge_audit.py --osm <raw-dir>/osm_region.json --json /tmp/bridges-audit.json',
              'node --check tools/bridge_shots.mjs',
              '# Director only: run through the machine-wide heavy gate, with the game already served.',
              'node tools/bridge_shots.mjs /tmp/bridges-audit.json /tmp/bridge-shots --rows 1,2,3,4,5',
              '# --rows accepts row numbers or BR IDs; omit it to capture every row.',
              '```', '', 'The capture helper also accepts a JSON array of selected row objects. It writes a separate report '
              'with page errors, frame times and camera coordinates; verdicts remain pending review. '
              'JSON stores full tags, deck heading, evidence and planned PNG basenames. '
              'Paths below are relative to the screenshot output folder. Screenshots and JSON stay outside the repo.', '',
              '## Candidate table', '',
              '| ID | OSM ways | Roads (class) | x, z (m) | Length (m) | Layer by way | Type | Under / crossing | Evidence | Current state / verdict | PNG paths |',
              '|---|---|---|---|---:|---|---|---|---|---|---|']
    def clean(value):
        return str(value).replace('|', '\\|').replace('\n', ' ')
    for r in result['rows']:
        roads = '; '.join(f"{w['name']} ({w['class']})" for w in r['roads']) or '—'
        vals = [r['id'], ', '.join(str(w) for w in r['osm_way_ids']), roads,
                f"{r['x']}, {r['z']}", r['length_m'],
                ', '.join(f'{w}:{v}' for w, v in r['layer'].items()), r['type'], r['under'],
                r['evidence'], r['state'], '; '.join(r['screenshots'])]
        lines.append('| ' + ' | '.join(clean(v) for v in vals) + ' |')
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--osm', type=Path, default=ROOT / 'data/raw/osm_region.json')
    parser.add_argument('--info', type=Path, help='naip_info.json; defaults beside OSM')
    parser.add_argument('--world', type=Path, default=ROOT / 'game/assets/world.json')
    parser.add_argument('--json', type=Path, required=True)
    parser.add_argument('--markdown', type=Path, default=ROOT / 'docs/research/bridges-audit.md')
    args = parser.parse_args()
    if args.json.resolve().is_relative_to(ROOT):
        parser.error('--json must be outside the repository')
    raw = args.osm.read_bytes()
    result = audit(json.loads(raw), json.loads(args.world.read_text()),
                   json.loads((args.info or args.osm.parent / 'naip_info.json').read_text()))
    result['source_sha256'] = hashlib.sha256(raw).hexdigest()
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(result, indent=2) + '\n')
    args.markdown.parent.mkdir(parents=True, exist_ok=True)
    args.markdown.write_text(markdown(result))
    print(json.dumps({k: v for k, v in result.items() if k != 'rows'}, indent=2))


if __name__ == '__main__':
    main()
