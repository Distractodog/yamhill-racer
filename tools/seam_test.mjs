// Render-only seam regression on real packed heights; no browser/server needed.
// Run through the heavy gate: all 16 LOD pairs, four tile borders and chunk edges.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { decodeHeightsV3 } from '../game/src/heightcodec_v3.js';
import { terrainGeometry, TERRAIN_STEPS } from '../game/src/terrainmesh.js';
const W = JSON.parse(await fs.readFile(new URL('../game/assets/world.json', import.meta.url)));
const NN = W.hn + 2 * W.hm, HS = W.hstep;
async function tile(tx, tz) {
  const raw = gunzipSync(await fs.readFile(new URL(`../game/assets/tiles/${tx}_${tz}/height.bin.gz`, import.meta.url)));
  const H = new Float32Array(decodeHeightsV3(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)));
  return { H, NN, x0: tx * W.tile - W.tile / 2, z0: tz * W.tile - W.tile / 2 };
}
function build(td, i0, j0, st) {
  // Deliberately different road lowering at each LOD. It must never move the
  // shared edge, while interior heights must still honour it.
  const low = (i, j, level) => td.H[i * NN + j] - (level === 1 ? 0 : level * .7);
  return terrainGeometry(td, W, low, i0, j0, i0 + 125, j0 + 125, st,
    i0 >= 250 ? 250 : 0, j0 >= 250 ? 250 : 0);
}
function edge(geo, axis, coord) {
  const pos = geo.attributes.position, normals = geo.attributes.edgeNormal, result = new Map();
  for (let k = 0; k < pos.count; k++) if (pos.array[k * 3 + axis] === coord && normals.getY(k) === 1) {
    const along = pos.array[k * 3 + (axis === 0 ? 2 : 0)];
    result.set(along, [pos.getY(k), normals.getX(k), normals.getY(k), normals.getZ(k)]);
  }
  return result;
}
function checkMesh(g, td, i0, j0, st) {
  const p = g.attributes.position, n = g.attributes.edgeNormal, idx = g.index.array;
  let area = 0;
  for (const attr of Object.values(g.attributes)) for (const v of attr.array) assert(Number.isFinite(v), 'finite mesh attributes');
  for (let k = 0; k < idx.length; k += 3) {
    const [a,b,c] = idx.slice(k,k+3);
    assert(Math.max(a,b,c) < p.count);
    const cross = (p.getZ(b)-p.getZ(a))*(p.getX(c)-p.getX(a)) - (p.getX(b)-p.getX(a))*(p.getZ(c)-p.getZ(a));
    assert(cross >= 0, 'all top triangles face up');
    area += cross / 2;
  }
  assert.equal(area, (125 * HS) ** 2, 'top covers the chunk exactly once');
  for (let k = 0; k < p.count; k++) {
    const i = (p.getZ(k)-td.z0)/HS, j = (p.getX(k)-td.x0)/HS;
    if (i > i0 && i < i0+125 && j > j0 && j < j0+125 && (i-i0)%st===0 && (j-j0)%st===0) {
      const expected = Math.fround(td.H[(i+W.hm)*NN+j+W.hm] - (st===1?0:st*.7));
      assert.equal(p.getY(k),expected,'interior road clearance unchanged');
      assert.equal(n.getY(k),0,'interior retains flat shading');
    }
  }
}
let pairs = 0;
for (const [tx,tz,axis] of [[0,0,0],[1,0,0],[0,0,2],[9,-6,0],[0,-1,2]]) {
  const a = await tile(tx,tz), b = await tile(tx+(axis===0),tz+(axis===2));
  const coord = (axis === 0 ? a.x0 : a.z0)+W.tile;
  for (let along=0; along<500; along+=125) {
    const ai=axis===0?along:375, aj=axis===0?375:along;
    const bi=axis===0?along:0, bj=axis===0?0:along;
    const ag=TERRAIN_STEPS.map(st=>build(a,ai,aj,st)), bg=TERRAIN_STEPS.map(st=>build(b,bi,bj,st));
    for(let k=0;k<4;k++) { checkMesh(ag[k],a,ai,aj,TERRAIN_STEPS[k]); checkMesh(bg[k],b,bi,bj,TERRAIN_STEPS[k]); }
    for(const ga of ag) for(const gb of bg) {
      const ea=edge(ga,axis,coord),eb=edge(gb,axis,coord);
      assert.equal(ea.size,126,'every fine sample retained'); assert.equal(eb.size,126);
      for(const [t,value] of ea) assert.deepEqual(eb.get(t),value,`border ${tx},${tz} at ${coord},${t}: height and normal`);
      pairs++;
    }
    for(const g of [...ag,...bg])g.dispose();
  }
}
const td=await tile(0,0);
for (const axis of [0,2]) for(const start of [0,125,250]) {
  const coord=(axis===0?td.x0:td.z0)+(start+125)*HS;
  for(const sa of TERRAIN_STEPS) for(const sb of TERRAIN_STEPS) {
    const a=build(td,axis===0?125:start,axis===0?start:125,sa);
    const b=build(td,axis===0?125:start+125,axis===0?start+125:125,sb);
    const ea=edge(a,axis,coord),eb=edge(b,axis,coord);
    for(const [t,value] of ea)assert.deepEqual(eb.get(t),value,'internal chunk / texture quarter edge');
    a.dispose();b.dispose();pairs++;
  }
}
console.log(`PASS ${pairs} shared-edge LOD pairs: exact heights/gradients at all 126 samples, finite attributes, winding, area, interior road clearance`);
for(const st of TERRAIN_STEPS) {
  const times=[];let triangles,vertices;
  for(let k=0;k<9;k++) { const t=performance.now(),g=build(td,125,125,st);times.push(performance.now()-t);triangles=g.index.count/3;vertices=g.attributes.position.count;g.dispose(); }
  times.sort((a,b)=>a-b);
  const cells=Math.ceil(125/st),oldTriangles=2*cells*cells+16*cells;
  console.log(`LOD ${st}: ${vertices} vertices, ${triangles} triangles (was ${oldTriangles}, delta ${triangles-oldTriangles}); build median ${times[4].toFixed(2)} ms`);
}
