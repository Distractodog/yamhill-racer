import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { readTileData } from '../game/src/tilepack.js';
import { makeTileData, makeWorld } from '../game/src/data.js';
import { CAMPUS, inPoly, partPts } from '../game/src/campus.js';
import { SAT_BUILDINGS, STAND, standAt, courtXZ } from '../game/src/campussat.js';
import { buildCampusGeometry } from '../game/src/campusmodel.js';
import { buildTrackMeshes } from '../game/src/campustrackmodel.js';
import { buildRoads } from '../game/src/roads.js';
import { buildingRoofAt, collideBuilding } from '../game/src/roofs.js';
const W=JSON.parse(fs.readFileSync('game/assets/world.json'));
const td=makeTileData(W,0,0,await readTileData(async f=>fs.readFileSync('game/assets/tiles/0_0/'+f),W.packed));
const world=makeWorld(W);world.add(td);
for(const b of SAT_BUILDINGS) {
  assert(CAMPUS.includes(b));
  assert(td.buildings.some(p=>p.campus===b),b.name+' has a collider');
  const near=buildCampusGeometry(b,td.terrainAt),far=buildCampusGeometry(b,td.terrainAt,true);
  for(const g of [near,far])for(const a of Object.values(g.attributes))assert([...a.array].every(Number.isFinite),b.name+' finite geometry');
  assert(far.attributes.position.count<=near.attributes.position.count);
  near.dispose();far.dispose();
}
const stand=SAT_BUILDINGS[0],roof=SAT_BUILDINGS[1],collider=td.buildings.find(b=>b.campus===roof);
assert.equal(stand.parts.filter(p=>p.name.startsWith('seating tier')).length,7);
assert(stand.parts[6].h>stand.parts[0].h,'back rows rise to west');
assert(standAt(0,-3)[0]<standAt(0,3)[0]);
assert.equal(collider.bottom,roof.floor);
assert(inPoly(partPts(roof.parts[0]),...STAND.c));
const v={pos:new THREE.Vector3(STAND.c[0],td.terrainAt(...STAND.c)+1,STAND.c[1]),vel:new THREE.Vector3(1,0,0),world,hit:0};
const before=v.pos.clone();collideBuilding(v,collider,1);assert(v.pos.equals(before),'canopy has no invisible ground wall');
const roofGeo=buildCampusGeometry(roof,td.terrainAt),roofMesh=new THREE.Mesh(roofGeo,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));roofMesh.updateMatrixWorld();
const ray=new THREE.Raycaster(new THREE.Vector3(STAND.c[0],roof.floor+20,STAND.c[1]),new THREE.Vector3(0,-1,0));
const hit=ray.intersectObject(roofMesh)[0];assert(hit);assert(Math.abs(hit.point.y-buildingRoofAt(collider,...STAND.c,world))<.01,'drawn roof and solid roof agree');
const meshes=buildTrackMeshes(td.terrainAt);
for(const mesh of meshes) {
 assert([...mesh.geometry.attributes.position.array].every(Number.isFinite));
 mesh.geometry.dispose();
}
for(const p of [courtXZ(-17,-8.4),courtXZ(17,8.4)])assert.equal(td.surfaceAt(...p),7);
assert.equal(td.surfaceAt(-607,60),6,'apron has concrete grip');
// Deep hillside cut: the old hard-coded -3 m skirt hung above terrain.
const r=td.renderRoads.find(r=>r.id===122),mesh=buildRoads(td,new THREE.MeshBasicMaterial(),[{r,a:0,b:r.n-1}]);
const positions=mesh.geometry.attributes.position.array;let skirtVertices=0;
for(let i=0;i<positions.length;i+=3)if(positions[i+1]<td.terrainAt(positions[i],positions[i+2])-.14)skirtVertices++;
assert(skirtVertices>100,'trail skirt extends into ground along steep cuts');
console.log('PASS: satellite buildings/LOD finite; seven east-facing rows; canopy open below and roof ray matches collision; courts/apron surfaces; hillside trail skirts reach terrain');
const trailColour=new THREE.Color(0xc98d55);
for(const id of [59,88,112,122])for(const far of [false,true]) {
 const r=td.renderRoads.find(r=>r.id===id),g=buildRoads(td,new THREE.MeshBasicMaterial(),[{r,a:0,b:r.n-1}],far).geometry;
 const p=g.attributes.position.array,c=g.attributes.color.array;
 let tops=0;
 for(let i=0;i<p.length;i+=9) {
  if(Math.abs(c[i]-trailColour.r)>1e-6||Math.abs(c[i+1]-trailColour.g)>1e-6)continue;
  const ny=(p[i+5]-p[i+2])*(p[i+6]-p[i])-(p[i+3]-p[i])*(p[i+8]-p[i+2]);
  assert(ny>=-1e-5,`trail ${id} ${far?'far':'near'} has a downward-facing top`);tops++;
 }
 assert(tops>0);g.dispose();
}
console.log('PASS: tight trail turns have upward-facing top triangles at near and far detail');
