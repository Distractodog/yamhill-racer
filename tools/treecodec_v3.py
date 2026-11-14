"""V3 trees: TRV3 header <4sIiiI (magic,count,tx,tz,exceptions), SoA payload.

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


def encode_trees(raw, tx, tz):
    if len(raw) % 16:
        raise ValueError('Tree records require four float32 values')
    t = np.frombuffer(raw,'<f4').reshape(-1,4)
    if not np.isfinite(t).all() or not np.isin(t[:,3],[0,1]).all():
        raise ValueError('Invalid tree values or types')
    origin = np.array([tx*2000-1000,tz*2000-1000],dtype=np.float64)
    local = t[:,:2].astype(np.float64)-origin
    if np.any(local<0) or np.any(local>2000):
        raise ValueError('Tree outside tile core')
    q = np.rint(local/.02).astype(np.uint32)
    decoded = (origin+q*.02).astype('<f4')
    changed = np.any(np.floor(local/250)!=np.floor((decoded.astype(np.float64)-origin)/250),axis=1)
    changed |= np.linalg.norm(decoded.astype(np.float64)-t[:,:2],axis=1)>.02
    indices = np.flatnonzero(changed)
    exc = np.empty(len(indices),dtype=EXCEPTION)
    exc['index'],exc['x'],exc['z'] = indices,t[indices,0],t[indices,1]
    flags = (t[:,3].astype(np.uint8)|((q[:,0]&1)<<1)|((q[:,1]&1)<<2)).astype(np.uint8)
    h = np.frombuffer(t[:,2].tobytes(),np.uint8).reshape(-1,4).T.tobytes()
    return (HEADER.pack(MAGIC,len(t),tx,tz,len(exc))
            +b''.join(np.frombuffer((q[:,i]//2).astype('<u2').tobytes(),np.uint8).reshape(-1,2).T.tobytes() for i in (0,1))
            +flags.tobytes()+h+exc.tobytes())


def decode_trees(payload):
    if len(payload)<HEADER.size:
        raise ValueError('Truncated tree header')
    magic,n,tx,tz,ne = HEADER.unpack_from(payload)
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
