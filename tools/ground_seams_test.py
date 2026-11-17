"""Ground-colour continuity, corner agreement and untouched interiors."""
import tempfile
import unittest
from pathlib import Path
import numpy as np
from PIL import Image
from ground_seams import feather, blend_edge


class GroundSeamsTest(unittest.TestCase):
    def test_borders_and_corners(self):
        self.check_tiles([(x, z) for x in range(2) for z in range(2)])

    def test_three_tile_corner(self):
        self.check_tiles([(0, 0), (1, 0), (0, 1)])

    def test_does_not_mirror_features(self):
        a = np.full((64, 64, 3), 80, np.uint8)
        b = a.copy()
        b[20:40, 2:8] = 180
        original = a.copy()
        blend_edge(a, b, 1, True, width=8)
        np.testing.assert_array_equal(a, original)

    def check_tiles(self, keys):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'tiles'
            rng = np.random.default_rng(12)
            originals = {}
            for index, (x, z) in enumerate(keys):
                d = root / f'{x}_{z}'
                d.mkdir(parents=True)
                a = np.full((128, 128, 3), 70 + 30 * index, np.uint8)
                a[16:-16, 16:-16] = rng.integers(0, 256, (96, 96, 3), dtype=np.uint8)
                originals[x, z] = a
                Image.fromarray(a).save(d / 'ground.png')
            feather(root, reversed(list(originals)), width=16, log=lambda _: None)
            images = {k: np.array(Image.open(root / f'{k[0]}_{k[1]}/ground.png')) for k in originals}
            for (x, z), a in images.items():
                np.testing.assert_array_equal(a[16:-16, 16:-16], originals[x, z][16:-16, 16:-16])
                if (x + 1, z) in images:
                    self.assertLess(np.abs(a[:, -1].astype(float) - images[x + 1, z][:, 0]).mean(), 1)
                if (x, z + 1) in images:
                    self.assertLess(np.abs(a[-1].astype(float) - images[x, z + 1][0]).mean(), 1)


if __name__ == '__main__':
    unittest.main()
