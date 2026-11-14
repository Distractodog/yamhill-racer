"""Run with a Python environment containing numpy and shapely >= 2."""
import ast
import builtins
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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


class BakerHookTest(unittest.TestCase):
    """Execute the actual optional hook without starting a terrain bake."""
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).with_name('build_tiles.py')
        tree = ast.parse(path.read_text(), filename=str(path))
        hooks = [node for node in tree.body if isinstance(node, ast.If)
                 and any(isinstance(n, ast.Import) and any(a.name == 'footprints' for a in n.names)
                         for n in ast.walk(node))]
        if len(hooks) != 1:
            raise AssertionError('Expected exactly one optional footprint hook')
        hook = hooks[0]
        collection = next(node for node in tree.body if isinstance(node, ast.For)
                          and any(isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                                  and isinstance(n.func.value, ast.Name) and n.func.value.id == 'buildings'
                                  and n.func.attr == 'append' for n in ast.walk(node)))
        if hook.lineno <= collection.end_lineno:
            raise AssertionError('Footprints must merge after collecting OSM buildings')
        cls.code = compile(ast.Module(body=[hook], type_ignores=[]), str(path), 'exec')

    def run_hook(self, directory, buildings):
        state = dict(os=os, RAW=str(directory), buildings=buildings,
                     lonlat_to_world=lambda lon, lat: (lon * 10, -lat * 10))
        exec(self.code, state)
        return state['buildings']

    def test_absent_file_preserves_list_without_import(self):
        original = [box(0, 0, h=12)]
        real_import = builtins.__import__
        def guarded_import(name, *args, **kwargs):
            if name == 'footprints' or name.startswith('shapely'):
                raise AssertionError('Absent data must not load optional dependencies')
            return real_import(name, *args, **kwargs)
        with tempfile.TemporaryDirectory() as td, patch('builtins.__import__', guarded_import):
            self.assertIs(self.run_hook(td, original), original)

    def test_present_file_projects_and_merges_preserving_osm(self):
        original = box(0, -10, h=12)
        def feature(offset):
            ring = [[offset,0],[offset+1,0],[offset+1,1],[offset,1],[offset,0]]
            return {'type':'Feature', 'properties':{'height':9},
                    'geometry':{'type':'Polygon','coordinates':[ring]}}
        with tempfile.TemporaryDirectory() as td:
            Path(td, 'footprints.geojson').write_text(json.dumps({
                'type':'FeatureCollection', 'features':[feature(0), feature(3)]}))
            result = self.run_hook(td, [original])
        self.assertEqual(len(result), 2)
        self.assertIs(result[0], original)
        self.assertEqual(result[0]['h'], 12)
        self.assertEqual(result[1]['h'], 9)
        np.testing.assert_array_equal(result[1]['pts'][2], [40, -10])

    def test_invalid_existing_file_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as td:
            Path(td, 'footprints.geojson').write_text('{broken')
            with self.assertRaises(json.JSONDecodeError):
                self.run_hook(td, [])


if __name__ == '__main__':
    unittest.main()
