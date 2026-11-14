"""V3 verification: bounds, metadata, seams, corruption and complete size report."""
import contextlib
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image
import tilefmt
import heightcodec_v3
import treecodec_v3
import jsoncodec_v3
import verify_pack


class VerifyV3Test(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.src=Path(self.tmp.name)/'before';self.dst=Path(self.tmp.name)/'after'
        self.world={'packed':2,'tile':2000,'hn':3,'hm':1,'hstep':1000,'surfN':2,'tiles':[[0,0],[1,0]],'ponds':[]}
        for root in (self.src,self.dst):
            root.mkdir();w={**self.world,'packed':2 if root==self.src else 3};(root/'world.json').write_text(json.dumps(w));(root/'navigation.json').write_text('{}')
        self.raw={}
        for tx in (0,1):
            tile={'tx':tx,'tz':0,'buildings':[{'pts':[[0,0],[2,0],[0,2]],'h':3.004}],
                  'paths':[{'kind':'asphalt','w':17,'pts':[[0,0],[10,0]],'yc':[[100.004,.0014],[100.004,.0014]]}],
                  'physPaths':[],'junctions':[{'kind':'asphalt','c':[0,0,100.004],'ring':[[0,0,100.004,1],[2,0,100.004,0],[0,2,100.004,0]]}],
                  'physJunctions':[],'ponds':{}}
            tile['physPaths']=copy.deepcopy(tile['paths']);tile['physJunctions']=copy.deepcopy(tile['junctions'])
            raw={'height.bin':np.full((5,5),100,dtype='<f4').tobytes(),'surface.bin':bytes([0,1,3,5]),'ponds.bin':bytes(50),
                 'trees.bin':np.array([[tx*2000+249.999,1.234,10.125,1]],'<f4').tobytes(),'tile.json':json.dumps(tile).encode()}
            self.raw[tx]=raw
            s=self.src/'tiles'/f'{tx}_0';d=self.dst/'tiles'/f'{tx}_0';s.mkdir(parents=True);d.mkdir(parents=True)
            for name,data in raw.items():
                p=tilefmt.shuffle4(data) if name in ('height.bin','trees.bin') else data
                (s/(name+'.gz')).write_bytes(gzip.compress(p,mtime=0));self.write(tx,name,data)
            Image.new('RGB',(4,4),(30,60,90)).save(s/'ground.jpg');Image.new('RGB',(4,4),(30,60,90)).save(d/'ground.webp',lossless=True)

    def write(self,tx,name,data):
        if name=='height.bin':data=heightcodec_v3.encode(data)
        if name=='trees.bin':data=treecodec_v3.encode_trees(data,tx,0)
        if name=='tile.json':data=jsoncodec_v3.encode(json.loads(data))
        (self.dst/'tiles'/f'{tx}_0'/(name+'.gz')).write_bytes(gzip.compress(data,mtime=0))

    def report(self):
        with contextlib.redirect_stdout(io.StringIO()):return verify_pack.verify(self.src,self.dst)

    def fails(self,fragment):
        r=self.report();self.assertFalse(r['passed']);self.assertIn(fragment,json.dumps(r['errors']))

    def test_pass_and_complete_size_report(self):
        r=self.report();self.assertTrue(r['passed'],r);self.assertEqual(r['shared_core_seams_checked'],1)
        self.assertEqual(r['tree_count'],2);self.assertIn('navigation.json',[x['type'] for x in r['size_table']])
        self.assertEqual(r['total_after_bytes'],sum(p.stat().st_size for p in self.dst.rglob('*') if p.is_file()))
        self.assertNotIn(self.tmp.name,json.dumps(r))
        out=Path(self.tmp.name)/'report.json'
        with contextlib.redirect_stdout(io.StringIO()):code=verify_pack.main(self.src,self.dst,[],out)
        self.assertEqual(code,0);self.assertTrue(json.loads(out.read_text())['passed'])

    def test_height_error_and_seams(self):
        self.write(0,'height.bin',np.full((5,5),100.05,dtype='<f4').tobytes());self.fails('heights error')
        import struct
        legacy=struct.pack('<4sHHfI',b'H3Q0',5,0,100.001,0)+bytes(50)
        (self.dst/'tiles/0_0/height.bin.gz').write_bytes(gzip.compress(legacy,mtime=0));self.fails('height seams')

    def test_tree_position_height_type_and_bucket(self):
        original=np.frombuffer(self.raw[0]['trees.bin'],'<f4').reshape(-1,4)
        for index,change,reason in [(0,.1,'tree radial'),(2,.001,'heights/types'),(3,-1,'heights/types'),(0,.002,'render bucket')]:
            a=original.copy();a[0,index]+=change;self.write(0,'trees.bin',a.tobytes());self.fails(reason)

    def test_rasters_and_json_physics(self):
        for name in ('surface.bin','ponds.bin'):
            self.write(0,name,b'bad');self.fails(name);self.write(0,name,self.raw[0][name])
        j=json.loads(self.raw[0]['tile.json']);j['ponds']={'1':123};self.write(0,'tile.json',json.dumps(j).encode());self.fails('ponds')
        j=json.loads(self.raw[0]['tile.json']);j['physPaths'][0]['yc'][0][1]+=.01;self.write(0,'tile.json',json.dumps(j).encode());self.fails('overlay bound')
        j=json.loads(self.raw[0]['tile.json']);j['physJunctions'][0]['ring'][0][3]=0;self.write(0,'tile.json',json.dumps(j).encode());self.fails('flags')

    def test_subcentimetre_road_geometry_preserved(self):
        tile=json.loads(self.raw[0]['tile.json'])
        for key in ('paths','physPaths'):
            tile[key][0]['pts'][0][0]=.0043
        for key in ('junctions','physJunctions'):
            tile[key][0]['c'][0]=.0043
            tile[key][0]['ring'][0][0]=.0043
        raw=json.dumps(tile).encode()
        # This fixture intentionally tests the verifier independently of the
        # geometry encoder: unchanged subcentimetre geometry remains valid.
        for root in (self.src,self.dst):
            (root/'tiles/0_0/tile.json.gz').write_bytes(gzip.compress(raw,mtime=0))
        self.assertTrue(self.report()['passed'])
        tile['physPaths'][0]['pts'][0][0]+=.001
        (self.dst/'tiles/0_0/tile.json.gz').write_bytes(gzip.compress(json.dumps(tile).encode(),mtime=0))
        self.fails('physPaths coordinates')

    def test_exact_height_subtype_rejects_tiny_error(self):
        # Decoder implementation is tested separately. Mark this fixture as
        # flag8 and supply its decoded bytes to isolate verifier policy now.
        import struct
        path=self.dst/'tiles/0_0/height.bin.gz'
        payload=bytearray(gzip.decompress(path.read_bytes()));struct.pack_into('<H',payload,6,8)
        path.write_bytes(gzip.compress(payload,mtime=0))
        reader=tilefmt.read_bytes
        original=self.raw[0]['height.bin']
        def checked(raw):
            def read(folder,name):
                if Path(folder)==path.parent and name=='height.bin':return raw
                return reader(folder,name)
            return read
        with patch.object(tilefmt,'read_bytes',side_effect=checked(original)):
            r=self.report();self.assertTrue(r['passed']);self.assertEqual(r['exact_height_tiles_checked'],2)
        values=np.frombuffer(original,'<f4').copy();values[0]+=.0001
        with patch.object(tilefmt,'read_bytes',side_effect=checked(values.tobytes())):
            self.fails('exact height sample bits')
        # Plain flag0 fixture remains checked by its quantization/seam bounds.
        legacy=struct.pack('<4sHHfI',b'H3Q0',5,0,100,0)+bytes(50)
        path.write_bytes(gzip.compress(legacy,mtime=0))
        r=self.report();self.assertTrue(r['passed']);self.assertEqual(r['exact_height_tiles_checked'],1)

    def test_exact_tree_subthreshold_and_signed_zero(self):
        a=np.frombuffer(self.raw[0]['trees.bin'],'<f4').reshape(-1,4).copy()
        a[0,1]+=.0001
        self.write(0,'trees.bin',a.tobytes());self.fails('exact tree record bits')
        a=np.frombuffer(self.raw[0]['trees.bin'],'<f4').reshape(-1,4).copy();a[0,1]=0
        raw=a.tobytes();self.raw[0]['trees.bin']=raw
        (self.src/'tiles/0_0/trees.bin.gz').write_bytes(gzip.compress(tilefmt.shuffle4(raw),mtime=0))
        a[0,1]=-0.0;self.write(0,'trees.bin',a.tobytes());self.fails('exact tree record bits')

    def test_exact_geometry_subthreshold_and_negative_zero(self):
        original=json.loads(self.raw[0]['tile.json'])
        changed=copy.deepcopy(original);changed['physPaths'][0]['yc'][0][0]+=.0001
        self.write(0,'tile.json',json.dumps(changed).encode());self.fails('exact number')
        original['paths'][0]['yc'][0][1]=-0.0
        (self.src/'tiles/0_0/tile.json.gz').write_bytes(gzip.compress(json.dumps(original).encode(),mtime=0))
        self.write(0,'tile.json',json.dumps(original).encode());self.assertTrue(self.report()['passed'])
        changed=copy.deepcopy(original);changed['paths'][0]['yc'][0][1]=0.0
        self.write(0,'tile.json',json.dumps(changed).encode());self.fails('exact number')

    def test_exactness_counters_and_legacy_v3_tree(self):
        r=self.report();self.assertEqual(r['exact_tree_tiles_checked'],2);self.assertEqual(r['exact_geometry_tiles_checked'],2)
        # Legacy TRV3 remains verifiable under its old tolerance, not falsely
        # labelled bit-exact. Coordinates here are represented exactly.
        import struct
        raw=struct.pack('<4f',0,0,8,0)
        (self.src/'tiles/0_0/trees.bin.gz').write_bytes(gzip.compress(tilefmt.shuffle4(raw),mtime=0))
        payload=treecodec_v3.HEADER.pack(b'TRV3',1,0,0,0)+struct.pack('<HH',25000,25000)+b'\0'+struct.pack('<f',8)
        (self.dst/'tiles/0_0/trees.bin.gz').write_bytes(gzip.compress(payload,mtime=0))
        r=self.report();self.assertTrue(r['passed']);self.assertEqual(r['exact_tree_tiles_checked'],1)

    def test_optional_receipt_checksums(self):
        src=self.src/'tiles/0_0';dst=self.dst/'tiles/0_0'
        sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        receipt={'version':3,'source':{p.name:sha(p) for p in src.iterdir()},'files':{p.name:sha(p) for p in dst.iterdir()}}
        (dst/'v3.json').write_text(json.dumps(receipt))
        self.assertTrue(self.report()['passed'])
        receipt['files']['ground.webp']='0'*64
        (dst/'v3.json').write_text(json.dumps(receipt));self.fails('destination checksums')
        receipt['files']['ground.webp']=sha(dst/'ground.webp');receipt['source']['ground.jpg']='0'*64
        (dst/'v3.json').write_text(json.dumps(receipt));self.fails('source checksums')
        receipt['version']=4
        (dst/'v3.json').write_text(json.dumps(receipt));self.fails('receipt schema')

    def test_receipt_profiles(self):
        src=self.src/'tiles/0_0';dst=self.dst/'tiles/0_0'
        sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
        files={p.name:sha(p) for p in dst.iterdir()}
        source={p.name:sha(p) for p in src.iterdir()}
        profiles={name:{'codec':'a'*64,'source':source['ground.jpg' if name=='ground.webp' else name]} for name in files}
        profiles['ground.webp']['codec']='legacy-unrecorded'
        receipt={'version':3,'source':source,'files':files,'profiles':profiles}
        def write(r):(dst/'v3.json').write_text(json.dumps(r))
        write(receipt);self.assertTrue(self.report()['passed'])
        for mutate,reason in [(lambda r:r['profiles']['height.bin.gz'].update(codec='bad'),'codec profile'),(lambda r:r['profiles']['trees.bin.gz'].update(source='0'*64),'profile source'),(lambda r:r['profiles'].pop('ground.webp'),'profiles schema')]:
            bad=copy.deepcopy(receipt);mutate(bad);write(bad);self.fails(reason)

    def test_baseline_receipt_excluded_only_from_before_size(self):
        before=self.report()
        (self.src/'baseline.json').write_text('metadata excluded')
        (self.dst/'baseline.json').write_text('published bytes included')
        after=self.report()
        self.assertEqual(before['total_before_bytes'],after['total_before_bytes'])
        self.assertEqual(after['total_after_bytes']-before['total_after_bytes'],len('published bytes included'))

    def test_full_size_budget_gate(self):
        original=verify_pack.sizes
        def fake_sizes(root,exclude_baseline=False):
            return {'fixture':450_000_001} if Path(root)==self.dst else original(root,exclude_baseline)
        with patch.object(verify_pack,'sizes',side_effect=fake_sizes):
            self.fails('450000000 byte limit')
            with contextlib.redirect_stdout(io.StringIO()):partial=verify_pack.verify(self.src,self.dst,['0,0'])
            self.assertTrue(partial['passed']);self.assertIsNone(partial['size_limit_bytes'])

    def test_corruption_and_failure_exit(self):
        (self.dst/'tiles/0_0/trees.bin.gz').write_bytes(b'corrupt')
        self.fails('gzip')
        with contextlib.redirect_stdout(io.StringIO()):self.assertEqual(verify_pack.main(self.src,self.dst,[]),1)


if __name__=='__main__':unittest.main()
