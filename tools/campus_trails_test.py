import unittest
import numpy as np
from campus_trails import trace_skeleton, smooth_trail, limit_trail_profile


class Trails(unittest.TestCase):
    def test_corner_is_one_path(self):
        mask = np.zeros((12, 12), bool)
        mask[2:8, 3] = True
        mask[7, 3:10] = True
        paths = trace_skeleton(mask, 1)
        self.assertEqual(len(paths), 1)
        self.assertEqual(set([paths[0][0], paths[0][-1]]), {(2, 3), (7, 9)})

    def test_t_junction(self):
        mask = np.zeros((12, 12), bool)
        mask[2:10, 5] = True
        mask[5, 5:10] = True
        paths = trace_skeleton(mask, 1)
        self.assertEqual(len(paths), 3)

    def test_closed_loop_survives(self):
        p = np.array([[0, 0], [30, 0], [30, 30], [0, 30], [0, 0]])
        q = smooth_trail(p)
        np.testing.assert_allclose(q[0], q[-1])
        self.assertGreater(np.linalg.norm(np.diff(q, axis=0), axis=1).sum(), 100)

    def test_endpoints_and_bounded_jitter(self):
        p = np.column_stack([np.arange(60), np.arange(60) % 2])
        q = smooth_trail(p)
        np.testing.assert_allclose(q[[0, -1]], p[[0, -1]])
        self.assertTrue(np.isfinite(q).all())
        self.assertLess(np.max(np.abs(np.diff(q[8:-8, 1]))), .1)

    def test_profile_spike_keeps_junctions(self):
        p = np.column_stack([np.arange(21), np.zeros(21), np.zeros(21), np.zeros(21)])
        p[10, 2] = 8
        p[-1, 2] = 2
        limit_trail_profile(p)
        np.testing.assert_allclose(p[[0, -1], 2], [0, 2])
        self.assertLessEqual(np.max(np.abs(np.diff(p[:, 2]))), .55 + 1e-8)

    def test_steep_short_connector_keeps_endpoints(self):
        p = np.array([[0., 0, 0], [1, 0, 5], [2, 0, 2]])
        limit_trail_profile(p)
        np.testing.assert_allclose(p[:, 2], [0, 1, 2], atol=1e-8)


if __name__ == '__main__':
    unittest.main()
