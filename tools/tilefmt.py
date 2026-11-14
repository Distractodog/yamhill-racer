"""Shared tile I/O: read legacy plain/v1/v2 tiles and write packed v3.

V3 heights use H3Q0 prediction/2 cm quantization with strict-error corrections;
trees use TRV3 local coordinate planes with exact heights/types/render buckets.
Surface and pond rasters remain byte-identical gzip; geometry is compact JSON;
ground.webp keeps full RGB dimensions. See the individual codec modules.
Gzip level 9 and mtime zero make identical inputs byte reproducible.
"""
import gzip, io, json, os
import numpy as np
from PIL import Image
from heightcodec_v3 import encode as encode_heights, decode as decode_heights, MAGIC as HEIGHT_MAGIC
from treecodec_v3 import encode_trees, decode_trees, MAGIC as TREE_MAGIC
from imagecodec_v3 import encode_ground
from jsoncodec_v3 import encode as encode_geometry

PACKED = 3
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
    if name == 'height.bin': raw = encode_heights(raw)
    elif name == 'trees.bin':
        tx, tz = map(int, os.path.basename(os.path.normpath(out)).split('_'))
        raw = encode_trees(raw, tx, tz)
    elif name == 'tile.json': raw = encode_geometry(json.loads(raw))
    with open(os.path.join(out, name + '.gz'), 'wb') as f:
        f.write(gz(raw))


def write_ground(out, img, packed=True):
    """img: PIL RGB image (2048^2)."""
    if packed:
        with open(os.path.join(out, 'ground.webp'), 'wb') as f: f.write(encode_ground(img))
    else: img.save(os.path.join(out, 'ground.png'))


def is_packed(tile_dir):
    return os.path.exists(os.path.join(tile_dir, 'tile.json.gz'))


def read_bytes(tile_dir, name):
    """The unpacked bytes of `name` from a packed or unpacked tile folder."""
    p = os.path.join(tile_dir, name)
    if name in GZ and not os.path.exists(p) and os.path.exists(p + '.gz'):
        with open(p + '.gz', 'rb') as f: b = gzip.decompress(f.read())
        if name == 'height.bin': return decode_heights(b) if b.startswith(HEIGHT_MAGIC) else unshuffle4(b)
        if name == 'trees.bin': return decode_trees(b) if b.startswith(TREE_MAGIC) else unshuffle4(b)
        return b
    with open(p, 'rb') as f: return f.read()


def read_json(tile_dir):
    return json.loads(read_bytes(tile_dir, 'tile.json'))


def read_ground(tile_dir):
    webp = os.path.join(tile_dir, 'ground.webp')
    if os.path.exists(webp): return Image.open(webp).convert('RGB')
    p = os.path.join(tile_dir, 'ground.jpg')
    return Image.open(p if os.path.exists(p) else os.path.join(tile_dir, 'ground.png')).convert('RGB')
