import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CAMPUS, partPts, inPoly } from '../game/src/campus.js';
import { makeTileData } from '../game/src/data.js';
import { buildRoads, buildJunctions, campusRoad } from '../game/src/roads.js';
import { readTileData } from '../game/src/tilepack.js';
const A=(process.env.YR_ASSETS||'game/assets').replace(/\/?$/,'/');      // YR_ASSETS=dir tests another assets folder
const W = JSON.parse(fs.readFileSync(A+'world.json')), dir=A+'tiles/0_0/';
const ab=f=>{const b=fs.readFileSync(dir+f);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const data=await readTileData(async f=>ab(f),W.packed), raw=data.tile;
const td=makeTileData(W,0,0,data);
const kitchen=CAMPUS.find(b=>b.name==='Back kitchen'), poly=partPts(kitchen.parts[0]);
assert.equal(kitchen.parts[0].win.rows,1);
assert.equal(kitchen.parts[0].win.basementRows,1);
assert(kitchen.floor-td.terrainAt(...kitchen.floorAt)<0.3);
assert.equal(kitchen.parts[0].h,3.6);
assert(Math.max(...poly.map(p=>kitchen.floor-td.terrainAt(...p)))>3);
const collision=td.buildings.find(b=>b.campus===kitchen);
assert(Math.abs(collision.top-(kitchen.floor+4.2))<1e-8);
let clearance=Infinity;
for(const road of raw.paths)for(const [x,z]of road.pts){
 const d=inPoly(poly,x,z)?0:Math.min(...poly.map((a,i)=>{const b=poly[(i+1)%poly.length],dx=b[0]-a[0],dz=b[1]-a[1];const u=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));return Math.hypot(x-a[0]-u*dx,z-a[1]-u*dz);}));
 clearance=Math.min(clearance,d-road.w/2);
}
assert(clearance>1.2,`Road shoulder blocked: clearance ${clearance}`);
const mat=new THREE.MeshBasicMaterial();
const colors=(kind,x,z)=>{
 const r={kind,x:[x,x+2],z:[z,z],y:[0,0],c:[0,0],lx:[0,0],lz:[1,1],hw:6};
 return buildRoads(null,mat,[{r,a:0,b:1}]).geometry.attributes.color.array;
};
const color=new THREE.Color(0xf3c63c),yellow=[color.r,color.g,color.b];
const has=(arr,c)=>{for(let i=0;i<arr.length;i+=3)if(c.every((v,k)=>Math.abs(v-arr[i+k])<1e-6))return true;return false;};
const asphalt=new THREE.Color(0x50535c),grey=[asphalt.r,asphalt.g,asphalt.b];
assert(has(colors('asphalt',2000,2000),yellow));
assert(!has(colors('asphalt',-550,300),yellow));
assert(has(colors('gravel',-550,300),grey));
assert(has(colors('trail',-550,300),grey));
assert(!campusRoad(-800,700,'trail'));assert(!campusRoad(-800,400,'trail'));
const junction=buildJunctions([{kind:'gravel',c:[-550,300,0],ring:[[-555,295,0,1],[-545,295,0,1],[-550,305,0,1]]}],mat);
assert(has(junction.geometry.attributes.color.array,grey));
console.log(`PASS: kitchen uphill floor + one storey, downhill lower storey, separate collision top; road clearance ${clearance.toFixed(2)} m beyond driving edge; asphalt school strips/junctions without yellow; town yellow and woodland dirt retained.`);
