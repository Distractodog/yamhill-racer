import json
import unittest
from jsoncodec_v3 import encode


class GeometryTest(unittest.TestCase):
    def test_geometry_and_overlay_bound(self):
        road = {'pts': [[1.23, -2.34], [8.9, 4.5]], 'w': 17, 'kind': 'asphalt',
                'yc': [[10.005, .0125], [11.004, -.0084]], 'stop': [True, False]}
        tile = {'paths': [road], 'physPaths': [road], 'ponds': {'3': 10.123},
                'junctions': [{'c': [1.23, 2.34, 10.005], 'ring': [[1.2, 2.3, 9.994, 1]]}],
                'buildings': [{'pts': [[1.2, 2.3]], 'h': 5.005}]}
        result = json.loads(encode(tile))
        self.assertEqual(result['ponds'], tile['ponds'])
        self.assertEqual(result['paths'][0]['stop'], [True, False])
        self.assertEqual(result['paths'][0]['pts'], road['pts'])
        for (y, c), (yy, cc) in zip(road['yc'], result['paths'][0]['yc']):
            for cross in (-8.5, 0, 8.5):
                self.assertLessEqual(abs(y+c*cross-yy-cc*cross), .01)
        self.assertEqual(encode(tile), encode(tile))
        self.assertNotIn(b' ', encode(tile))
        self.assertEqual(road['yc'][0], [10.005, .0125])

    def test_wide_future_road_preserves_precision(self):
        road = {'pts': [], 'w': 100, 'yc': [[1.005, .0005]]}
        self.assertEqual(json.loads(encode({'paths': [road]}))['paths'][0]['yc'], road['yc'])


if __name__ == '__main__':
    unittest.main()
