"""Actual converter integration tests using small v2 fixtures; no game assets touched."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from PIL import Image

parser=argparse.ArgumentParser();parser.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[1]);parser.add_argument('--converter',type=Path);args = (parser.parse_args() if __name__ == '__main__' else argparse.Namespace(repo=Path(__file__).resolve().parents[1], converter=None))
sys.path.insert(0,str(args.repo/'tools'))
spec=importlib.util.spec_from_file_location('converter',args.converter or args.repo/'tools/repack_v3.py');converter=importlib.util.module_from_spec(spec);spec.loader.exec_module(converter)

def snapshot(root):
    return {str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}

def fixture(root):
    assets=root/'assets';assets.mkdir();(assets/'world.json').write_text(json.dumps({'packed':2,'tiles':[[0,0],[1,0]]}))
    (assets/'unchanged.txt').write_text('unchanged metadata')
    for tx in (0,1):
        tile=assets/'tiles'/f'{tx}_0';tile.mkdir(parents=True)
        files={'height.bin':np.arange(81,dtype='<f4').reshape(9,9).tobytes(),
               'trees.bin':struct.pack('<4f',tx*2000+1.004,2.006,12,0),
               'surface.bin':b'\x03'*81,'ponds.bin':b'\0\0'*81,
               'tile.json':json.dumps({'paths':[],'junctions':[],'buildings':[],'ponds':{}}).encode()}
        for name,raw in files.items():
            if name in ('height.bin','trees.bin'):raw=np.frombuffer(raw,np.uint8).reshape(-1,4).T.tobytes()
            (tile/(name+'.gz')).write_bytes(gzip.compress(raw,mtime=0))
        Image.new('RGB',(16,16),(30,80,130)).save(tile/'ground.jpg')
    return assets,root/'backup',root/'scratch'

class RepackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.assets,self.backup,self.scratch=fixture(self.root)
    def tearDown(self):self.temp.cleanup()
    def run_repack(self,limit=None,refresh=None):return converter.repack(self.assets,self.backup,self.scratch,limit,refresh)
    def test_limit_resume_deterministic_and_backup_unchanged(self):
        original=snapshot(self.assets)
        first=self.run_repack(1);self.assertEqual(first,{'complete':False,'converted':1,'skipped':0})
        self.assertEqual(json.loads((self.assets/'world.json').read_text())['packed'],2)
        backup=snapshot(self.backup);self.assertEqual({k:v for k,v in backup.items() if k!='baseline.json'},original)
        second=self.run_repack();self.assertEqual(second,{'complete':True,'converted':1,'skipped':1})
        self.assertEqual(json.loads((self.assets/'world.json').read_text())['packed'],3)
        final=snapshot(self.assets)
        self.assertEqual(self.run_repack(),{'complete':True,'converted':0,'skipped':2})
        self.assertEqual(snapshot(self.assets),final);self.assertEqual(snapshot(self.backup),backup)
        # Recreate an output from the original source, rather than re-quantizing v3.
        shutil.rmtree(self.assets/'tiles/0_0');self.run_repack()
        self.assertEqual(snapshot(self.assets),final);self.assertEqual(snapshot(self.backup),backup)
    def test_corrupt_output_and_receipt_repaired(self):
        self.run_repack();expected=snapshot(self.assets);backup=snapshot(self.backup)
        (self.assets/'tiles/0_0/height.bin.gz').write_bytes(b'corrupted')
        (self.assets/'tiles/1_0/v3.json').write_text('{broken')
        result=self.run_repack();self.assertEqual(result['converted'],2)
        self.assertEqual(snapshot(self.assets),expected);self.assertEqual(snapshot(self.backup),backup)
        (self.assets/'tiles/0_0/v3.json').write_text('[]')
        self.assertEqual(self.run_repack()['converted'],1)
        self.assertEqual(snapshot(self.assets),expected)
    def test_changed_source_fails_closed(self):
        for relative in ('world.json','tiles/1_0/trees.bin.gz','unchanged.txt'):
            with self.subTest(path=relative):
                if not self.backup.exists():self.run_repack(1)
                path=self.backup/relative;old=path.read_bytes();before=snapshot(self.assets)
                path.write_bytes(old+b'changed')
                with self.assertRaisesRegex(ValueError,'Immutable backup'):self.run_repack()
                self.assertEqual(snapshot(self.assets),before);path.write_bytes(old)
    def test_interrupted_file_install_then_resumes(self):
        replace=converter.os.replace;calls=[]
        def fail_install(source,target):
            target=Path(target)
            if target.parent.resolve()==(self.assets/'tiles/0_0').resolve():
                calls.append(target.name)
                if target.name=='trees.bin.gz':raise OSError('injected interruption')
            return replace(source,target)
        with patch.object(converter.os,'replace',fail_install):
            with self.assertRaisesRegex(OSError,'injected interruption'):self.run_repack()
        self.assertFalse((self.assets/'tiles/0_0/v3.json').exists())
        self.assertTrue((self.assets/'tiles/0_0/ground.jpg').exists())
        self.assertTrue(self.run_repack()['complete'])
        for key in ('0_0','1_0'):converter.verify_receipt(self.assets/'tiles'/key,self.backup/'tiles'/key)
    def test_selected_refresh_preserves_imagery_and_profiles(self):
        self.run_repack();before=snapshot(self.assets);profile=converter.codec_profile
        def changed(name):return 'changed-height-profile' if name=='height.bin.gz' else profile(name)
        with patch.object(converter,'codec_profile',changed):
            with patch.object(converter.tilefmt,'write_ground',side_effect=AssertionError('Imagery must be copied')):
                self.assertEqual(self.run_repack(refresh=['height.bin'])['converted'],2)
                after=snapshot(self.assets)
                self.assertEqual(self.run_repack(refresh=['height.bin'])['skipped'],2)
                self.assertEqual(snapshot(self.assets),after)
        for key in ('0_0','1_0'):
            for name in converter.FILES:self.assertEqual(before[f'tiles/{key}/{name}'],after[f'tiles/{key}/{name}'])
            receipt=json.loads((self.assets/'tiles'/key/'v3.json').read_text())
            self.assertEqual(receipt['profiles']['height.bin.gz']['codec'],'changed-height-profile')
    def test_interrupted_refresh_receipt_last(self):
        self.run_repack();before=snapshot(self.assets);profile=converter.codec_profile;replace=converter.os.replace
        def changed(name):return 'next-tree-codec' if name=='trees.bin.gz' else profile(name)
        def stop_receipt(source,target):
            target=Path(target)
            if target.parent.resolve()==(self.assets/'tiles/0_0').resolve() and target.name=='v3.json':raise OSError('receipt interruption')
            return replace(source,target)
        with patch.object(converter,'codec_profile',changed):
            with patch.object(converter.os,'replace',stop_receipt):
                with self.assertRaisesRegex(OSError,'receipt interruption'):self.run_repack(refresh=['trees.bin'])
            self.assertEqual(snapshot(self.assets)['tiles/0_0/v3.json'],before['tiles/0_0/v3.json'])
            self.assertEqual(self.run_repack(refresh=['trees.bin'])['converted'],2)
            self.assertEqual(self.run_repack(refresh=['trees.bin'])['skipped'],2)
        self.assertEqual(snapshot(self.assets)['tiles/0_0/ground.webp'],before['tiles/0_0/ground.webp'])
    def test_refresh_old_receipt_and_unknown_files(self):
        self.run_repack()
        for key in ('0_0','1_0'):
            p=self.assets/'tiles'/key/'v3.json';r=json.loads(p.read_text());r.pop('profiles');p.write_text(json.dumps(r))
        with patch.object(converter.tilefmt,'write_ground',side_effect=AssertionError('Imagery must be copied')):
            self.assertEqual(self.run_repack(refresh=['trees.bin','tile.json'])['converted'],2)
            self.assertEqual(self.run_repack(refresh=['trees.bin','tile.json'])['skipped'],2)
        original=snapshot(self.assets)
        with self.assertRaises(ValueError):self.run_repack(refresh=['ground.webp'])
        self.assertEqual(snapshot(self.assets),original)
        extra=self.assets/'tiles/1_0'/'height 2.bin.gz';extra.write_bytes(b'user file')
        before=snapshot(self.assets)
        with self.assertRaisesRegex(ValueError,'Unexpected files'):self.run_repack()
        self.assertEqual(snapshot(self.assets),before)
    def test_overlap_rejected_before_mutation(self):
        original=snapshot(self.assets)
        for scratch in (self.assets,self.assets/'tmp',self.root,self.backup,self.backup/'tmp'):
            with self.subTest(scratch=str(scratch)),self.assertRaises(ValueError):converter.repack(self.assets,self.backup,scratch)
        self.assertEqual(snapshot(self.assets),original);self.assertFalse(self.backup.exists())
    def test_incomplete_backup_fails_closed(self):
        self.backup.mkdir();(self.backup/'world.json').write_text('{broken')
        with self.assertRaisesRegex(ValueError,'completed baseline receipt'):self.run_repack()

if __name__=='__main__':unittest.main(argv=[sys.argv[0]],verbosity=2)
