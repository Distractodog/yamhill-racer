"""V3 trees: exact subtype uses exceptions=0xffffffff, XOR-predicted uint32
x/z byte planes, raw height byte planes and uint8 type flags (0,1,negative-zero2).
All original record bits survive. The older quantized subtype remains readable.

Legacy V3 trees: TRV3 header <4sIiiI (magic,count,tx,tz,exceptions), SoA payload.

Two uint16 planes encode 4 cm x/z steps, each split into low/high bytes. uint8 flags contain broadleaf in bit
0 and x/z 2 cm refinements in bits 1/2. Four byte planes preserve float32
heights exactly. Trailing <Iff records restore coordinates whose quantization
would change a 250 m render bucket or exceed 2 cm Euclidean displacement.
Existing procedural scale/rotation/color remain unchanged; callers gzip with
mtime=0. No tree reordering is permitted.
"""
import struct
import numpy as np
HEADER = struct.Struct('<4sIiiI')
MAGIC = b'TRV3'
EXCEPTION = np.dtype([('index','<u4'),('x','<f4'),('z','<f4')])


EXACT = 0xffffffff


def encode_trees(raw, tx, tz):
    """Exact subtype: 12 byte planes (XOR x/z, raw height) plus type flags."""
    if len(raw)%16: raise ValueError('Tree records require four float32 values')
    if any(type(v)!=int or not -2**31<=v<2**31 for v in (tx,tz)): raise ValueError('Invalid tree tile index')
    t=np.frombuffer(raw,'<f4').reshape(-1,4)
    if not np.isfinite(t).all() or not np.isin(t[:,3],[0,1]).all(): raise ValueError('Invalid tree values or types')
    origin=np.array([tx*2000-1000,tz*2000-1000],dtype=np.float64)
    local=t[:,:2].astype(np.float64)-origin
    if np.any(local<0) or np.any(local>2000): raise ValueError('Tree outside tile core')
    bits=np.frombuffer(raw,'<u4').reshape(-1,4);parts=[]
    for axis in (0,1):
        values=bits[:,axis].copy();delta=values.copy()
        delta[1:] ^= values[:-1]
        parts.append(np.frombuffer(delta.astype('<u4').tobytes(),np.uint8).reshape(-1,4).T.tobytes())
    parts.append(np.frombuffer(bits[:,2].astype('<u4').tobytes(),np.uint8).reshape(-1,4).T.tobytes())
    flags=t[:,3].astype(np.uint8)|((bits[:,3]>>31).astype(np.uint8)<<1)
    return HEADER.pack(MAGIC,len(t),tx,tz,EXACT)+b''.join(parts)+flags.tobytes()


def decode_exact(payload,n,tx,tz):
    if len(payload)!=HEADER.size+n*13: raise ValueError('Invalid exact tree payload length')
    out=np.empty((n,4),dtype='<u4')
    for axis in range(3):
        planes=np.frombuffer(payload,np.uint8,n*4,HEADER.size+axis*n*4).reshape(4,n)
        values=np.frombuffer(planes.T.copy().tobytes(),'<u4')
        out[:,axis]=np.bitwise_xor.accumulate(values) if axis<2 else values
    flags=np.frombuffer(payload,np.uint8,n,HEADER.size+n*12)
    if np.any((flags!=0)&(flags!=1)&(flags!=2)): raise ValueError('Invalid exact tree type flags')
    out[:,3]=np.where(flags==1,0x3f800000,np.where(flags==2,0x80000000,0))
    t=out.view('<f4')
    if not np.isfinite(t).all(): raise ValueError('Nonfinite decoded trees')
    local=t[:,:2].astype(np.float64)-[tx*2000-1000,tz*2000-1000]
    if np.any(local<0) or np.any(local>2000): raise ValueError('Tree outside tile core')
    return out.tobytes()


def decode_trees(payload):
    if len(payload)<HEADER.size:
        raise ValueError('Truncated tree header')
    magic,n,tx,tz,ne = HEADER.unpack_from(payload)
    if magic==MAGIC and ne==EXACT: return decode_exact(payload,n,tx,tz)
    if magic!=MAGIC or len(payload)!=HEADER.size+n*9+ne*12:
        raise ValueError('Invalid tree payload')
    o = HEADER.size
    x = np.frombuffer(np.frombuffer(payload,np.uint8,n*2,o).reshape(2,n).T.tobytes(),'<u2').astype(np.uint32)
    z = np.frombuffer(np.frombuffer(payload,np.uint8,n*2,o+n*2).reshape(2,n).T.tobytes(),'<u2').astype(np.uint32)
    flags = np.frombuffer(payload,np.uint8,n,o+n*4)
    if np.any(flags&248):
        raise ValueError('Unknown tree flags')
    result = np.empty((n,4),dtype='<f4')
    result[:,0] = tx*2000-1000+(x*2+((flags>>1)&1))*.02
    result[:,1] = tz*2000-1000+(z*2+((flags>>2)&1))*.02
    h = np.frombuffer(payload,np.uint8,n*4,o+n*5).reshape(4,n).T.copy()
    result[:,2] = np.frombuffer(h.tobytes(),'<f4')
    result[:,3] = flags&1
    exc = np.frombuffer(payload,EXCEPTION,ne,o+n*9)
    if ne and (np.any(exc['index']>=n) or len(np.unique(exc['index']))!=ne):
        raise ValueError('Invalid tree exception indices')
    result[exc['index'],0],result[exc['index'],1] = exc['x'],exc['z']
    if not np.isfinite(result).all():
        raise ValueError('Nonfinite decoded trees')
    return result.tobytes()
