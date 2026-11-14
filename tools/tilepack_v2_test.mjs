// Historical filename retained: verify the v3-only JS loader against Python decoding.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readTileData, gunzip, groundFile } from '../game/src/tilepack.js';
import { decodeTrees } from '../game/src/treecodec_v3.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yr-tilepack-v3-'));
try {
  const python = spawnSync(process.env.PYTHON || '.venv/bin/python', ['tools/tilefmt_v2_test.py', root], {encoding:'utf8'});
  assert.equal(python.status,0,python.stderr || python.error?.message); console.log(python.stdout.trim());
  const expected = JSON.parse(await fs.readFile(path.join(root,'expected.json'),'utf8'));
  const requests=[];
  const read=async name=>{requests.push(name);const b=await fs.readFile(path.join(root,'3','0_0',name));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
  const data=await readTileData(read,3);
  for(const [key,name]of [['hbuf','height.bin'],['sbuf','surface.bin'],['tbuf','trees.bin'],['pbuf','ponds.bin']])
    assert.equal(Buffer.from(data[key]).toString('hex'),expected[name],`JS/Python ${name} differs`);
  assert.deepEqual(data.tile,JSON.parse(Buffer.from(expected['tile.json'],'hex')));
  assert.deepEqual(requests,['height.bin.gz','surface.bin.gz','trees.bin.gz','ponds.bin.gz','tile.json.gz']);
  assert.equal(groundFile(3),'ground.webp');
  for(const version of [undefined,0,1,2,4,'3']){
    assert.throws(()=>groundFile(version),/expected packed v3/);
    await assert.rejects(readTileData(()=>assert.fail('unsupported formats must not fetch'),version),/expected packed v3/);
  }
  const empty=await fs.readFile(path.join(root,'empty','0_0','trees.bin.gz'));
  assert.equal(decodeTrees(await gunzip(empty)).byteLength,0);
  // A stale legacy payload cannot silently masquerade as a v3 tile.
  await assert.rejects(readTileData(async name=>{
    const b=await fs.readFile(path.join(root,'2','0_0',name));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
  },3),/Invalid/);
  console.log('PASS v3-only loader, Python-identical decoded arrays/geometry, unchanged rasters, empty trees, legacy/stale rejection');
} finally { await fs.rm(root,{recursive:true,force:true}); }
