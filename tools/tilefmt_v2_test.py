"""V3 writer/reader fixtures and explicit v2 backward-read regression.

Historical filename retained so existing verification commands still work.
"""
import gzip
import json
from pathlib import Path
import sys
import tempfile
import numpy as np
import tilefmt


def check(root):
    h=np.array([[-12.125,-12.115,-12.105],[4.321,7.777,9.999],[500.125,500.135,500.145]],dtype='<f4')
    t=np.array([[-999.999,-750.001,8.125,0],[123.456,789.123,19.75,1],[1000,1000,1.25,0]],dtype='<f4')
    files={'height.bin':h.tobytes(),'trees.bin':t.tobytes(),'surface.bin':bytes(range(256)),
           'ponds.bin':b'\0\0\x03\0','tile.json':b'{"tx":0,"tz":0,"paths":[{"pts":[[1.234,2.345],[5.678,9.876]],"w":7,"yc":[[2.345,0.0123],[3.456,0.0345]]}],"buildings":[]}'}
    legacy=root/'2'/'0_0';legacy.mkdir(parents=True,exist_ok=True)
    for name,raw in files.items():
        payload=tilefmt.shuffle4(raw) if name in ('height.bin','trees.bin') else raw
        (legacy/(name+'.gz')).write_bytes(gzip.compress(payload,9,mtime=0))
        assert tilefmt.read_bytes(legacy,name)==raw,('v2 backward identity',name)
    folder=root/'3'/'0_0';folder.mkdir(parents=True,exist_ok=True)
    for name,raw in files.items():
        tilefmt.write_bytes(folder,name,raw)
        first=(folder/(name+'.gz')).read_bytes();tilefmt.write_bytes(folder,name,raw)
        assert first==(folder/(name+'.gz')).read_bytes(),('deterministic',name)
    decoded={name:tilefmt.read_bytes(folder,name) for name in files}
    hh=np.frombuffer(decoded['height.bin'],'<f4').reshape(h.shape)
    tt=np.frombuffer(decoded['trees.bin'],'<f4').reshape(t.shape)
    assert np.max(np.abs(hh.astype(float)-h))<=.01
    assert np.max(np.linalg.norm(tt[:,:2].astype(float)-t[:,:2],axis=1))<=.02
    assert np.array_equal(tt[:,2:],t[:,2:])
    for name in ('surface.bin','ponds.bin'):assert decoded[name]==files[name]
    empty=root/'empty'/'0_0';empty.mkdir(parents=True,exist_ok=True)
    tilefmt.write_bytes(empty,'trees.bin',b'');assert tilefmt.read_bytes(empty,'trees.bin')==b''
    assert tilefmt.PACKED==3
    (root/'expected.json').write_text(json.dumps({k:v.hex() for k,v in decoded.items()}))
    print('PASS Python v2 backward identity; v3 deterministic output, height/tree bounds, unchanged rasters, empty trees')


if __name__=='__main__':
    if len(sys.argv)>1:check(Path(sys.argv[1]))
    else:
        with tempfile.TemporaryDirectory(prefix='yr-tilefmt-v3-') as tmp:check(Path(tmp))
