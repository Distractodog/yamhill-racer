"""Lossless packed-v2 fixtures; optional output directory for the JS cross-language test."""
import gzip
import json
from pathlib import Path
import struct
import sys
import tempfile
import tilefmt


def check(root):
    # Preserve exact bit patterns, including signed zero and a noncanonical NaN payload.
    floats = struct.pack('<8I', 0, 0x80000000, 0x3f800000, 0x7fc00001, 0x447a0000, 0xc2480000, 0x7f800000, 0xff800000)
    files = {'height.bin': floats, 'surface.bin': bytes(range(256)), 'ponds.bin': b'\0\0\x03\0',
             'trees.bin': floats * 3, 'tile.json': b'{"tx":0,"tz":0,"paths":[],"buildings":[]}'}
    for version in (0, 1, 2):
        folder = root / str(version); folder.mkdir(parents=True, exist_ok=True)
        for name, raw in files.items():
            if version == 1 and name == 'trees.bin':
                (folder / name).write_bytes(raw)
            else:
                tilefmt.write_bytes(folder, name, raw, packed=bool(version))
            assert tilefmt.read_bytes(folder, name) == raw, (version, name)
        if version == 2:
            assert (folder / 'trees.bin.gz').exists() and not (folder / 'trees.bin').exists()
            first = (folder / 'trees.bin.gz').read_bytes()
            tilefmt.write_bytes(folder, 'trees.bin', files['trees.bin'])
            assert (folder / 'trees.bin.gz').read_bytes() == first, 'gzip must be deterministic'
    empty = root / 'empty'; empty.mkdir(exist_ok=True)
    tilefmt.write_bytes(empty, 'trees.bin', b'')
    assert tilefmt.read_bytes(empty, 'trees.bin') == b''
    assert tilefmt.PACKED == 2
    (root / 'expected.json').write_text(json.dumps({k: v.hex() for k, v in files.items()}))
    print('PASS Python plain/v1/v2 exact byte identity, deterministic gzip, empty trees')


if __name__ == '__main__':
    if len(sys.argv) > 1: check(Path(sys.argv[1]))
    else:
        with tempfile.TemporaryDirectory(prefix='yr-tilefmt-v2-') as tmp: check(Path(tmp))
