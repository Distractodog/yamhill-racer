"""Tile file formats, shared by build_tiles.py, pack_tiles.py, verify_pack.py and the tools that read built tiles.

Unpacked (world.json without "packed"): height.bin, surface.bin, ponds.bin, trees.bin, tile.json, ground.png.

Packed (world.json "packed": 2), arrays byte-identical once unpacked:
  height.bin.gz   gzip of height.bin with its float32 bytes split into 4 planes (all 1st bytes, then all 2nd, ...);
                  game/src/tilepack.js puts them back. Same floats, ~30% smaller than plain gzip.
  surface.bin.gz  gzip of surface.bin
  ponds.bin.gz    gzip of ponds.bin
  tile.json.gz    gzip of tile.json (same bytes inside)
  trees.bin.gz    gzip of trees.bin with the same lossless 4-byte-plane shuffle as heights
Version 1 remains readable: it stores trees.bin uncompressed; all other files are unchanged.
  ground.jpg      ground colours, JPEG quality 90, full colour resolution (4:4:4), sRGB like the PNG
gzip is written with mtime 0, so the same input always gives the same file (no git churn on rebuilds).
GitHub Pages serves .gz as plain bytes (no Content-Encoding): the game unpacks them itself.
"""
import gzip, io, json, os
import numpy as np
from PIL import Image

PACKED = 2
GZ = ('height.bin', 'surface.bin', 'ponds.bin', 'tile.json', 'trees.bin')      # gzipped in packed tiles
JPEG_Q = 90


def shuffle4(b):
    return np.frombuffer(b, np.uint8).reshape(-1, 4).T.tobytes()


def unshuffle4(b):
    return np.frombuffer(b, np.uint8).reshape(4, -1).T.tobytes()


def gz(b):
    return gzip.compress(b, 9, mtime=0)


def write_bytes(out, name, raw, packed=True):
    """raw = the exact bytes of the unpacked file `name` (e.g. 'height.bin')."""
    if not packed or name not in GZ:
        with open(os.path.join(out, name), 'wb') as f: f.write(raw)
        return
    with open(os.path.join(out, name + '.gz'), 'wb') as f:
        f.write(gz(shuffle4(raw) if name in ('height.bin', 'trees.bin') else raw))


def write_ground(out, img, packed=True):
    """img: PIL RGB image (2048^2)."""
    if packed: img.save(os.path.join(out, 'ground.jpg'), 'JPEG', quality=JPEG_Q, subsampling=0, optimize=True)
    else: img.save(os.path.join(out, 'ground.png'))


def is_packed(tile_dir):
    return os.path.exists(os.path.join(tile_dir, 'tile.json.gz'))


def read_bytes(tile_dir, name):
    """The unpacked bytes of `name` from a packed or unpacked tile folder."""
    p = os.path.join(tile_dir, name)
    if name in GZ and not os.path.exists(p) and os.path.exists(p + '.gz'):
        with open(p + '.gz', 'rb') as f: b = gzip.decompress(f.read())
        return unshuffle4(b) if name in ('height.bin', 'trees.bin') else b
    with open(p, 'rb') as f: return f.read()


def read_json(tile_dir):
    return json.loads(read_bytes(tile_dir, 'tile.json'))


def read_ground(tile_dir):
    p = os.path.join(tile_dir, 'ground.jpg')
    return Image.open(p if os.path.exists(p) else os.path.join(tile_dir, 'ground.png')).convert('RGB')
