// Flat-world fixed-step flight and integration checks; no renderer or tile memory needed.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Jet, JET } from '../game/src/jet.js';
import { applyVehicleType, loadVehicleTypes, buildVehicleTypeModel } from '../game/src/vehicletypes.js';
import { createVehicleTypeSelector } from '../game/src/vehicletypeselector.js';
import { createCosmetics, paintedModel, disposeCosmeticPreview } from '../game/src/cosmetics.js';
import { bakeParts, makeRemotes } from '../game/src/mp/remotes.js';
import { createVehicleLightLenses } from '../game/src/lights.js';
const dt = 1/120;
const flat = surface => ({ spawn:[0,0], extent:[-1e7,-1e7,1e7,1e7], heightAt:()=>0, terrainAt:()=>0,
  waterLevelAt:()=>-Infinity, surfaceAt:()=>surface, loadedAt:()=>true, treesNear(){}, buildingsNear(){return [];} });
const make = (type = 'blackbird', surface = 3) => {
  const j = new Jet(flat(surface), {...JET}); disposeCosmeticPreview(applyVehicleType(j,type)); j.reset(0,0,0); return j;
};
function run(j, seconds, controls = () => ({})) {
  for (let i=0;i<seconds/dt;i++) {
    const input = { jet:{ thr:0,pitch:0,roll:0,yaw:0,...controls(j,i*dt) } };
    j.input = input; j.step(dt,input);
    assert([...j.pos,...j.vel,...j.quat,...j.ang,j.gear,j.gLoad].every(Number.isFinite), 'nonfinite state');
    if (j.mode !== 'crashed') assert(1 - 2 * (j.quat.x*j.quat.x + j.quat.z*j.quat.z) > 0, 'no unintended flip');
    j.interpolate(1); j.syncMesh(dt);
  }
}
for (const surface of [3,0]) {
  const j = make('blackbird',surface);
  let takeoff = null, takeoffKmh = 0, roll = 0;
  run(j,22,(j,t) => {
    if (j.mode === 'air' && takeoff === null) { takeoff = t; takeoffKmh = j.vel.length()*3.6; roll = j.pos.z; }
    return {thr:1,pitch:j.mode === 'ground' ? 1 : THREE.MathUtils.clamp((20-j.vel.y)*.05,-1,1)};
  });
  assert(takeoffKmh > 360 && takeoffKmh < 410, 'fast rotation');
  assert(roll > 500, 'long runway');
  assert(takeoff !== null && takeoff > 9 && takeoff < 20); assert.equal(j.mode,'air'); assert(j.pos.y > 30);
  console.log(`PASS ${surface===3?'road':'field'} takeoff ${takeoff.toFixed(2)} s at ${takeoffKmh.toFixed(1)} km/h, roll ${roll.toFixed(1)} m, climb ${j.pos.y.toFixed(0)} m`);
  disposeCosmeticPreview(j.mesh);
}
const speed = type => {
  const j = make(type); j.placeInAir(0,2500,0,0,1000);
  run(j,600,j=>({thr:1,pitch:THREE.MathUtils.clamp(((2500-j.pos.y)*.1-j.vel.y)*.05,-1,1)})); assert.equal(j.mode,'air');
  assert(Math.abs(j.pos.y-2500)<5 && Math.abs(j.vel.y)<1, 'top speed measured in level flight');
  const result = j.vel.length()*3.6; disposeCosmeticPreview(j.mesh); return result;
};
const base = speed('fighter'), fast = speed('blackbird');
assert(fast > 3450 && fast < 3550);
console.log(`PASS level top speed ${fast.toFixed(0)} vs ${base.toFixed(0)} km/h (${(fast/base).toFixed(3)}×)`);
const agility = type => {
  const j = make(type); j.placeInAir(0,3000,0,0,800);
  run(j,.3,()=>({roll:1,thr:1})); const bank = Math.abs(j.bank);
  j.placeInAir(0,3000,0,0,800); let maxG=0;
  run(j,1.5,()=>{maxG=Math.max(maxG,j.gLoad);return {pitch:1,thr:1};});
  j.placeInAir(0,3000,0,0,800);
  run(j,10,j=>({roll:THREE.MathUtils.clamp((.75-j.bank)*3,-1,1),thr:1}));
  assert(Math.abs(j.heading())>.2,'banked turn must change heading');
  const heading = Math.abs(j.heading());
  // Same 1,500 km/h entry, 60° bank and 80% pull compare the turn radii.
  j.placeInAir(0,5000,0,0,1500);
  j.quat.setFromAxisAngle(new THREE.Vector3(0,0,1), Math.PI/3);
  const initial = j.vel.clone();
  run(j,3,j=>({thr:1,pitch:.8,roll:THREE.MathUtils.clamp((Math.PI/3-j.bank)*3,-1,1)}));
  const turn = initial.angleTo(j.vel), radius = (1500/3.6)*3/turn;
  disposeCosmeticPreview(j.mesh); return {bank,maxG,heading,radius};
};
const normal = agility('fighter'), agile = agility('blackbird');
assert(agile.bank < normal.bank*.5); assert(agile.maxG < 4.1 && agile.maxG < normal.maxG*.6);
assert(agile.radius > normal.radius*1.8, 'wide turns at the same entry speed');
console.log('PASS slower roll, lower g and banked turn', {normal,agile});
const j = make();
const stallSpeed = t => Math.sqrt(t.gravity/(t.liftK*(t.cl0+t.clA*t.stallA)))*3.6;
assert(stallSpeed(j.t)>stallSpeed(JET)*1.3 && stallSpeed(j.t)<stallSpeed(JET)*1.4);
j.placeInAir(0,1500,0,0,140); j.throttle=0; let stalled=false;
run(j,8,j=>{stalled ||= j.stall; return {thr:-1,pitch:1};});
assert(stalled); assert.equal(j.mode,'air'); assert(j.pos.y<1500);
console.log(`PASS stall onset ~${stallSpeed(j.t).toFixed(0)} vs ${stallSpeed(JET).toFixed(0)} km/h; low-speed stall loses height`);
for (const surface of [3,0]) {
  j.world=flat(surface); j.placeInAir(0,40,0,0,400); j.gear=1;
  run(j,50,j=>({thr:j.mode==='ground'?-1:j.vel.length()*3.6>400?-1:1,
    brake:j.mode==='ground', pitch:j.mode==='ground'?0:THREE.MathUtils.clamp(((j.agl>6?-2:-1)-j.vel.y)*.25,-1,1)}));
  assert.equal(j.mode,'ground'); assert(j.vel.length()<1,'landing rolls to a stop');
  console.log(`PASS ${surface===3?'road':'field'} landing and braking`);
}
j.placeInAir(0,40,0,0,400); j.pos.y=3; j.vel.set(40,-35,60);
run(j,.1); assert.equal(j.mode,'crashed'); assert(j.mesh.scale.y<1); assert(!j.mesh.userData.canopy.visible);
let respawns=0; j.respawn=()=>{respawns++;return [0,200,0,0,450];};
run(j,4.6); assert.equal(respawns,1); assert.equal(j.mode,'air'); assert.equal(j.mesh.scale.y,1);
assert.equal(j.type,'blackbird'); console.log('PASS crash/wreck and jet-race air respawn preserve type');
// Factory restores the exact original tuning object and trajectory, including after switching back.
const stock = new Jet(flat(3),{...JET}), switched = make();
const originalTuning=switched._typeBaseTuning;
disposeCosmeticPreview(applyVehicleType(switched,'fighter')); assert.equal(switched.t,originalTuning);
stock.reset(0,0,0);switched.reset(0,0,0);
for (let i=0;i<2400;i++) {
  const input={jet:{thr:1,pitch:i<1100?1:0,roll:i>1500?.2:0,yaw:0}};
  stock.step(dt,input);switched.step(dt,input);
  assert.deepEqual(switched.pos.toArray(),stock.pos.toArray());assert.deepEqual(switched.quat.toArray(),stock.quat.toArray());
}
console.log('PASS Fighter jet trajectory exactly unchanged after a type round trip');
// Garage persistence, factory palette, custom paint and live tuning.
const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
const jet=new Jet(flat(3),{...JET}), all={jet}, types=createVehicleTypeSelector(all,{storage});
const cosmetics=createCosmetics({all,current:jet,...types},{storage});
assert(types.setType('jet','blackbird')); assert.equal(cosmetics.get('jet').body,'#16181c');
assert.equal(loadVehicleTypes(storage).jet,'blackbird');
jet._typeBaseTuning.thrust=20;assert.equal(jet.t.thrust,12.5);
cosmetics.set('jet',{body:'#123456'});assert(types.setType('jet','fighter'));assert.equal(cosmetics.get('jet').body,'#123456');
assert(types.setType('jet','blackbird'));cosmetics.reset('jet');assert.equal(cosmetics.get('jet').body,'#16181c');
const reloadJet=new Jet(flat(3)), reloadAll={jet:reloadJet}, reloadTypes=createVehicleTypeSelector(reloadAll,{storage});
const reloadCosmetics=createCosmetics({all:reloadAll,current:reloadJet,...reloadTypes},{storage});
assert.equal(reloadJet.type,'blackbird');assert.equal(reloadCosmetics.get('jet').body,'#16181c');
reloadCosmetics.set('jet',{body:'#eef0f2'});
assert.equal(createCosmetics({all:reloadAll,current:reloadJet,...reloadTypes},{storage}).get('jet').body,'#eef0f2', 'custom white survives reload');
const preview=cosmetics.createPreview('jet');assert.equal(preview.name,'jet-blackbird');
assert.deepEqual(jet.cam.eye, jet.mesh.userData.cockpit.eye);
assert.equal(jet.mesh.userData.cockpit.attitude, null, 'analogue cockpit: no screens');
assert.equal(jet.mesh.userData.cockpit.needles.count, 5, 'five round instruments');
const model=paintedModel('jet',cosmetics.get('jet'),'blackbird'), ud=model.userData;
const countTriangles = root => {
  let n=0; root.traverse(o=>{if(o.isMesh) n+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);}); return n;
};
const raw = buildVehicleTypeModel('jet','blackbird');
const totalTriangles=countTriangles(raw), exteriorTriangles=totalTriangles-countTriangles(raw.userData.cockpit.group);
console.log(`PASS model budget: ${exteriorTriangles} exterior triangles (including flames), ${totalTriangles} with cockpit`);
assert(exteriorTriangles < 1300 && totalTriangles < 2200); disposeCosmeticPreview(raw);
const custom=paintedModel('jet',{...cosmetics.get('jet'),body:'#123456',trim:'#506070'},'blackbird');
const seen = new Set();
custom.traverse(o=>{
  const role=o.material?.userData?.cosmeticRole;
  if(role==='body'||role==='trim') { seen.add(role); assert.equal(o.material.color.getHexString(),role==='body'?'123456':'506070'); }
});
assert.equal(seen.size,2,'body and trim paint roles'); disposeCosmeticPreview(custom);
// The drawn tyres meet the physical gear plane with gear down.
model.updateMatrixWorld(true);
for (let i=0;i<ud.wheels.length;i++) {
  const wheel=ud.wheels[i], box=new THREE.Box3().setFromObject(wheel.spin);
  assert(Math.abs(box.min.y+jet.air.gearH)<.02,'tyre touches ground');
  assert.equal(wheel.leg.position.x,jet.wheels[i].x); assert.equal(wheel.leg.position.z,jet.wheels[i].z);
}
const lenses=createVehicleLightLenses(model,'jet');lenses.update({night:1,time:.5});
assert(!ud.lights.head.length && ['left','right','tail'].every(k=>ud.lights.nav[k]?.isVector3));
bakeParts(model,undefined,{keep:new Set([ud.canopy]),recolor:{mats:new Set(ud.wreckMats),color:new THREE.Color(ud.wreckColor)}});
const puppet={mesh:model,renderPos:new THREE.Vector3(),renderQuat:new THREE.Quaternion(),wheels:[{spin:1},{spin:2},{spin:3}],
  gear:0,throttle:1,steer:.3,mode:'air',type:'blackbird',input:{jet:{pitch:.5,roll:.7,yaw:.6}}};
Jet.prototype.syncMesh.call(puppet,dt);assert(ud.flame.visible);assert(!ud.wheels[0].leg.visible);assert.equal(ud.wheels[1].spin.rotation.x,2);
assert(ud.elevator.rotation.x<0 && ud.aileronL.rotation.x>0);
ud.wreck(true);assert(!ud.canopy.visible);ud.wreck(false);assert(ud.canopy.visible);
let triangles=0;model.traverse(o=>{if(o.isMesh)triangles+=(o.geometry.index?.count||o.geometry.attributes.position?.count||0)/3;});
assert(triangles<3000);console.log(`PASS Garage/save/reload/paint/tuning and merged remote controls, gear, glow, lights (${triangles} triangles)`);
lenses.dispose();for(const m of [model,preview,j.mesh,stock.mesh,switched.mesh,jet.mesh,reloadJet.mesh])disposeCosmeticPreview(m);

// Exercise the actual multiplayer skin -> puppet -> near/far lifecycle (no relay needed).
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();camera.position.set(0,4,-30);
let now=1000;
const remotes=makeRemotes({scene,camera,fx:false,night:()=>1,mp:{now:()=>now}});
remotes.receive({t:'skin',from:'blackbird-test',skin:{vehicle:'jet',type:'blackbird',colors:{body:'#16181c',trim:'#2c3036'}}});
const sendRemote = (z,mode='a') => remotes.receive({t:'state',from:'blackbird-test',srvT:now,v:'jet',p:[0,10,z],q:[0,0,0,1],vel:[0,0,100],
  w:[-1,-1,-1],ws:[3,3,3],th:1,gr:mode==='g'?1:0,md:mode,jc:[.5,.7,.6]});
const remoteFrame = z => {for(let i=0;i<30;i++){now+=1000/60;sendRemote(z);remotes.update(1/60);}};
remoteFrame(0);
assert.equal(remotes.list()[0].type,'blackbird');assert.equal(remotes.model('blackbird-test').name,'jet-blackbird');
assert(remotes.model('blackbird-test').userData.aileronL.rotation.x>0);
assert(remotes.list()[0].anim.flame>1 && remotes.list()[0].anim.lights.includes('left'));
remoteFrame(900);assert(remotes.list()[0].far,'distant aircraft uses cheap stand-in');
remoteFrame(0);assert(!remotes.list()[0].far);
remotes.dispose();console.log('PASS actual multiplayer type selection, animated puppet, lights and far stand-in');

// Mach-3 steps must sample an intervening ridge, rather than jumping its entire width.
for (const limited of [false, true]) {
  const jet = make(); jet.placeInAir(0,100,0,0,3500); jet.pos.y = 10;
  jet.world = { ...flat(3), heightAt: (x,z) => z > 3 && z < 5.5 ? 50 : 0 };
  if (!limited) jet.air.maxStepDistance = 0;
  jet.step(dt, {jet:{thr:1,pitch:0,roll:0,yaw:0}});
  assert.equal(jet.mode, limited ? 'crashed' : 'air', 'ridge between original 8 m samples');
  disposeCosmeticPreview(jet.mesh);
}
console.log('PASS Mach-3 ridge collision: shorter steps prevent tunnelling');
