"""Download Overture buildings and clip them to the current TILE_SET (WGS84 GeoJSON).

Install: python -m pip install overturemaps shapely numpy pillow
Run: python tools/fetch_buildings.py
Offline reclip: python tools/fetch_buildings.py --input extract.geojson --release YYYY-MM-DD.N
Optional --output, --release, --force. No tile assets are changed.
The GeoJSON retains source properties, IDs, valid heights, holes and multipolygons.
Data: https://docs.overturemaps.org/attribution/ (buildings theme: ODbL).
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request

from shapely.geometry import box, mapping, shape, MultiPolygon
from shapely.ops import unary_union
from shapely import make_valid

ROOT = Path(__file__).resolve().parents[1]
CATALOG = 'https://stac.overturemaps.org/catalog.json'
SOURCE = 'https://docs.overturemaps.org/guides/buildings/'
LICENSE = 'https://opendatacommons.org/licenses/odbl/1-0/'
CREDIT = ('Map data © OpenStreetMap contributors, Microsoft, and Overture Maps Foundation. '
          'Available under the Open Database License.')
# Stated reporting box around central Sheridan; count buildings intersecting it.
SHERIDAN_BBOX = (-123.402, 45.095, -123.385, 45.104)


def tile_region(tile_set, tile_size, world_to_lonlat):
    """Union exact tile rectangles, including gaps in the band-shaped map."""
    rectangles = []
    for tx, tz in tile_set:
        west, north = world_to_lonlat(tx * tile_size - tile_size / 2, tz * tile_size - tile_size / 2)
        east, south = world_to_lonlat(tx * tile_size + tile_size / 2, tz * tile_size + tile_size / 2)
        rectangles.append(box(west, south, east, north))
    if not rectangles:
        raise ValueError('TILE_SET is empty')
    return unary_union(rectangles)


def polygons(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry] if geometry.area > 0 else []
    if hasattr(geometry, 'geoms'):
        return [p for g in geometry.geoms for p in polygons(g)]
    return []


def clip_features(features, region):
    """Retain all properties, repairing invalid polygons and reporting every skip."""
    stats = Counter(input=0, outside=0, nonpolygon=0, repaired=0, duplicates=0, invalid_height=0)
    result, seen = [], {}
    for feature in features:
        stats['input'] += 1
        if feature.get('type') != 'Feature' or not feature.get('geometry'):
            raise ValueError('Input contains a missing or malformed Feature geometry')
        geom = shape(feature['geometry'])
        if geom.is_empty or not all(math.isfinite(n) for n in geom.bounds):
            raise ValueError('Input contains empty/nonfinite geometry')
        if geom.geom_type not in ('Polygon', 'MultiPolygon'):
            stats['nonpolygon'] += 1
            continue
        if not geom.is_valid:
            geom = make_valid(geom)
            stats['repaired'] += 1
        pieces = polygons(geom.intersection(region))
        if not pieces:
            stats['outside'] += 1
            continue
        clipped = pieces[0] if len(pieces) == 1 else MultiPolygon(pieces)
        props = dict(feature.get('properties') or {})
        height = props.get('height')
        if height is not None and (isinstance(height, bool) or not isinstance(height, (int, float))
                                   or not math.isfinite(height) or not 0 < height < 900):
            props['height'] = None
            stats['invalid_height'] += 1
        output = {**feature, 'geometry': mapping(clipped), 'properties': props}
        output.pop('bbox', None)  # Original bbox no longer describes a clipped polygon.
        identifier = feature.get('id', props.get('id'))
        if identifier is not None:
            if identifier in seen:
                if seen[identifier] != output:
                    raise ValueError(f'Conflicting duplicate feature ID: {identifier}')
                stats['duplicates'] += 1
                continue
            seen[identifier] = output
        result.append(output)
    stats['retained'] = len(result)
    return result, dict(stats)


def latest_release():
    req = urllib.request.Request(CATALOG, headers={'User-Agent': 'yamhill-racer-building-fetch'})
    with urllib.request.urlopen(req, timeout=60) as response:
        release = json.load(response)['latest']
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.\d+', release):
        raise ValueError('Unexpected release identifier in official STAC catalog')
    return release


def summarize(features):
    datasets = Counter()
    sheridan = box(*SHERIDAN_BBOX)
    count = 0
    for feature in features:
        count += shape(feature['geometry']).intersects(sheridan)
        for source in feature['properties'].get('sources') or []:
            if isinstance(source, dict) and source.get('dataset'):
                datasets[source['dataset']] += 1
    return {'count': len(features), 'sheridan_bbox_wgs84': SHERIDAN_BBOX,
            'sheridan_intersecting_count': count, 'source_datasets': dict(sorted(datasets.items()))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'data/raw/footprints.geojson')
    parser.add_argument('--input', type=Path, help='Reclip an existing Overture GeoJSON extract (requires --release)')
    parser.add_argument('--release', help='Pin an available release; defaults to official STAC latest')
    parser.add_argument('--force', action='store_true', help='Atomically replace an existing output')
    args = parser.parse_args()
    if args.input and not args.release:
        parser.error('--input requires --release to retain provenance')
    if args.output.exists() and not args.force:
        parser.error('Output already exists; use --force to replace it')
    if args.input and args.input.resolve() == args.output.resolve():
        parser.error('--input and --output must differ')
    from fetch_tiles import TILE_SET, TILE, world_to_lonlat
    region = tile_region(TILE_SET, TILE, world_to_lonlat)
    release = args.release or latest_release()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}\.\d+', release):
        parser.error('Release must be YYYY-MM-DD.N')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='footprints-', dir=args.output.parent) as temp:
        extract = args.input or Path(temp) / 'overture.geojson'
        if not args.input:
            command = [sys.executable, '-m', 'overturemaps', 'download',
                       '--bbox=' + ','.join(map(str, region.bounds)), '--release', release,
                       '--type=building', '-f', 'geojson', '-o', str(extract)]
            print(f'Downloading Overture {release}, bbox {region.bounds}, {len(TILE_SET)} tiles', flush=True)
            subprocess.run(command, check=True)
        raw = extract.read_bytes()
        collection = json.loads(raw)
        if collection.get('type') != 'FeatureCollection' or not isinstance(collection.get('features'), list):
            raise ValueError('Expected a GeoJSON FeatureCollection')
        features, stats = clip_features(collection['features'], region)
        if not features:
            raise ValueError('No buildings retained; output not replaced')
        summary = summarize(features)
        provenance = {'source': SOURCE, 'release': release, 'license': LICENSE,
                      'attribution': CREDIT, 'attribution_reference': 'https://docs.overturemaps.org/attribution/',
                      'downloaded_at_utc': datetime.now(timezone.utc).isoformat(),
                      'extract_sha256': hashlib.sha256(raw).hexdigest(), 'bbox_wgs84': region.bounds,
                      'tiles': list(TILE_SET), 'clip_statistics': stats,
                      'overturemaps_version': importlib.metadata.version('overturemaps') if not args.input else None,
                      **summary}
        output = {'type': 'FeatureCollection', 'metadata': provenance, 'features': features}
        staged = Path(temp) / 'clipped.geojson'
        staged.write_text(json.dumps(output, separators=(',', ':'), allow_nan=False) + '\n')
        staged.replace(args.output)
        print(json.dumps(provenance, indent=2))
        print(f'Wrote {args.output.name}: {args.output.stat().st_size} bytes', flush=True)
        print('Review source_datasets against the attribution reference before publishing credits.')


if __name__ == '__main__':
    main()
