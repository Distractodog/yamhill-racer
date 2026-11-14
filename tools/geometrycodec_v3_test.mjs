import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {decodeGeometry} from '../game/src/geometrycodec_v3.js';
const py=spawnSync(process.env.PYTHON||'.venv/bin/python',['-c',"import sys,json;sys.path.insert(0,'tools');from jsoncodec_v3_test import fixture;from jsoncodec_v3 import compact;x=fixture();print(json.dumps({'source':x,'encoded':compact(x)}))"],{encoding:'utf8'});
assert.equal(py.status,0,py.stderr);const f=JSON.parse(py.stdout),d=decodeGeometry(f.encoded);
assert.deepStrictEqual(d,f.source);assert(Object.is(d.paths[0].yc[0][1],-0));d.paths[0].pts[0][0]=999;assert.equal(d.physPaths[0].pts[0][0],1.23);assert.equal(d.paths[1].pts[0][0],1.23);
assert.equal(decodeGeometry(f.source),f.source);
for(const edit of [w=>w.tile.paths.$p=[-1],w=>w.tile.paths.$p=[99],w=>w.roads[0].pts={$d:[[100,100],[1],[]]},w=>w.roads[0].pts={$d:[[100,100],[0,0],[0,0]]},w=>w.roads[0].pts={$d:[[100,100],[1,0],[0]]},w=>w.roads[0].pts=[[1]]]){const w=structuredClone(f.encoded);edit(w);assert.throws(()=>decodeGeometry(w));}
// Optional reproducible full-object fixtures generated from baseline research.
const fixtures=process.argv[2];if(fixtures){const rows=JSON.parse(fs.readFileSync(fixtures,'utf8'));for(const row of rows)assert.deepStrictEqual(decodeGeometry(row.encoded),row.original);console.log(`PASS ${rows.length} real tiles: exact JS numbers including negative zero`);}
console.log('PASS exact geometry, negative zero, independent pooled references, legacy identity, malformed rejection');
