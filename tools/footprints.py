"""Merge supplementary building footprints without replacing OSM buildings.

Requires numpy and shapely >= 2. Coordinates passed to merge are world metres.
load_geojson accepts the baker's lonlat_to_world callback, without importing the
baker (which would start a full build). The baker integration waits for TW-3g.
"""
import json
import math

import numpy as np
from shapely.geometry import Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree


def default_height(area):
    """Deterministic area defaults; interpolate the brief's unspecified gaps."""
    if area < 40:
        return 3.0
    if area < 60:
        return 3.0 + (area - 40) / 20 * 2.5
    if area <= 350:
        return 5.5 + (area - 60) / 290 * 2.0
    if area < 600:
        return 7.5 + (area - 350) / 250 * 0.5
    return 8.0


def _polygon(item):
    try:
        pts = np.asarray(item['pts'], dtype=float)
        if pts.ndim != 2 or pts.shape[1] != 2 or len(pts) < 3 or not np.isfinite(pts).all():
            return None
        p = Polygon(pts)
        return p if p.is_valid and not p.is_empty and math.isfinite(p.area) and p.area >= 1.0 else None
    except (ValueError, TypeError, KeyError):
        return None


def merge(osm_buildings, new_footprints):
    """Preserve OSM verbatim; reject >30% overlap and sub-1m² slivers.

    Union overlap avoids double-counting intersecting OSM polygons. Accepted
    additions also block duplicate supplementary footprints. An exact 30% overlap
    is retained. No inputs are mutated. Ordering is stable for a fixed input.
    """
    result = list(osm_buildings)
    osm_polys = [p for b in result if (p := _polygon(b)) is not None]
    tree = STRtree(osm_polys)
    # Small grid for accepted additions keeps duplicate checks local without
    # rebuilding an STRtree for every building.
    accepted, cells, large = [], {}, []

    def keys(p):
        x0, z0, x1, z1 = p.bounds
        left, right = math.floor(x0 / 100), math.floor(x1 / 100)
        top, bottom = math.floor(z0 / 100), math.floor(z1 / 100)
        # A malformed or unusually long polygon must not allocate millions of
        # grid cells. Rare large shapes use a bounded-memory linear query.
        if (right - left + 1) * (bottom - top + 1) > 4096:
            return None
        return [(x, z) for x in range(left, right + 1) for z in range(top, bottom + 1)]

    for item in new_footprints:
        p = _polygon(item)
        if p is None:
            continue
        occupied = keys(p)
        neighbors = [osm_polys[int(i)] for i in tree.query(p, predicate='intersects')]
        seen = range(len(accepted)) if occupied is None else set(large) | {i for key in occupied for i in cells.get(key, ())}
        neighbors.extend(accepted[i] for i in seen if accepted[i].intersects(p))
        overlap = p.intersection(unary_union(neighbors)).area if neighbors else 0.0
        if overlap / p.area > 0.30 + 1e-12:
            continue
        try:
            h = float(item.get('h') or 0)
        except (ValueError, TypeError):
            h = 0
        if not math.isfinite(h) or h <= 0:
            h = default_height(p.area)
        # Positive sub-decimetre source estimates must not round to zero walls.
        result.append({'pts': np.asarray(p.exterior.coords[:-1], dtype=float), 'h': max(0.1, round(h, 1))})
        index = len(accepted)
        accepted.append(p)
        if occupied is None:
            large.append(index)
        for key in occupied or ():
            cells.setdefault(key, []).append(index)
    return result


def load_geojson(path, lonlat_to_world, *, skipped=None):
    """Load WGS84 Polygon/MultiPolygon features and retain positive heights.

    The tile format has only exterior rings: polygons containing courtyards are
    skipped rather than filling those courtyards with colliders. Pass a list as
    skipped to collect feature IDs and reasons for the count report.
    """
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if data.get('type') != 'FeatureCollection':
        raise ValueError('Expected a GeoJSON FeatureCollection')
    out = []
    for feature in data['features']:
        geo, props = feature.get('geometry') or {}, feature.get('properties') or {}
        kind = geo.get('type')
        polys = [geo.get('coordinates', [])] if kind == 'Polygon' else geo.get('coordinates', []) if kind == 'MultiPolygon' else []
        for rings in polys:
            if len(rings) != 1:
                if skipped is not None:
                    skipped.append({'id': feature.get('id', props.get('id')), 'reason': 'empty polygon or courtyard'})
                continue
            points = np.asarray(rings[0], dtype=float)
            if points.ndim != 2 or points.shape[1] < 2:
                raise ValueError('Invalid GeoJSON coordinate array')
            x, z = lonlat_to_world(points[:, 0], points[:, 1])
            out.append({'pts': np.column_stack((x, z)), 'h': props.get('height')})
    return out
