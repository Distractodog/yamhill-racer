"""Run with a Python environment containing numpy and shapely >= 2."""
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from footprints import default_height, load_geojson, merge


def box(x, z, w=10, d=10, h=None):
    return {'pts': np.array([[x,z],[x+w,z],[x+w,z+d],[x,z+d]], dtype=float), 'h': h}


class FootprintsTest(unittest.TestCase):
    def test_duplicate_preserves_osm(self):
        original = box(0, 0, h=12)
        result = merge([original], [box(0, 0, h=30)])
        self.assertEqual(len(result), 1)
        self.assertIs(result[0], original)

    def test_overlap_threshold_and_union(self):
        self.assertEqual(len(merge([box(0, 0)], [box(6.9, 0)])), 1)
        self.assertEqual(len(merge([box(0, 0)], [box(7, 0)])), 2)
        self.assertEqual(len(merge([box(0, 0), box(0, 0)], [box(7, 0)])), 3)
        self.assertEqual(len(merge([box(0,0,2), box(8,0,2)], [box(0,0)])), 2)

    def test_disjoint_and_duplicate_additions(self):
        new = box(20,20,h=9)
        result = merge([box(0,0)], [new,new])
        self.assertEqual(len(result), 2)
        self.assertEqual(result[-1]['h'], 9)
        self.assertIsNot(result[-1]['pts'], new['pts'])

    def test_sliver_invalid_and_nonfinite(self):
        invalid = {'pts': [[0,0],[10,10],[0,10],[10,0]]}
        self.assertEqual(merge([], [box(0,0,.01,10), invalid, {'pts': [[0,0],[1,0],[0,float('nan')]]}]), [])

    def test_heights(self):
        for area, expected in [(20,3), (60,5.5), (350,7.5), (600,8), (1600,8)]:
            self.assertEqual(default_height(area), expected)
        for h in [None, -1, 'bad', float('inf')]:
            self.assertEqual(merge([], [box(0,0,10,6,h)])[0]['h'], 5.5)
        self.assertEqual(merge([], [box(0,0,h=.01)])[0]['h'], .1)

    def test_extreme_geometry_has_bounded_grid(self):
        self.assertEqual(merge([], [box(0,0,1e155,1e155)]), [])
        # Large accepted shapes still suppress overlapping later additions.
        huge = box(0,0,100000,100000)
        self.assertEqual(len(merge([], [huge, box(100,100)])), 1)
        self.assertEqual(len(merge([], [box(100,100), huge])), 2)

    def test_geojson_conversion_and_courtyard(self):
        ring = [[0,0],[1,0],[1,1],[0,1],[0,0]]
        features = [{'type':'Feature', 'properties':{'height':12}, 'geometry':{'type':'MultiPolygon','coordinates':[[ring],[ring,ring]]}}]
        with tempfile.TemporaryDirectory() as td:
            path = Path(td)/'footprints.json'
            path.write_text(json.dumps({'type':'FeatureCollection','features':features}))
            skipped = []
            result = load_geojson(path, lambda lon,lat: (lon*10,-lat*10), skipped=skipped)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(skipped), 1)
        self.assertEqual(result[0]['h'], 12)
        np.testing.assert_array_equal(result[0]['pts'][2], [10,-10])


if __name__ == '__main__':
    unittest.main()
