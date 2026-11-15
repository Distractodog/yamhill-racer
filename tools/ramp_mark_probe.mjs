// Node-only geometry QA. Supply one or more scratch asset roots, e.g.:
// node tools/ramp_mark_probe.mjs data/raw/rj2/new-sh data/raw/rj2/new-w data/raw/rj2/new-mc
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { prepRoad } from '../game/src/data.js';
import { buildRoads, buildJunctions, edgeLines } from '../game/src/roads.js';
import { readTileData } from '../game/src/tilepack.js';
import { roadArc, roadPoint, laneWidth, rampNoses } from '../game/src/rampmarks.js';
import { roadEdge, triangleHeight } from '../game/src/ramps.js';
import * as THREE from 'three';
const roots = process.argv.slice(2);
assert(roots.length, 'supply scratch asset roots');
const ab = async f => { const b = await fs.readFile(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
const white = new THREE.Color(0xf2f2ea), yellow = new THREE.Color(0xf3c63c);
function quads(mesh, rgb) {
  const p = mesh.geometry.attributes.position.array, c = mesh.geometry.attributes.color.array, out = [];
  for (let k = 0; k < p.length; k += 9) {
    if (Math.abs(c[k] - rgb.r) > 1e-5 || Math.abs(c[k + 1] - rgb.g) > 1e-5 || Math.abs(c[k + 2] - rgb.b) > 1e-5) continue;
    const q = [0, 3, 6, 15].map(i => [p[k + i], p[k + i + 2]]); q.y = p[k + 1]; out.push(q); k += 9;
  }
  return out;
}
// Positive-area convex quad intersection; shared endpoints/edges are allowed. Float32 world coordinates
// quantize at ~2 mm in the eastern tiles, so require > 5 mm penetration before reporting a crossing.
function overlap(a, b) {
  if (Math.abs(a.y - b.y) > 2) return false; // grade-separated overpasses
  for (const q of [a, b]) for (let i = 0; i < 4; i++) {
    const u = q[i], v = q[(i + 1) % 4], nx = v[1] - u[1], nz = u[0] - v[0], L = Math.hypot(nx, nz);
    if (L < 1e-6) continue;
    const aa = a.map(p => (p[0] * nx + p[1] * nz) / L), bb = b.map(p => (p[0] * nx + p[1] * nz) / L);
    if (Math.min(Math.max(...aa), Math.max(...bb)) - Math.max(Math.min(...aa), Math.min(...bb)) < .005) return false;
  }
  return true;
}
function inside(p, tri) {
  const cr = (a,b) => (a[0]-p[0])*(b[2]-p[2])-(a[2]-p[2])*(b[0]-p[0]);
  const s = [cr(tri[0],tri[1]), cr(tri[1],tri[2]), cr(tri[2],tri[0])];
  return s.every(x=>x>=-1e-4)||s.every(x=>x<=1e-4);
}
for (const cls of ['trunk_link','trunk','residential']) for (const sidewalk of [undefined,'both']) {
  const r=prepRoad({kind:'asphalt',cls,w:10,pts:[[5000,5000],[5000,5030]],widen:[[1,0,15,0,4]],sidewalk},0);
  assert.equal(edgeLines(r,false),cls!=='residential' && !sidewalk);
  assert.equal(edgeLines(r,true),true);
  const m=buildRoads({renderRoads:[r]},mat,[{r,a:0,b:r.n-1}]);
  if(sidewalk || cls==='residential') assert.equal(quads(m,white).length,0,'ordinary special strips obey edge eligibility');
  m.geometry.dispose();
}
let tiles = 0, lanes = 0, painted = 0, joined = 0;
for (const root of roots) {
  const W = JSON.parse(await fs.readFile(root + '/world.json'));
  for (const name of await fs.readdir(root + '/tiles')) {
    const dir = root + '/tiles/' + name + '/';
    const tile = W.packed ? (await readTileData(f => ab(dir + f), W.packed)).tile : JSON.parse(await fs.readFile(dir + 'tile.json'));
    const roads = tile.paths.map((p,i) => prepRoad(p,i)).filter(Boolean), D = { renderRoads: roads };
    const batch = roads.filter(r => r.widen || r.osm?.includes('_link')).map(r => ({r,a:0,b:r.n-1}));
    const near = buildRoads(D, mat, batch), far = buildRoads(D, mat, batch, true);
    const marks = [...quads(near, white), ...quads(near, yellow)], gores = tile.junctions.filter(j=>j.gore);
    assert.equal(quads(far,white).length + quads(far,yellow).length,0,'far strips must not have paint');
    for (const j of gores) {
      const mesh = buildJunctions([j],mat,false);
      // RJ-3 physics retains the junction fan. Its rendered triangle planes must remain identical.
      const pos=mesh.geometry.attributes.position.array;
      for(let i=0;i<j.ring.length;i++) {
        const expected=[j.c,j.ring[i],j.ring[(i+1)%j.ring.length]];
        const x=expected.reduce((s,p)=>s+p[0]/3,0),z=expected.reduce((s,p)=>s+p[1]/3,0);
        const actual=[0,3,6].map(k=>[pos[i*9+k],pos[i*9+k+2],pos[i*9+k+1]]);
        assert(Math.abs(triangleHeight(x,z,...actual)-triangleHeight(x,z,...expected))<.002,'gore fan matches physics');
      }
      marks.push(...quads(mesh,white)); mesh.geometry.dispose();
      const f = buildJunctions([j],mat,true); assert.equal(quads(f,white).length,0); f.geometry.dispose();
    }
    for (const {r} of batch.filter(q=>q.r.osm?.includes('_link'))) {
      const m = buildRoads(D, mat, [{r,a:0,b:r.n-1}]); assert.equal(quads(m,yellow).length,0,'link has no yellow dashes'); m.geometry.dispose();
    }
    for (const r of roads.filter(r=>r.widen)) {
      const base={...r,widen:undefined}, original=buildRoads(D,mat,[{r:base,a:0,b:r.n-1}]);
      const widened=buildRoads(D,mat,[{r,a:0,b:r.n-1}]);
      assert.deepEqual(quads(widened,yellow).map(q=>Array.from(q)),quads(original,yellow).map(q=>Array.from(q)),'main centre dash footprints unchanged');
      original.geometry.dispose(); widened.geometry.dispose();
    }
    // Spatial bins bound pairwise work on long highways.
    const bins = new Map(), seen = new Set(); let crossings = 0;
    for (let i=0;i<marks.length;i++) {
      const q=marks[i], xs=q.map(p=>p[0]), zs=q.map(p=>p[1]);
      for(let x=Math.floor(Math.min(...xs)/10);x<=Math.floor(Math.max(...xs)/10);x++) for(let z=Math.floor(Math.min(...zs)/10);z<=Math.floor(Math.max(...zs)/10);z++) {
        const key=x+','+z, list=bins.get(key)||[];
        for(const j of list) { const pair=j+','+i; if(seen.has(pair))continue; seen.add(pair);
          if(overlap(q,marks[j])) { if(crossings<8) console.log('crossing',name,JSON.stringify(q),JSON.stringify(marks[j])); crossings++; }
        }
        list.push(i); bins.set(key,list);
      }
    }
    assert.equal(crossings,0,`${name}: crossing marking quads`);
    const asphalt = new THREE.Color(0x50535c);
    const triangles = mesh => {
      const pos=mesh.geometry.attributes.position.array, col=mesh.geometry.attributes.color.array, out=[];
      for(let k=0;k<pos.length;k+=9) if(Math.abs(col[k]-asphalt.r)<1e-5 && Math.abs(col[k+1]-asphalt.g)<1e-5)
        out.push([Array.from(pos.slice(k,k+3)),Array.from(pos.slice(k+3,k+6)),Array.from(pos.slice(k+6,k+9))]);
      return out;
    };
    const tris=triangles(near), farTris=triangles(far);
    for(const r of roads.filter(r=>r.widen)) for(const cheap of [false,true]) {
      const m=buildRoads(D,mat,[{r,a:0,b:r.n-1}],cheap), ts=triangles(m);
      assert.equal(ts.length,2*(r.n-1),'one shared split per road segment in both LODs');
      for(let i=0;i<r.n-1;i++) {
        const v=(i,side)=>roadEdge(r,i,side), L0=v(i,1),R0=v(i,-1),R1=v(i+1,-1),L1=v(i+1,1);
        for(const [k,expected] of [[0,[L0,R0,R1]],[1,[L0,R1,L1]]]) {
          const p=expected[0].map((_,j)=>expected.reduce((sum,v)=>sum+v[j]/3,0));
          const h=triangleHeight(p[0],p[1],...expected);
          const tri=ts[2*i+k].map(q=>[q[0],q[2],q[1]]);
          assert(Math.abs(triangleHeight(p[0],p[1],...tri)-h)<.002,'render height equals shared physics triangle');
        }
      }
      m.geometry.dispose();
    }
    // Each full-lane outer stroke hands off to the ramp. Its inner stroke and the main-road
    // lane separator share a single zero-width V tip, rather than landing on opposite sides of the gore.
    for(const n of rampNoses(D)) {
      if(!n.ramp)continue;
      const tip=n.tip.map(Math.fround), outer=n.outerTip.map(Math.fround), touching=[], outerTouching=[];
      for(const r of [n.r,n.ramp.r]) {
        const m=buildRoads(D,mat,[{r,a:0,b:r.n-1}]);
        outerTouching.push(quads(m,white).some(q=>q.some((p,i)=>Math.hypot((p[0]+q[(i+1)%4][0])/2-outer[0],(p[1]+q[(i+1)%4][1])/2-outer[2])<.003)));
        touching.push(quads(m,white).some(q=>q.some(p=>Math.hypot(p[0]-tip[0],p[1]-tip[2])<.003)));
        m.geometry.dispose();
      }
      joined++;
      assert(outerTouching.every(Boolean),`outer edge hands off to ramp at ${name} road ${n.r.id}: ${outerTouching}`);
      assert(touching.every(Boolean),`main edge and ramp inner edge share the gore nose ${name} road ${n.r.id} ramp ${n.ramp.r.id}: ${touching}`);
    }

    if(gores.length) {
      const group=buildJunctions(gores,mat), lod=group.children.find(c=>c.isLOD);
      assert(lod && lod.levels.length===2,'gore paint must be wired into LOD');
      assert(quads(lod.levels[0].object,white).length>0);
      assert.equal(quads(lod.levels[1].object,white).length,0);
      group.traverse(o=>o.geometry?.dispose());
    }
    for(const r of roads.filter(r=>r.widen)) {
      const arc=roadArc(r);
      for(const [side,a,b,wa,wb] of r.widen) { if(wa===wb)continue; lanes++;
        for(let s=a+.5;s<b-.5;s+=2) for(const frac of [.1,.5,.9]) {
          const p=roadPoint(r,arc,s,side*(r.hw+laneWidth(r,s,side)*frac));
          assert(tris.some(t=>inside(p,t)),`${name}: uncovered asphalt wedge at ${p}`);
          assert(farTris.some(t=>inside(p,t)),`${name}: uncovered far asphalt wedge at ${p}`);
        }
      }
    }
    console.log(`${name}: ${marks.length} marking quads, ${gores.length} gore pieces; no crossings, wedge covered, far unmarked`);
    painted+=marks.length; tiles++; near.geometry.dispose();far.geometry.dispose();
  }
}
assert(lanes>0 && joined>0); console.log(`PASS ${tiles} tiles, ${lanes} lane wedges, ${joined} joined noses, ${painted} marking quads`);
