import assert from 'node:assert/strict';
import { terrainPaintQuad } from '../game/src/terrainpaint.js';
import { addCampusPaint } from '../game/src/campuspaint.js';
import * as THREE from 'three';
// A deliberately uneven height grid catches the missing middle-of-quad samples.
const height=(x,z)=>Math.sin(x*.5)*2+Math.cos(z*.4)*3;
function triangleHeight(x,z) {
 const x0=Math.floor(x/4)*4,z0=Math.floor(z/4)*4,u=(x-x0)/4,v=(z-z0)/4;
 const a=height(x0,z0),b=height(x0+4,z0),c=height(x0,z0+4),d=height(x0+4,z0+4);
 return u+v<=1 ? a+u*(b-a)+v*(c-a) : d+(1-u)*(c-d)+(1-v)*(b-d);
}
let count=0,area=0;
terrainPaintQuad([-7,0,-3],[13,0,-3],[13,0,9],[-7,0,9],height,.16,(a,b,c)=>{
 count++;
 const cross=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);
 assert.ok(cross>0,'upward winding'); area+=cross/2;
 // Check interiors as well as vertices: every triangle follows the terrain exactly.
 for(const [wa,wb,wc] of [[1,0,0],[0,1,0],[0,0,1],[.2,.3,.5],[1/3,1/3,1/3]]) {
  const x=a[0]*wa+b[0]*wb+c[0]*wc,y=a[1]*wa+b[1]*wb+c[1]*wc,z=a[2]*wa+b[2]*wb+c[2]*wc;
  assert.ok(Math.abs(y-triangleHeight(x,z)-.16)<1e-7);
 }
});
assert.ok(count>20); assert.ok(Math.abs(area-240)<1e-6,'complete coverage with no overlapping faces');
const group=new THREE.Group();addCampusPaint(group,()=>0);
const mesh=group.children[0],p=mesh.geometry.attributes.position;
assert.ok([...p.array].every(Number.isFinite));
// Paint still remains one draw call and is generated only at tile build time.
assert.equal(group.children.length,1);
console.log('Terrain paint tests passed:',count,'clipped triangles;',p.count/3,'campus triangles');
// Real campus terrain: every interior sample of every track paint triangle clears ground.
const fs=await import('node:fs');
const {readTileData}=await import('../game/src/tilepack.js');
const {makeTileData}=await import('../game/src/data.js');
const assets=new URL('../game/assets/',import.meta.url);
const W=JSON.parse(fs.readFileSync(new URL('world.json',assets)));
const data=await readTileData(async name=>{ const b=fs.readFileSync(new URL('tiles/0_0/'+name,assets)); return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); },W.packed);
const td=makeTileData(W,0,0,data),real=new THREE.Group();addCampusPaint(real,td.terrainAt);
const pos=real.children[0].geometry.attributes.position;
let minimum=Infinity,samples=0;
for(let i=0;i<pos.count;i+=3) {
 const vertices=[0,1,2].map(k=>[pos.getX(i+k),pos.getY(i+k),pos.getZ(i+k)]);
 // Exclude the unrelated courtyard and parking decals to the south.
 if(vertices.some(p=>p[2]>140 || p[0]>-510)) continue;
 for(const weights of [[.2,.3,.5],[1/3,1/3,1/3]]) {
  const p=[0,1,2].map(axis=>vertices.reduce((sum,v,k)=>sum+v[axis]*weights[k],0));
  const clearance=p[1]-td.terrainAt(p[0],p[2]);minimum=Math.min(minimum,clearance); samples++;
 }
}
assert.ok(minimum>.075,`ground clips paint: ${minimum}`);
console.log('Real track clearance:',minimum.toFixed(5),'m across',samples,'interior samples');
