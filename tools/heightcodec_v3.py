"""H3Q0 heights: flag 8 is lossless; legacy flag 0 remains readable.

The 16-byte <4sHHfI header contains magic, square side, flags, zero base,
and zero corrections for lossless files. Payload is four byte planes of
zigzag32 modular uint32 residuals: one horizontal difference followed by
two vertical differences. Decode reverses these in uint32 arithmetic,
restoring every original float32 bit. Caller applies gzip9 with mtime=0.
"""
import math
import struct
import numpy as np

MAGIC = b'H3Q0'
HEADER = struct.Struct('<4sHHfI')
LOSSLESS = 8
STEP = .02  # legacy flag 0 only


def encode(raw):
    if len(raw) % 4:
        raise ValueError('Heights require complete float32 values')
    n = math.isqrt(len(raw) // 4)
    if not n or n > 65535 or n*n*4 != len(raw):
        raise ValueError('Heights must be a nonempty square grid with uint16 side')
    values = np.frombuffer(raw, '<f4')
    if not np.isfinite(values).all():
        raise ValueError('Heights must be finite')
    bits = np.frombuffer(raw, '<u4').reshape(n, n).astype(np.int64)
    residual = bits.copy()
    residual[:, 1:] -= bits[:, :-1]
    for _ in range(2):
        previous = residual.copy()
        residual[1:] -= previous[:-1]
    signed = (residual + 2147483648) % 4294967296 - 2147483648
    zig = ((signed << 1) ^ (signed >> 31)).astype('<u4')
    planes = np.frombuffer(zig.tobytes(), np.uint8).reshape(-1, 4).T.tobytes()
    return HEADER.pack(MAGIC, n, LOSSLESS, 0., 0) + planes


def decode(payload):
    if len(payload) < HEADER.size:
        raise ValueError('Truncated height header')
    magic, n, flags, base, count = HEADER.unpack_from(payload)
    if magic != MAGIC or not n or flags not in (0, LOSSLESS) or not np.isfinite(base):
        raise ValueError('Unsupported height header')
    if flags == LOSSLESS:
        if struct.unpack_from('<I',payload,8)[0] != 0 or count != 0 or len(payload) != HEADER.size + 4*n*n:
            raise ValueError('Invalid lossless height payload')
        raw = np.frombuffer(payload, np.uint8, offset=HEADER.size).reshape(4, -1).T.tobytes()
        zig = np.frombuffer(raw, '<u4').astype(np.int64).reshape(n, n)
        signed = (zig >> 1) ^ -(zig & 1)
        bits = (signed % 4294967296).astype(np.uint32)
        for axis in (0, 0, 1):
            bits = bits.cumsum(axis=axis, dtype=np.uint64).astype(np.uint32)
        result = bits.astype('<u4').tobytes()
        if not np.isfinite(np.frombuffer(result, '<f4')).all():
            raise ValueError('Nonfinite decoded heights')
        return result
    # Existing 2 cm quantized files, including exact float32 corrections.
    end = HEADER.size + 2*n*n
    if len(payload) != end + 8*count:
        raise ValueError('Invalid legacy height payload length')
    zig = np.frombuffer(payload, '<u2', n*n, HEADER.size).astype(np.int64).reshape(n, n)
    residual = (zig >> 1) ^ -(zig & 1)
    q = residual.cumsum(axis=0).cumsum(axis=1) % 65536
    out = (base + q.ravel()*STEP).astype('<f4')
    correction = np.frombuffer(payload, dtype=[('index','<u4'),('value','<f4')], count=count, offset=end)
    if count and (correction['index'].max() >= n*n or not np.isfinite(correction['value']).all()
                  or len(np.unique(correction['index'])) != count):
        raise ValueError('Invalid height corrections')
    out[correction['index']] = correction['value']
    if not np.isfinite(out).all():
        raise ValueError('Nonfinite decoded heights')
    return out.tobytes()
