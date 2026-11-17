"""Ramp tapers (roadnet.tapers) on small made-up road networks. Run: python tools/roadnet_taper_test.py"""
import os, sys, unittest
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import roadnet

TRUNK = {'cls': 'trunk', 'lanes': None, 'sidewalk': None, 'oneway': False}
LINK = {'cls': 'trunk_link', 'lanes': None, 'sidewalk': None, 'oneway': True}


def road(pts, attr, w):
    return {'kind': 'asphalt', 'w': w, 'pts': np.array(pts, float), 'attr': attr}


def offset_from(pts, P):
    """Distance from point P to polyline pts."""
    a, d = pts[:-1], np.diff(pts, axis=0); t = np.clip(((P - a) * d).sum(1) / (d * d).sum(1), 0, 1)
    return np.hypot(*(a + d * t[:, None] - P).T).min()


def build(paths):
    nodes, edges = roadnet.build_graph(paths)
    return roadnet.tapers(nodes, edges)


class TaperTest(unittest.TestCase):
    D = 17 / 2 + roadnet.LINK_W / 2                     # ramp centre line beside a trunk: main hw + ramp hw

    def test_both_ends(self):
        # a link from (0, 0) on trunk A to (1000, 100) on trunk B: a taper at each end, both must stay re-laid
        A = [(-400, 0), (0, 0), (500, 0)]
        B = [(600, 100), (1000, 100), (1600, 100)]
        nodes, edges, recs = build([road(A, TRUNK, 17), road(B, TRUNK, 17), road([(0, 0), (1000, 100)], LINK, roadnet.LINK_W)])
        self.assertEqual(len(recs), 2)
        R = recs[0]['ramp']; self.assertIs(R, recs[1]['ramp']); p = R['pts']
        self.assertEqual(R['taper'], [True, True])
        # neither end is left at its meet: each starts the lane-end length along, beside its own main road
        for r in recs:
            end = p[0] if r['rend'] == 0 else p[-1]
            self.assertGreater(np.hypot(*(end - r['N'])), r['LD'] - 1)
        mainA, mainB = np.array(A, float), np.array(B, float)
        for r, main in ((r, mainA if np.allclose(r['N'], (0, 0)) else mainB) for r in recs):
            op = p if r['rend'] == 0 else p[::-1]; s = roadnet.arclen(op)
            near = op[s <= r['TP'] - r['LD'] - 2]                     # the full lane part of this end
            self.assertGreater(len(near), 5)
            off = np.array([offset_from(main, q) for q in near])
            self.assertLess(np.abs(off - self.D).max(), 0.5, f'taper at {r["N"]}: offsets {off.min():.2f}..{off.max():.2f}')
        # the middle of the ramp keeps its own OSM line
        mid = np.array([500.0, 50.0]); self.assertLess(offset_from(p, mid), 0.5)
        # both main roads carry the extra lane (wedge + full lane each)
        for r in recs: self.assertEqual(len(r['main']['widen']), 2)

    def test_one_end(self):
        # the same link ending at a dead end: one taper, the far end untouched
        A = [(-400, 0), (0, 0), (500, 0)]
        nodes, edges, recs = build([road(A, TRUNK, 17), road([(0, 0), (1000, 100)], LINK, roadnet.LINK_W)])
        self.assertEqual(len(recs), 1)
        R = recs[0]['ramp']; far = R['pts'][-1] if recs[0]['rend'] == 0 else R['pts'][0]
        self.assertTrue(np.allclose(far, (1000, 100)))
        self.assertEqual(sum(R['taper']), 1)

    def test_short_taper_keeps_blend(self):
        _, _, recs = build([road([(-400, 0), (0, 0), (500, 0)], TRUNK, 17),
                            road([(0, 0), (100, 40)], LINK, roadnet.LINK_W)])
        self.assertEqual(len(recs), 1)
        self.assertGreaterEqual(recs[0]['TP'], 40)
        self.assertLess(recs[0]['TP'], 60)
        self.assertGreaterEqual(recs[0]['BL'], 20)
        self.assertGreater(recs[0]['TP'], recs[0]['LD'])

    def test_too_short_stays_junction(self):
        _, _, recs = build([road([(-400, 0), (0, 0), (500, 0)], TRUNK, 17),
                            road([(0, 0), (45, 18)], LINK, roadnet.LINK_W)])
        self.assertEqual(recs, [])

    def test_neighbour_cannot_trim_away_nose(self):
        _, _, recs = build([
            road([(-400, 0), (-20, 0), (0, 0), (500, 0)], TRUNK, 17),
            road([(-20, 0), (-20, -100)], TRUNK, 17),
            road([(0, 0), (300, 90)], LINK, roadnet.LINK_W),
        ])
        self.assertEqual(recs, [])

    def test_outward_shift_needs_blending_room(self):
        _, _, recs = build([
            road([(-400, 0), (0, 0), (500, 0)], TRUNK, 17),
            road([(0, 0), (50, 5), (80, 20)], LINK, roadnet.LINK_W),
        ])
        self.assertEqual(recs, [])

    def test_curved_main(self):
        angle = np.linspace(-.5, .8, 261)
        pts = np.column_stack([500 * np.sin(angle), 500 * (1 - np.cos(angle))])
        frame = roadnet._Frame(pts)
        s = np.linspace(10, frame.L - 10, 1000)
        q, n = frame.at(s)
        u, lat = frame.project(q[:, :2] + 15 * n)
        self.assertTrue((np.diff(u) > 0).all())
        self.assertLess(np.abs(u - s).max(), .1)
        self.assertLess(np.abs(lat - 15).max(), .01)


if __name__ == '__main__':
    unittest.main()
