import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {createMapDetail,mapVisibleTiles,mapDetailLevel,simplifyMapLine,prepareMapTile,MAP_DETAIL_LIMITS} from '../game/src/mapdetail.js';
assert.deepEqual([.1,.3,.9,2].map(mapDetailLevel),[0,1,2,3]);
const available=new Set(Array.from({length:100},(_,i)=>`${i%10}_${Math.floor(i/10)}`));
assert.equal(mapVisibleTiles([-1000,-1000,19000,19000],2000,available).length,MAP_DETAIL_LIMITS.tiles);
assert.deepEqual(simplifyMapLine([[0,0],[1,0],[2,0],[3,0]]),[[0,0],[3,0]]);
assert.equal(simplifyMapLine([[0,0],[1,4],[2,0]],1).length,3);
const raw={paths:[{kind:'asphalt',cls:'primary',w:14,pts:[[0,0],[1,0],[20,0]]}],buildings:[{pts:[[2,4],[5,4],[5,8],[2,8]]}]};
const compiled=prepareMapTile(raw);assert.equal(compiled.roads[0].name,null);assert.equal(compiled.roads[0].major,true);assert.equal(compiled.buildings.length,1);
let loads=0,maxActive=0,active=0;
const manifest={tile:2000,packed:0,tiles:[...available].map(k=>k.split('_').map(Number))};
const detail=createMapDetail('test/',{fetcher:async(url,{signal}={})=>{
 if(url.endsWith('world.json'))return{ok:true,json:async()=>manifest};loads++;active++;maxActive=Math.max(maxActive,active);
 await new Promise(r=>setTimeout(r,2));active--;if(signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});return{ok:true,json:async()=>raw};
}});
async function settle(){const deadline=Date.now()+30000;while(detail.stats.pending||detail.stats.cached<detail.stats.wanted){if(Date.now()>deadline)throw new Error('detail requests did not settle');await new Promise(r=>setTimeout(r,10));}}
await detail.ready;detail.update([-500,-500,500,500],.1);assert.equal(loads,0,'overview must not download tile detail');
detail.update([-1000,-1000,7000,7000],1);await settle();assert.equal(detail.stats.pending,0);assert(maxActive<=MAP_DETAIL_LIMITS.concurrent);assert.equal(detail.stats.cached,20);
detail.update([11000,11000,19000,19000],2);await settle();assert(detail.stats.cached<=20);assert(detail.stats.cached>0);
const n=loads;detail.update([11000,11000,19000,19000],2);await new Promise(r=>setTimeout(r,10));assert.equal(loads,n,'cache must avoid refetches');detail.dispose();assert.equal(detail.stats.cached,0);
const data=JSON.parse(zlib.gunzipSync(fs.readFileSync('game/assets/tiles/0_0/tile.json.gz')));const t=performance.now(),tile=prepareMapTile(data);const before=data.paths.reduce((n,p)=>n+p.pts.length,0),after=tile.roads.reduce((n,p)=>n+p.pts.length,0);
assert(after<before);assert(tile.roads.every(r=>r.pts.length>=2&&r.fine.length>=r.pts.length));
const high=tile.roads.reduce((n,r)=>n+r.fine.length,0);assert(high<before);
console.log(`PASS: zoom detail levels, bounded visible tiles, line simplification, no fabricated names, overview no-fetch, concurrency ${maxActive}, LRU cache, real campus paths ${before}→${after} points (${Math.round(performance.now()-t)} ms).`);
