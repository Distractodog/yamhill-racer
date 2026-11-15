// Probe every widened strip and gore in a scratch build. No browser or tile writes.
// node tools/ramp_surface_test.mjs <scratch-assets>
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { rampExtraWidth, roadEdge, triangleHeight } from '../game/src/ramps.js';
const assets = process.argv[2] || 'game/assets';
const W = JSON.parse(fs.readFileSync(`${assets}/world.json`));
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
assert.equal(rampExtraWidth([[1, 0, 30, 0, 6.5]], 15, 1), 3.25);
assert.equal(rampExtraWidth([[1, 30, 90, 6.5, 6.5]], 50, 1), 0);
let points = 0, strips = 0, gores = 0, maxError = 0, overlaps = 0;
for (const [tx, tz] of W.tiles) {
  const folder = `${assets}/tiles/${tx}_${tz}`;
  const data = W.packed ? await readTileData(async f => ab(`${folder}/${f}`), W.packed) : {
    hbuf: ab(`${folder}/height.bin`), sbuf: ab(`${folder}/surface.bin`),
    tbuf: ab(`${folder}/trees.bin`), pbuf: ab(`${folder}/ponds.bin`),
    tile: JSON.parse(fs.readFileSync(`${folder}/tile.json`)),
  };
  if (!data.tile.paths.some(p => p.widen) && !data.tile.junctions.some(j => j.gore)) continue;
  const td = makeTileData(W, tx, tz, data);
  const grid = new Map(), key = (x,z) => `${Math.floor(x/10)},${Math.floor(z/10)}`;
  function add(A,B,C) {
    for (let x=Math.floor(Math.min(A[0],B[0],C[0])/10); x<=Math.floor(Math.max(A[0],B[0],C[0])/10); x++)
      for (let z=Math.floor(Math.min(A[1],B[1],C[1])/10); z<=Math.floor(Math.max(A[1],B[1],C[1])/10); z++) {
        const k = `${x},${z}`; if (!grid.has(k)) grid.set(k,[]); grid.get(k).push([A,B,C]);
      }
  }
  for (const r of td.renderRoads) for (let i=0; i<r.n-1; i++) {
    const A=roadEdge(r,i,1),B=roadEdge(r,i,-1),C=roadEdge(r,i+1,-1),D=roadEdge(r,i+1,1);
    add(A,B,C); add(A,C,D);
  }
  for (const j of td.renderJunctions) for (let i=0; i<j.ring.length; i++) add(j.c,j.ring[i],j.ring[(i+1)%j.ring.length]);
  function probe(A, B, C) {
    for (let i = 1; i < 8; i++) for (let j = 1; j < 8 - i; j++) {
      const a = i / 8, b = j / 8, c = 1 - a - b;
      const x = a*A[0]+b*B[0]+c*C[0], z = a*A[1]+b*B[1]+c*C[1];
      if (x < td.x0 || x >= td.x0+W.tile || z < td.z0 || z >= td.z0+W.tile) continue;
      const y = a*A[2]+b*B[2]+c*C[2], h = td.heightAt(x,z);
      assert.equal(td.surfaceAt(x,z), 3, `asphalt at ${x},${z}`);
      // At overlaps compare with the highest drawn surface, including any overpass.
      let drawn = y;
      for (const [a,b,c] of grid.get(key(x,z)) || []) drawn = Math.max(drawn,triangleHeight(x,z,a,b,c));
      if (drawn > y + .02) overlaps++;
      const error = Math.abs(h-drawn); maxError = Math.max(maxError,error);
      assert.ok(error <= .02, `height mismatch ${error} at ${x},${z}`); points++;
    }
  }
  for (const r of td.renderRoads.filter(r => r.widen)) {
    strips++;
    for (let i=0; i<r.n-1; i++) {
      if (!r.widen.some(([,s0,s1]) => r.s[i+1] >= s0 && r.s[i] <= s1)) continue;
      const A=roadEdge(r,i,1), B=roadEdge(r,i,-1), C=roadEdge(r,i+1,-1), D=roadEdge(r,i+1,1);
      probe(A,B,C); probe(A,C,D);
    }
  }
  for (const j of td.renderJunctions.filter(j => j.gore)) {
    gores++;
    for (let i=0; i<j.ring.length; i++) probe(j.c,j.ring[i],j.ring[(i+1)%j.ring.length]);
  }
}
console.log(JSON.stringify({strips,gores,points,maxError,overlaps}));
assert.ok(strips > 0 && gores > 0 && points > 0, 'fixture must cover tapers and gores');
