"""Height-v3 adversarial, cross-language fixtures and optional real-tile audit."""
import argparse
import gzip
import importlib.util
import json
from pathlib import Path
import struct
import unittest
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[1])
parser.add_argument('--fixtures',type=Path)
parser.add_argument('--assets',type=Path)
parser.add_argument('--report',type=Path)
args=parser.parse_args()
spec=importlib.util.spec_from_file_location('codec',args.repo/'tools/heightcodec_v3.py')
codec=importlib.util.module_from_spec(spec);spec.loader.exec_module(codec)

def cases():
    rng=np.random.default_rng(937)
    return {'flat':np.full((5,5),-83.125,dtype='<f4'),
            'singleton':np.array([[0]],dtype='<f4'),
            'negative_ramp':np.arange(81,dtype='<f4').reshape(9,9)*.013-100,
            'modular_checkerboard':(np.indices((8,8)).sum(0)%2*1310.68).astype('<f4'),
            'random':rng.uniform(-300,900,(63,63)).astype('<f4'),
            'halfsteps':np.array([0,.01,.03,.05,.07,.09,.11,.13,.15],dtype='<f4').reshape(3,3),
            'high_base_ties':(np.arange(49)*.01+1024).astype('<f4').reshape(7,7)}

class HeightCodecTest(unittest.TestCase):
    def test_adversarial_roundtrip(self):
        for name,a in cases().items():
            with self.subTest(name=name):
                payload=codec.encode(a.tobytes());decoded=np.frombuffer(codec.decode(payload),'<f4')
                self.assertLessEqual(float(np.max(abs(decoded.astype(float)-a.ravel().astype(float)))),.01)
                self.assertEqual(payload,codec.encode(a.tobytes()))
                self.assertEqual(gzip.compress(payload,mtime=0),gzip.compress(payload,mtime=0))
    def test_core_edges_preserved_exactly(self):
        rng=np.random.default_rng(41)
        a=rng.uniform(-20,300,(517,517)).astype('<f4')
        d=np.frombuffer(codec.decode(codec.encode(a.tobytes())),'<f4').reshape(a.shape)
        for i in (8,508):
            np.testing.assert_array_equal(d[i,:],a[i,:])
            np.testing.assert_array_equal(d[:,i],a[:,i])
        self.assertLessEqual(float(np.max(abs(d.astype(float)-a.astype(float)))),.01)

    def test_corrections_exercised(self):
        self.assertGreater(sum(codec.HEADER.unpack_from(codec.encode(a.tobytes()))[-1] for a in cases().values()),0)
    def test_invalid_grids(self):
        for a in [np.array([],dtype='<f4'),np.array([1,2],dtype='<f4'),np.array([np.nan],dtype='<f4'),np.array([np.inf],dtype='<f4'),np.array([0,0,0,1310.8],dtype='<f4')]:
            with self.assertRaises(ValueError):codec.encode(a.tobytes())
    def test_corrupt_payloads(self):
        for p in malformed():
            with self.assertRaises(ValueError):codec.decode(p)

def malformed():
    p=codec.encode(np.arange(4,dtype='<f4').tobytes())
    yield b'';yield p[:-1];yield p+b'X';yield b'BAD!'+p[4:]
    q=bytearray(p);struct.pack_into('<H',q,6,1);yield bytes(q)
    q=bytearray(p);struct.pack_into('<H',q,4,0);yield bytes(q)
    q=bytearray(p);struct.pack_into('<f',q,8,float('nan'));yield bytes(q)
    for index,value in [(4,0),(0,float('inf'))]:
        q=bytearray(p);struct.pack_into('<I',q,12,1);yield bytes(q)+struct.pack('<If',index,value)

def fixtures(root):
    root.mkdir(parents=True,exist_ok=True);items=[]
    for name,a in cases().items():
        payload=codec.encode(a.tobytes());(root/(name+'.bin')).write_bytes(payload)
        items.append(dict(name=name,source=a.tobytes().hex(),decoded=codec.decode(payload).hex()))
    for i,p in enumerate(malformed()):(root/f'bad-{i}.bin').write_bytes(p)
    (root/'cases.json').write_text(json.dumps(items))

def audit(assets):
    world=json.loads((assets/'world.json').read_text());tiles=world['tiles'];n=world['hn']+2*world['hm'];hm=world['hm'];core=world['hn'];available=set(map(tuple,tiles))
    chosen=[tiles[i] for i in np.linspace(0,len(tiles)-1,20,dtype=int)];rows=[];maxseam=0;oldseam=0;seams=0
    def read(tx,tz):
        b=gzip.decompress((assets/'tiles'/f'{tx}_{tz}'/'height.bin.gz').read_bytes())
        raw=np.frombuffer(b,np.uint8).reshape(4,-1).T.copy().tobytes()
        a=np.frombuffer(raw,'<f4').reshape(n,n);payload=codec.encode(raw);d=np.frombuffer(codec.decode(payload),'<f4').reshape(n,n)
        return a,d,payload
    for tx,tz in chosen:
        a,d,payload=read(tx,tz);err=float(np.max(abs(a.astype(float)-d.astype(float))));assert err<=.01
        if args.fixtures:
            name=f'real-{tx}_{tz}';(args.fixtures/(name+'.bin')).write_bytes(payload)
            cases_path=args.fixtures/'cases.json';items=json.loads(cases_path.read_text())
            items.append(dict(name=name,source=a.tobytes().hex(),decoded=d.tobytes().hex()));cases_path.write_text(json.dumps(items))
        rows.append(dict(tile=[tx,tz],maxError=err,corrections=codec.HEADER.unpack_from(payload)[-1],beforeBytes=(assets/'tiles'/f'{tx}_{tz}'/'height.bin.gz').stat().st_size,afterBytes=len(gzip.compress(payload,compresslevel=9,mtime=0))))
        for dx,dz in [(1,0),(0,1)]:
            if (tx+dx,tz+dz) not in available:continue
            b,e,_=read(tx+dx,tz+dz)
            if dx:aa,bb,dd,ee=a[:,hm+core-1],b[:,hm],d[:,hm+core-1],e[:,hm]
            else:aa,bb,dd,ee=a[hm+core-1,:],b[hm,:],d[hm+core-1,:],e[hm,:]
            np.testing.assert_array_equal(dd,aa,err_msg='Current tile core edge changed')
            np.testing.assert_array_equal(ee,bb,err_msg='Neighbor tile core edge changed')
            np.testing.assert_array_equal(dd,ee,err_msg='Shared core edge has a seam')
            oldseam=max(oldseam,float(np.max(abs(aa-bb))));maxseam=max(maxseam,float(np.max(abs(dd-ee))));seams+=1
    before=sum(r['beforeBytes'] for r in rows);after=sum(r['afterBytes'] for r in rows)
    actualbefore=sum((assets/'tiles'/f'{tx}_{tz}'/'height.bin.gz').stat().st_size for tx,tz in tiles)
    return dict(sampleMethod='20 deterministic evenly spaced manifest indices; forecast uses sampled compression ratio, not a full census',tiles=len(tiles),sample=rows,seamsChecked=seams,maxSourceSeam=oldseam,maxDecodedSeam=maxseam,maxError=max(r['maxError'] for r in rows),sampleBeforeBytes=before,sampleAfterBytes=after,allBeforeBytes=actualbefore,forecastAfterBytes=round(actualbefore*after/before))

if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(HeightCodecTest))
    if not result.wasSuccessful():raise SystemExit(1)
    if args.fixtures:fixtures(args.fixtures)
    if args.assets:
        report=audit(args.assets)
        if args.report:args.report.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps({k:v for k,v in report.items() if k!='sample'}))
