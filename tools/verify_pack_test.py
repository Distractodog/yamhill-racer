"""CLI regressions for verification of both supported packed formats."""
import gzip
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

from PIL import Image
import tilefmt


class VerifyPackTest(unittest.TestCase):
    def test_legacy_and_current_arrays_and_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            src = root / 'plain'
            plain = src / 'tiles' / '0_0'
            plain.mkdir(parents=True)
            files = {'height.bin': struct.pack('<4f', 0, 1, -2, 3),
                     'trees.bin': struct.pack('<4f', 10, 20, 8, 1),
                     'surface.bin': bytes([0, 1, 3, 5]),
                     'ponds.bin': bytes([0, 0, 1, 0]), 'tile.json': b'{"paths":[]}'}
            for name, raw in files.items():
                (plain / name).write_bytes(raw)
            Image.new('RGB', (4, 4), (50, 100, 150)).save(plain / 'ground.png')
            for version in (1, 2):
                dst = root / str(version)
                packed = dst / 'tiles' / '0_0'
                packed.mkdir(parents=True)
                (dst / 'world.json').write_text(json.dumps({'packed': version, 'tiles': [[0, 0]]}))
                for name, raw in files.items():
                    if version == 1 and name == 'trees.bin':
                        (packed / name).write_bytes(raw)
                    else:
                        payload = tilefmt.shuffle4(raw) if name in ('height.bin', 'trees.bin') else raw
                        (packed / (name + '.gz')).write_bytes(gzip.compress(payload, mtime=0))
                Image.new('RGB', (4, 4), (50, 100, 150)).save(packed / 'ground.jpg')
                ok = self.run_cli(src, dst)
                self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
                self.assertIn('arrays IDENTICAL', ok.stdout)
                (packed / 'surface.bin.gz').write_bytes(gzip.compress(b'bad', mtime=0))
                bad = self.run_cli(src, dst)
                self.assertEqual(bad.returncode, 1)
                self.assertIn('DIFFER: surface.bin', bad.stdout)

    def test_unsupported_format_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for version in (None, 0, 3):
                (root / 'world.json').write_text(json.dumps({'packed': version, 'tiles': []}))
                result = self.run_cli(root, root)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('supported packed version 1 or 2', result.stderr)

    @staticmethod
    def run_cli(src, dst):
        return subprocess.run([sys.executable, str(Path(__file__).with_name('verify_pack.py')), str(src), str(dst)],
                              capture_output=True, text=True)


if __name__ == '__main__':
    unittest.main()
