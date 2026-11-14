"""Run with python tools/treecodec_v3_test.py; Node checks the browser decoder."""
import base64
import gzip
import json
from pathlib import Path
import subprocess
import unittest
import numpy as np
from treecodec_v3 import encode_trees, decode_trees, HEADER


class TreeCodecTest(unittest.TestCase):
    def fixture(self):
        rng = np.random.default_rng(71)
        t = np.empty((10008,4),dtype='<f4')
        t[:,:2] = rng.uniform(-15000,-13000,(len(t),2))
        t[:,2] = rng.uniform(6,48,len(t))
        t[:,3] = rng.integers(0,2,len(t))
        t[:8,0] = [-15000,-14750.001,-14750,-14500.001,-14500,-13250.001,-13250,-13000.001]
        return t

    def test_error_height_type_and_bucket_preservation(self):
        t = self.fixture(); payload = encode_trees(t.tobytes(),-7,-7)
        d = np.frombuffer(decode_trees(payload),'<f4').reshape(-1,4)
        self.assertLessEqual(np.linalg.norm(d[:,:2].astype(float)-t[:,:2],axis=1).max(),.02)
        self.assertEqual(d[:,2:].tobytes(),t[:,2:].tobytes())
        np.testing.assert_array_equal(np.floor((t[:,:2].astype(float)+15000)/250),np.floor((d[:,:2].astype(float)+15000)/250))
        self.assertGreater(HEADER.unpack_from(payload)[-1],0)

    def test_browser_decoder_matches_python_exactly(self):
        payload = encode_trees(self.fixture().tobytes(),-7,-7)
        decoder = Path(__file__).resolve().parents[1]/'game/src/treecodec_v3.js'
        if not decoder.exists(): decoder = Path(__file__).with_name('treecodec_v3.mjs')
        script = "import {decodeTrees} from " + json.dumps(decoder.as_uri()) + ";let chunks=[];for await(const c of process.stdin)chunks.push(c);let a=Buffer.from(Buffer.concat(chunks).toString(),'base64');let b=a.buffer.slice(a.byteOffset,a.byteOffset+a.byteLength);process.stdout.write(Buffer.from(decodeTrees(b)).toString('base64'));"
        result = subprocess.run(['node','--input-type=module','-e',script],input=base64.b64encode(payload),capture_output=True,check=True)
        self.assertEqual(base64.b64decode(result.stdout),decode_trees(payload))

    def test_empty_and_deterministic(self):
        self.assertEqual(decode_trees(encode_trees(b'',0,0)),b'')
        raw = self.fixture().tobytes()
        a = gzip.compress(encode_trees(raw,-7,-7),9,mtime=0)
        self.assertEqual(a,gzip.compress(encode_trees(raw,-7,-7),9,mtime=0))

    def test_invalid_input(self):
        for raw in [b'x',np.array([[0,0,np.nan,0]],'<f4').tobytes(),np.array([[0,0,10,2]],'<f4').tobytes(),np.array([[1001,0,10,0]],'<f4').tobytes()]:
            with self.assertRaises(ValueError): encode_trees(raw,0,0)

    def test_invalid_payload(self):
        payload = encode_trees(self.fixture().tobytes(),-7,-7)
        for bad in [b'',payload[:-1],b'FAIL'+payload[4:],payload+b'x']:
            with self.assertRaises(ValueError): decode_trees(bad)
        bad = bytearray(payload); n=HEADER.unpack_from(payload)[1];bad[20+n*4]|=128
        with self.assertRaises(ValueError): decode_trees(bad)


if __name__=='__main__': unittest.main()
