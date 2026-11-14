"""Offline geometry/provenance checks: python tools/fetch_buildings_test.py."""
import unittest
from shapely.geometry import box, Polygon, MultiPolygon, mapping, shape
from fetch_buildings import clip_features, tile_region, summarize


def feature(geom, identifier='a', **properties):
    return {'type': 'Feature', 'id': identifier, 'bbox': list(geom.bounds),
            'geometry': mapping(geom), 'properties': {'height': 6, 'sources': [{'dataset': 'OpenStreetMap'}], **properties}}


class ClipTests(unittest.TestCase):
    def test_holes_multipolygons_properties(self):
        a = Polygon([(0,0),(4,0),(4,4),(0,4)], [[(1,1),(2,1),(2,2),(1,2)]])
        g = MultiPolygon([a, box(6,0,7,1)])
        result, stats = clip_features([feature(g)], box(-1,-1,8,8))
        out = shape(result[0]['geometry'])
        self.assertEqual(out.geom_type, 'MultiPolygon')
        self.assertEqual(sum(len(p.interiors) for p in out.geoms), 1)
        self.assertEqual(result[0]['properties']['height'], 6)
        self.assertEqual(result[0]['properties']['sources'], [{'dataset': 'OpenStreetMap'}])
        self.assertEqual(result[0]['id'], 'a')
        self.assertNotIn('bbox', result[0])
        self.assertEqual(stats['retained'], 1)

    def test_clip_tile_gaps_and_boundary(self):
        # Fake world transform still maps z south, and retains a missing middle tile.
        region = tile_region([(0,0),(2,0)], 2, lambda x,z: (x,-z))
        result, stats = clip_features([feature(box(0,0,2,.5)), feature(box(2,0,2.5,.5),'gap')], region)
        self.assertEqual(len(result), 1)
        self.assertAlmostEqual(shape(result[0]['geometry']).area, .5)
        self.assertEqual(stats['outside'], 1)

    def test_duplicate_and_conflict(self):
        a = feature(box(0,0,1,1))
        result, stats = clip_features([a,a], box(-1,-1,2,2))
        self.assertEqual(len(result), 1)
        self.assertEqual(stats['duplicates'], 1)
        with self.assertRaises(ValueError):
            clip_features([a,feature(box(0,0,.5,.5))], box(-1,-1,2,2))

    def test_invalid_height_and_geometry(self):
        for height in [-1, 0, 900, float('nan'), True, '10']:
            result, stats = clip_features([feature(box(0,0,1,1),height=height)],box(-1,-1,2,2))
            self.assertIsNone(result[0]['properties']['height'])
            self.assertEqual(stats['invalid_height'],1)
        bow = Polygon([(0,0),(1,1),(0,1),(1,0),(0,0)])
        result, stats = clip_features([feature(bow)],box(-1,-1,2,2))
        self.assertTrue(shape(result[0]['geometry']).is_valid)
        self.assertEqual(stats['repaired'],1)

    def test_sheridan_count_and_sources(self):
        inside = feature(box(-123.399,45.098,-123.398,45.099))
        outside = feature(box(0,0,1,1),'b',sources=[{'dataset':'Microsoft'}])
        summary = summarize([inside,outside])
        self.assertEqual(summary['sheridan_intersecting_count'],1)
        self.assertEqual(summary['source_datasets'],{'Microsoft':1,'OpenStreetMap':1})


if __name__ == '__main__': unittest.main()
