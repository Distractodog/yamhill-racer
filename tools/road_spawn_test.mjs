// Small real-tile switching regression (no renderer or browser).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { createVehicles } from '../game/src/vehicles.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { nearestRoadSpawn } from '../game/src/roadspawn.js';
import { createRespawnHold } from '../game/src/respawnhold.js';
// Independent straight-strip checks fix the lane sign and direction convention.
const strip={kind:'asphalt',cls:'residential',w:10,pts:[[0,0],[0,100]]};
const flat={tiles:new Map([[0,{sourcePaths:[strip]}]]),loadedAt:()=>true,surfaceAt:()=>3,
  heightAt:()=>0,waterLevelAt:()=>-Infinity,rampAt:()=>0,buildingsNear:()=>[]};
let lane=nearestRoadSpawn(flat,10,50,0);
assert.equal(lane.x,-2.5); assert.equal(lane.z,50); assert.equal(lane.yaw,0);
lane=nearestRoadSpawn(flat,10,50,Math.PI);
assert.equal(lane.x,2.5); assert(Math.abs(Math.abs(lane.yaw)-Math.PI)<1e-9);
const local={...strip,cls:'service',pts:[[10,0],[10,100]]};
flat.tiles.set(0,{sourcePaths:[local,{...strip,pts:[[100,0],[100,100]]}]});
assert.equal(nearestRoadSpawn(flat,10,50,0).x,97.5,'real road preferred within 150 extra metres');
flat.tiles.set(0,{sourcePaths:[{...strip,bridge:true},{...strip,cls:'trunk_link'}]});
assert.equal(nearestRoadSpawn(flat,10,50,0),null,'bridge and ramp excluded');
const manifest=JSON.parse(fs.readFileSync('game/assets/world.json'));
const world=makeWorld(manifest);
const sites=[['field',3500,500,0],['forest',-1200,-1200,0],['roof',20000,-10000,30],['air',20000,-10000,800],['river',3694,1350,0]];
const needed=manifest.tiles.filter(([tx,tz])=>sites.some(([,x,z])=>Math.hypot(tx*2000-x,tz*2000-z)<3100));
for(const [tx,tz] of needed) {
  const read=async name=>{const b=fs.readFileSync(`game/assets/tiles/${tx}_${tz}/${name}`);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
  world.add(makeTileData(manifest,tx,tz,await readTileData(read,manifest.packed)));
}
// Use the centre of a committed town footprint for the roof case.
const town = world.tileAt(20000,-10000);
const building = town.buildings.find(b => b.pts.length >= 4);
assert(building, 'town roof fixture');
const roofSite = sites.find(s => s[0] === 'roof');
roofSite[1] = building.pts.reduce((sum,p)=>sum+p[0],0)/building.pts.length;
roofSite[2] = building.pts.reduce((sum,p)=>sum+p[1],0)/building.pts.length;
const saved=new Map();
globalThis.localStorage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
let allowed=true;
const vs=createVehicles({scene:new THREE.Scene(),world,tuning:{...TUNING_DEFAULTS},roadPlacementAllowed:()=>allowed});
for(const [label,x,z,y] of sites) for(const [kind,id] of [['car','race'],['car','sports'],['bike','sport']]) {
  vs.switchTo('jet'); vs.current.pos.set(x,world.heightAt(x,z)+y,z); vs.current.vel.set(100,0,100);
  const yaw=vs.current.heading(), expected=nearestRoadSpawn(world,x,z,yaw);
  assert(expected,`${label}: road exists`);
  assert(vs.choose(kind,id)); const v=vs.current;
  assert(Math.hypot(v.pos.x-expected.x,v.pos.z-expected.z)<.01);
  assert.equal(world.surfaceAt(v.pos.x,v.pos.z),3);
  assert.equal(v.vel.length(),0);
  assert(Math.cos(v.heading()-expected.yaw)>.999);
  assert(expected.offset>0,'right lane offset');
  for(let i=0;i<120;i++) v.step(1/120,{throttle:0,brake:0,steer:0,handbrake:false});
  assert(v.pos.toArray().every(Number.isFinite));
  assert(v.pos.y>world.heightAt(v.pos.x,v.pos.z)-.2,'no fall');
  console.log(`PASS ${label} → ${kind}/${id}`);
}
// Active Garage type change also places; inactive type changes do not move the player.
vs.switchTo('car'); vs.car.pos.set(3500,500,500); vs.setType('car','hatch');
assert.equal(world.surfaceAt(vs.car.pos.x,vs.car.pos.z),3);
const before=vs.car.pos.clone(); vs.setType('bike','dirt'); assert(vs.car.pos.equals(before));
vs.switchTo('bike'); vs.bike.pos.set(3500,world.heightAt(3500,500),500);
vs.switchTo('jet'); vs.jet.pos.copy(vs.bike.pos); vs.switchTo('bike');
assert.equal(vs.bike.pos.x,3500,'dirt bike stays off road');
// A previously visited road tile can be unloaded: hold until streamed back.
const spot=nearestRoadSpawn(world,3500,500,0), [tx,tz]=world.tileIndex(spot.x,spot.z), tile=world.tiles.get(world.key(tx,tz));
const loadedTiles = [...world.tiles.values()];
const hold=createRespawnHold({world,vehicles:[vs.car,vs.bike,...vs.aircraft],current:()=>vs.current});
vs.setRoadHold(v=>hold.request(v));
for(const t of [...world.tiles.values()]) world.remove(t.tx,t.tz);
vs.switchTo('car'); assert(hold.blocked); assert.equal(vs.car.vel.length(),0);
for (const t of loadedTiles) world.add(t);
hold.update(.1); assert(!hold.blocked, 'hold releases on loaded ground');
assert.equal(world.surfaceAt(vs.car.pos.x,vs.car.pos.z),3);
hold.cancel();
for (const site of [sites.find(s=>s[0]==='roof'), sites.find(s=>s[0]==='river')]) {
  const [,x,z,y]=site;
  vs.switchTo('jet'); vs.jet.pos.set(x,world.heightAt(x,z)+Math.max(y,30),z);
  vs.switchTo('bike');
  assert(world.waterLevelAt(vs.bike.pos.x,vs.bike.pos.z) <= world.heightAt(vs.bike.pos.x,vs.bike.pos.z));
  assert(!Number.isFinite(vs.bike.world.roofUnder(vs.bike.pos.x,vs.bike.pos.z,vs.bike.pos.y)));
}
allowed=false;
vs.switchTo('jet'); vs.jet.pos.set(3500,200,500); vs.switchTo('car');
assert.equal(vs.car.pos.x,3500,'race placement policy suppresses road spawn');
allowed=true;
vs.switchTo('jet'); vs.jet.pos.set(3500,200,500);
const unplaced=vs.car.pos.clone(); vs.switchTo('car',{place:false});
assert(vs.car.pos.equals(unplaced),'race start switch leaves placement to race');
console.log('PASS type changes, dirt preservation, unloaded known-road hold');
