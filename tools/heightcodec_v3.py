"""V3 height payload: H3Q0, uint16 side/flags, float32 minimum, uint32 corrections.

2 cm uint16 samples use a modulo-65536 left+up-upleft predictor and zigzag
signed modular residuals. Sparse original float32 corrections enforce the
strict 1 cm bound after float32 reconstruction (including rounding ties).
The payload is gzip-compressed by tilefmt, with level 9 and mtime zero.
No current tile qualifies for the optional coarse scenery grid.
"""
import struct
import numpy as np

MAGIC = b'H3Q0'
HEADER = struct.Struct('<4sHHfI')
STEP = .02


def encode(raw):
    a = np.frombuffer(raw, '<f4')
    n = int(np.sqrt(a.size))
    if not n or n*n != a.size or not np.isfinite(a).all():
        raise ValueError('Heights must be a finite square float32 grid')
    base = float(a.min())
    q = np.rint((a.astype(np.float64)-base)/STEP).astype(np.int64).reshape(n, n)
    if q.min() < 0 or q.max() > 65535 or float(a.max())-base > 65535*STEP:
        raise ValueError('Height range does not fit uint16 at 2 cm')
    residual = q.copy()
    residual[:, 1:] -= q[:, :-1]
    residual[1:, :] -= q[:-1, :]
    residual[1:, 1:] += q[:-1, :-1]
    residual = (residual+32768) % 65536-32768
    zig = ((residual << 1) ^ (residual >> 15)).astype('<u2')
    reconstructed = (base+q.ravel()*STEP).astype('<f4')
    exact = np.abs(reconstructed.astype(np.float64)-a) > .01
    # Neighbours have different minima. Preserve shared core edges verbatim so
    # independently quantized grids cannot open cracks at tile boundaries.
    if n == 517:
        edge = np.zeros((n, n), dtype=bool)
        edge[[8, 508], :] = True
        edge[:, [8, 508]] = True
        exact |= edge.ravel() & (reconstructed != a)
    indices = np.flatnonzero(exact)
    corrections = np.empty(indices.size, dtype=[('index', '<u4'), ('value', '<f4')])
    corrections['index'], corrections['value'] = indices, a[indices]
    return HEADER.pack(MAGIC, n, 0, base, len(indices))+zig.tobytes()+corrections.tobytes()


def decode(payload):
    if len(payload) < HEADER.size:
        raise ValueError('Truncated height header')
    magic, n, flags, base, count = HEADER.unpack_from(payload)
    if magic != MAGIC or flags != 0 or not n or not np.isfinite(base):
        raise ValueError('Unsupported height header')
    end = HEADER.size+2*n*n
    if len(payload) != end+8*count:
        raise ValueError('Invalid height payload length')
    zig = np.frombuffer(payload, '<u2', n*n, HEADER.size).astype(np.int64).reshape(n, n)
    residual = (zig >> 1) ^ -(zig & 1)
    q = residual.cumsum(axis=0).cumsum(axis=1) % 65536
    out = (base+q.ravel()*STEP).astype('<f4')
    correction = np.frombuffer(payload, dtype=[('index', '<u4'), ('value', '<f4')], count=count, offset=end)
    if count and (correction['index'].max() >= n*n or not np.isfinite(correction['value']).all()):
        raise ValueError('Invalid height corrections')
    out[correction['index']] = correction['value']
    return out.tobytes()
