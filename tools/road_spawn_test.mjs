// Small real-tile switching regression (no renderer or browser).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { createVehicles } from '../game/src/vehicles.js';
import { TUNING_DEFAULTS } from '../game/src/car.js';
import { setSwitchPlacement, getSwitchPlacement } from '../game/src/switchplacement.js';
import { nearestRoadSpawn, groundSwitchSpawn, openGroundAt } from '../game/src/roadspawn.js';
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
// The three policies differ on safe fields and on the road surfaces they accept.
const meadow={...flat,treesNear(){},surfaceAt:(x)=>Math.abs(x)<5?4:Math.abs(x-100)<8?3:1,
  tiles:new Map([[0,{sourcePaths:[{...strip,kind:'gravel',pts:[[0,0],[0,100]]}, {...strip,pts:[[100,0],[100,100]]}]}]])};
assert.deepEqual(groundSwitchSpawn(meadow,30,50,.7),{x:30,z:50,yaw:.7,distance:0});
assert.equal(groundSwitchSpawn(meadow,30,50,0,'road').x,-2.5);
meadow.surfaceAt=x=>Math.abs(x)<5?4:Math.abs(x-100)<8?3:1;
assert.equal(groundSwitchSpawn(meadow,30,50,0,'paved').x,97.5);
const dirt={...meadow,tiles:new Map([[0,{sourcePaths:[{...strip,kind:'trail',w:2}]}]]),surfaceAt:()=>2};
assert(groundSwitchSpawn(dirt,30,50,0,'road'),'narrow dirt track accepted');
assert.equal(groundSwitchSpawn(dirt,30,50,0,'paved'),null,'dirt track is not paved');
for (const hazard of ['forest','roof','water','slope']) {
  const unsafe={...meadow,
    treesNear(x,z,r,cb){if(hazard==='forest') cb(30,50,1);},
    buildingsNear:()=>hazard==='roof'?[{pts:[[27,47],[33,47],[33,53],[27,53]]}]:[],
    waterLevelAt:(x,z)=>hazard==='water' && Math.hypot(x-30,z-50)<12?1:-Infinity,
    heightAt:(x,z)=>hazard==='slope' && Math.abs(x-30)<12 ? (x-30)*.4 : 0};
  assert(!openGroundAt(unsafe,30,50),hazard);
  for(const mode of ['open','paved','road']) {
    const spawn=groundSwitchSpawn(unsafe,30,50,.7,mode);
    assert(spawn && openGroundAt(unsafe,spawn.x,spawn.z),`${hazard}/${mode}: safe destination`);
    assert(spawn.distance>0,`${hazard}/${mode}: moves`);
  }
}
let loaded=true;
const streamed={...meadow,loadedAt:()=>loaded};
const verified=nearestRoadSpawn(streamed,30,50,0);
loaded=false;
assert.deepEqual(nearestRoadSpawn(streamed,30,50,0),verified,'unloaded fallback was checked while loaded');
assert.equal(nearestRoadSpawn({...streamed,knownRoadTiles:meadow.tiles},30,50,0),null,'unverified metadata is not a safe spawn');
if (process.argv.includes('--unit')) { console.log('PASS placement policies: field, forest, roof, water and slope'); process.exit(0); }
const manifest=JSON.parse(fs.readFileSync('game/assets/world.json'));
const world=makeWorld(manifest);
const sites=[['field',3500,500,0],['forest',-1200,-1200,0],['roof',20000,-10000,30],['air',20000,-10000,800],['river',3694,1350,0]];
const needed=manifest.tiles.filter(([tx,tz])=>sites.some(([,x,z])=>Math.hypot(tx*2000-x,tz*2000-z)<3100));
for(const [tx,tz] of needed) {
  const read=async name=>{const b=fs.readFileSync(`game/assets/tiles/${tx}_${tz}/${name}`);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
  world.add(makeTileData(manifest,tx,tz,await readTileData(read,manifest.packed)));
}
// Anchor fixtures to the committed data, rather than relying on a field/tree
// still occupying a hand-entered coordinate after a map update.
const field=sites.find(s=>s[0]==='field');
let open=null, steep=null;
for(let dx=-200;dx<=200;dx+=20) for(let dz=-200;dz<=200;dz+=20) {
  const x=3500+dx,z=500+dz;
  if(!open && openGroundAt(world,x,z)) open=[x,z];
  const slope=Math.hypot((world.heightAt(x+1,z)-world.heightAt(x-1,z))/2,(world.heightAt(x,z+1)-world.heightAt(x,z-1))/2);
  if(!steep && slope>.3 && world.loadedAt(x,z)) steep=[x,z];
}
assert(open,'real open field fixture'); field[1]=open[0]; field[2]=open[1];
// Hills near the forest give a real slope fixture if the field itself is flat.
for(let x=-1800;!steep && x<500;x+=40) for(let z=-1800;!steep && z<500;z+=40) {
  if(world.loadedAt(x,z) && Math.hypot((world.heightAt(x+1,z)-world.heightAt(x-1,z))/2,(world.heightAt(x,z+1)-world.heightAt(x,z-1))/2)>.3) steep=[x,z];
}
assert(steep,'real steep slope fixture'); sites.push(['slope',...steep,0]);
const forest=sites.find(s=>s[0]==='forest'), trees=world.tileAt(forest[1],forest[2]).trees;
assert(trees.length,'real forest fixture');
let treeIndex=0,treeDistance=Infinity;
for(let i=0;i<trees.length;i+=4) { const d=Math.hypot(trees[i]-forest[1],trees[i+1]-forest[2]); if(d<treeDistance) {treeDistance=d;treeIndex=i;} }
forest[1]=trees[treeIndex]; forest[2]=trees[treeIndex+1];
assert(!openGroundAt(world,forest[1],forest[2]),'tree blocks staying');
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
assert.equal(getSwitchPlacement(),'open','default policy');
for(const mode of ['open','paved','road']) {
setSwitchPlacement(mode); assert.equal(getSwitchPlacement(),mode,'saved policy');
for(const [label,x,z,y] of sites) for(const [kind,id] of [['car','race'],['car','sports'],['bike','sport']]) {
  vs.switchTo('jet'); vs.current.pos.set(x,world.heightAt(x,z)+y,z); vs.current.vel.set(100,0,100);
  const yaw=vs.current.heading(), expected=groundSwitchSpawn(world,x,z,yaw,mode);
  assert(expected,`${label}: road exists`);
  assert(vs.choose(kind,id)); const v=vs.current;
  assert(Math.hypot(v.pos.x-expected.x,v.pos.z-expected.z)<.01);
  assert(openGroundAt(world,v.pos.x,v.pos.z),`${label}/${mode}: safe footprint`);
  if(mode==='paved') assert.equal(world.surfaceAt(v.pos.x,v.pos.z),3);
  if(mode==='open' && openGroundAt(world,x,z)) { assert.equal(v.pos.x,x); assert.equal(v.pos.z,z); assert(Math.cos(v.heading()-yaw)>.999); }
  assert.equal(v.vel.length(),0);
  assert(Math.cos(v.heading()-expected.yaw)>.999);
  if(expected.offset!==undefined) assert(expected.offset>0,'right lane offset');
  for(let i=0;i<120;i++) v.step(1/120,{throttle:0,brake:0,steer:0,handbrake:false});
  assert(v.pos.toArray().every(Number.isFinite));
  assert(v.pos.y>world.heightAt(v.pos.x,v.pos.z)-.2,'no fall');
  console.log(`PASS ${mode}/${label} → ${kind}/${id}`);
}
}
setSwitchPlacement('paved');
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
setSwitchPlacement('open');
console.log('PASS type changes, dirt preservation, unloaded known-road hold');
