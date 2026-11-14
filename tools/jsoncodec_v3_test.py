import copy
import json
import math
import unittest
from jsoncodec_v3 import encode,decode,decode_bytes


def fixture():
    road={'pts':[[1.23,-2.34],[8.9,4.5]],'w':17,'kind':'asphalt','yc':[[10.005,-0.0],[11.004,-.0084]]}
    return {'paths':[road,road],'physPaths':[road],'ponds':{'3':10.123456789},
            'junctions':[{'c':[1.23,2.34,10.005],'ring':[[1.2,2.3,9.994,1]]}],
            'buildings':[{'pts':[[1.2,2.3]],'h':5.0051234}]}


class GeometryTest(unittest.TestCase):
    def test_exact_and_independent(self):
        source=fixture();raw=encode(source);wrapper=json.loads(raw);result=json.loads(decode_bytes(raw))
        self.assertEqual(result,source);self.assertEqual(len(wrapper['roads']),1)
        self.assertEqual(math.copysign(1,result['paths'][0]['yc'][0][1]),-1)
        result['paths'][0]['pts'][0][0]=999
        self.assertEqual(result['physPaths'][0]['pts'][0][0],1.23)
        self.assertEqual(result['paths'][1]['pts'][0][0],1.23)
        self.assertEqual(raw,encode(source))
    def test_precision_fallback_and_legacy(self):
        source=fixture();source['paths'][0]['pts'][0][0]=1.23456789123
        source['paths'][0]['yc'][0][0]=9.1234567890123
        self.assertEqual(decode(json.loads(encode(source))),source)
        raw=b'{ "paths": [], "negative": -0.0 }\n'
        self.assertIs(decode_bytes(raw),raw)
    def test_bad_matrix_and_refs(self):
        w=json.loads(encode(fixture()))
        for change in [lambda x:x['tile']['paths'].update({'$p':[-1]}),lambda x:x['tile']['paths'].update({'$p':[99]}),lambda x:x['tile']['paths'].update({'$p':[True]}),lambda x:x['roads'][0].update({'pts':{'$d':[[100,100],[1],[]]}}),lambda x:x['roads'][0].update({'pts':{'$d':[[1,1],[1,2],[]]}}),lambda x:x['roads'][0].update({'pts':{'$d':[[100,100],[0,0],[0,0]]}}),lambda x:x['roads'][0].update({'pts':{'$d':[[100,100],[1,0],[0]]}}),lambda x:x['roads'][0].update({'pts':[[1]]}),lambda x:x.update({'extra':1})]:
            bad=copy.deepcopy(w);change(bad)
            with self.assertRaises(ValueError):decode(bad)


if __name__=='__main__':unittest.main()
