// Cross-language decoder identity, exact source bits, and malformed payload rejection.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const repo=path.resolve(process.argv[2]||path.join(path.dirname(fileURLToPath(import.meta.url)),'..'));
const pyTest=process.argv[3]||path.join(repo,'tools/heightcodec_v3_test.py');
const {decodeHeightsV3}=await import(pathToFileURL(path.join(repo,'game/src/heightcodec_v3.js')));
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'height-v3-'));
try {
 const p=spawnSync(process.env.PYTHON||path.join(repo,'.venv/bin/python'),[pyTest,'--repo',repo,'--fixtures',tmp,...(process.argv[4]?['--assets',path.resolve(process.argv[4])]:[])],{encoding:'utf8'});
 assert.equal(p.status,0,p.stdout+p.stderr);console.log(p.stderr.trim());
 const cases=JSON.parse(await fs.readFile(path.join(tmp,'cases.json'),'utf8'));
 for(const c of cases){
  const b=await fs.readFile(path.join(tmp,c.name+'.bin'));const decoded=decodeHeightsV3(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));
  assert.equal(Buffer.from(decoded).toString('hex'),c.decoded,c.name+' Python/JS bit disagreement');
  const src=Buffer.from(c.source,'hex'),dv=new DataView(decoded);let max=0;
  for(let i=0;i<src.length;i+=4)max=Math.max(max,Math.abs(src.readFloatLE(i)-dv.getFloat32(i,true)));
  assert.equal(Buffer.from(decoded).toString('hex'),c.source,c.name+' source bits changed');
 }
 for(const name of await fs.readdir(tmp))if(name.startsWith('bad-')){
  const b=await fs.readFile(path.join(tmp,name));assert.throws(()=>decodeHeightsV3(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)),name);
 }
 console.log(`PASS ${cases.length} grids (adversarial plus optional real tiles), Python/JS bit identity, exact source float32 bits, malformed inputs`);
}finally{await fs.rm(tmp,{recursive:true,force:true});}
