// Flat-world fixed-step flight and integration checks; no renderer or tile memory needed.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Jet, JET } from '../game/src/jet.js';
import { applyVehicleType, loadVehicleTypes } from '../game/src/vehicletypes.js';
import { createVehicleTypeSelector } from '../game/src/vehicletypeselector.js';
import { createCosmetics, paintedModel, disposeCosmeticPreview } from '../game/src/cosmetics.js';
import { bakeParts, makeRemotes } from '../game/src/mp/remotes.js';
import { createVehicleLightLenses } from '../game/src/lights.js';
const dt = 1/120;
const flat = surface => ({ spawn:[0,0], extent:[-1e7,-1e7,1e7,1e7], heightAt:()=>0, terrainAt:()=>0,
  waterLevelAt:()=>-Infinity, surfaceAt:()=>surface, loadedAt:()=>true, treesNear(){}, buildingsNear(){return [];} });
const make = (type = 'stealth', surface = 3) => {
  const j = new Jet(flat(surface), {...JET}); disposeCosmeticPreview(applyVehicleType(j,type)); j.reset(0,0,0); return j;
};
function run(j, seconds, controls = () => ({})) {
  for (let i=0;i<seconds/dt;i++) {
    const input = { jet:{ thr:0,pitch:0,roll:0,yaw:0,...controls(j,i*dt) } };
    j.input = input; j.step(dt,input);
    assert([...j.pos,...j.vel,...j.quat,...j.ang,j.gear,j.gLoad].every(Number.isFinite), 'nonfinite state');
    j.interpolate(1); j.syncMesh(dt);
  }
}
for (const surface of [3,0]) {
  const j = make('stealth',surface);
  let takeoff = null;
  run(j,15,(j,t) => {
    if (j.mode === 'air' && takeoff === null) takeoff = t;
    return {thr:1,pitch:j.mode === 'ground' ? 1 : THREE.MathUtils.clamp((20-j.vel.y)*.05,-1,1)};
  });
  assert(takeoff !== null && takeoff < 10); assert.equal(j.mode,'air'); assert(j.pos.y > 80);
  console.log(`PASS ${surface===3?'road':'field'} takeoff ${takeoff.toFixed(2)} s, climb ${j.pos.y.toFixed(0)} m`);
  disposeCosmeticPreview(j.mesh);
}
const speed = type => {
  const j = make(type); j.placeInAir(0,2500,0,0,1000);
  run(j,180,j=>({thr:1,pitch:THREE.MathUtils.clamp(((2500-j.pos.y)*.1-j.vel.y)*.05,-1,1)})); assert.equal(j.mode,'air');
  const result = j.vel.length()*3.6; disposeCosmeticPreview(j.mesh); return result;
};
const base = speed('fighter'), fast = speed('stealth');
assert(fast/base > 1.23 && fast/base < 1.28);
console.log(`PASS level top speed ${fast.toFixed(0)} vs ${base.toFixed(0)} km/h (${(fast/base).toFixed(3)}×)`);
const agility = type => {
  const j = make(type); j.placeInAir(0,3000,0,0,800);
  run(j,.3,()=>({roll:1,thr:1})); const bank = Math.abs(j.bank);
  j.placeInAir(0,3000,0,0,800); let maxG=0;
  run(j,1.5,()=>{maxG=Math.max(maxG,j.gLoad);return {pitch:1,thr:1};});
  j.placeInAir(0,3000,0,0,800);
  run(j,10,j=>({roll:THREE.MathUtils.clamp((.75-j.bank)*3,-1,1),thr:1}));
  assert(Math.abs(j.heading())>.2,'banked turn must change heading');
  disposeCosmeticPreview(j.mesh); return {bank,maxG};
};
const normal = agility('fighter'), agile = agility('stealth');
assert(agile.bank>normal.bank*1.2); assert(agile.maxG>normal.maxG*1.12);
console.log('PASS faster roll, higher g and banked turn', {normal,agile});
const j = make();
const stallSpeed = t => Math.sqrt(t.gravity/(t.liftK*(t.cl0+t.clA*t.stallA)))*3.6;
assert(stallSpeed(j.t)>stallSpeed(JET)*1.04 && stallSpeed(j.t)<stallSpeed(JET)*1.1);
j.placeInAir(0,1500,0,0,140); j.throttle=0; let stalled=false;
run(j,8,j=>{stalled ||= j.stall; return {thr:-1,pitch:1};});
assert(stalled); assert.equal(j.mode,'air'); assert(j.pos.y<1500);
console.log(`PASS stall onset ~${stallSpeed(j.t).toFixed(0)} vs ${stallSpeed(JET).toFixed(0)} km/h; low-speed stall loses height`);
for (const surface of [3,0]) {
  j.world=flat(surface); j.placeInAir(0,40,0,0,300); j.gear=1;
  run(j,35,j=>({thr:j.mode==='ground'?-1:j.vel.length()*3.6>300?-1:1,
    brake:j.mode==='ground', pitch:j.mode==='ground'?0:THREE.MathUtils.clamp(((j.agl>6?-2:-1)-j.vel.y)*.25,-1,1)}));
  assert.equal(j.mode,'ground'); assert(j.vel.length()<1,'landing rolls to a stop');
  console.log(`PASS ${surface===3?'road':'field'} landing and braking`);
}
j.placeInAir(0,40,0,0,400); j.pos.y=3; j.vel.set(40,-35,60);
run(j,.1); assert.equal(j.mode,'crashed'); assert(j.mesh.scale.y<1); assert(!j.mesh.userData.canopy.visible);
let respawns=0; j.respawn=()=>{respawns++;return [0,200,0,0,450];};
run(j,4.6); assert.equal(respawns,1); assert.equal(j.mode,'air'); assert.equal(j.mesh.scale.y,1);
assert.equal(j.type,'stealth'); console.log('PASS crash/wreck and jet-race air respawn preserve type');
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
assert(types.setType('jet','stealth')); assert.equal(cosmetics.get('jet').body,'#424a53');
assert.equal(loadVehicleTypes(storage).jet,'stealth');
jet._typeBaseTuning.thrust=20;assert.equal(jet.t.thrust,28.125);
cosmetics.set('jet',{body:'#123456'});assert(types.setType('jet','fighter'));assert.equal(cosmetics.get('jet').body,'#123456');
assert(types.setType('jet','stealth'));cosmetics.reset('jet');assert.equal(cosmetics.get('jet').body,'#424a53');
const reloadJet=new Jet(flat(3)), reloadAll={jet:reloadJet}, reloadTypes=createVehicleTypeSelector(reloadAll,{storage});
const reloadCosmetics=createCosmetics({all:reloadAll,current:reloadJet,...reloadTypes},{storage});
assert.equal(reloadJet.type,'stealth');assert.equal(reloadCosmetics.get('jet').body,'#424a53');
reloadCosmetics.set('jet',{body:'#eef0f2'});
assert.equal(createCosmetics({all:reloadAll,current:reloadJet,...reloadTypes},{storage}).get('jet').body,'#eef0f2', 'custom white survives reload');
const preview=cosmetics.createPreview('jet');assert.equal(preview.name,'jet-stealth');
const model=paintedModel('jet',cosmetics.get('jet'),'stealth'), ud=model.userData;
const lenses=createVehicleLightLenses(model,'jet');lenses.update({night:1,time:.5});
assert(!ud.lights.head.length && ['left','right','tail'].every(k=>ud.lights.nav[k]?.isVector3));
bakeParts(model,undefined,{keep:new Set([ud.canopy]),recolor:{mats:new Set(ud.wreckMats),color:new THREE.Color(ud.wreckColor)}});
const puppet={mesh:model,renderPos:new THREE.Vector3(),renderQuat:new THREE.Quaternion(),wheels:[{spin:1},{spin:2},{spin:3}],
  gear:0,throttle:1,steer:.3,mode:'air',type:'stealth',input:{jet:{pitch:.5,roll:.7,yaw:.6}}};
Jet.prototype.syncMesh.call(puppet,dt);assert(ud.flame.visible);assert(!ud.wheels[0].leg.visible);assert.equal(ud.wheels[1].spin.rotation.x,2);
assert(ud.elevator.rotation.x<0 && ud.aileronL.rotation.x>0);
ud.wreck(true);assert(!ud.canopy.visible);ud.wreck(false);assert(ud.canopy.visible);
let triangles=0;model.traverse(o=>{if(o.isMesh)triangles+=(o.geometry.index?.count||o.geometry.attributes.position?.count||0)/3;});
assert(triangles<2500);console.log(`PASS Garage/save/reload/paint/tuning and merged remote controls, gear, glow, lights (${triangles} triangles)`);
lenses.dispose();for(const m of [model,preview,j.mesh,stock.mesh,switched.mesh,jet.mesh,reloadJet.mesh])disposeCosmeticPreview(m);

// Exercise the actual multiplayer skin -> puppet -> near/far lifecycle (no relay needed).
const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();camera.position.set(0,4,-30);
let now=1000;
const remotes=makeRemotes({scene,camera,fx:false,night:()=>1,mp:{now:()=>now}});
remotes.receive({t:'skin',from:'stealth-test',skin:{vehicle:'jet',type:'stealth',colors:{body:'#424a53',trim:'#727b83'}}});
const sendRemote = (z,mode='a') => remotes.receive({t:'state',from:'stealth-test',srvT:now,v:'jet',p:[0,10,z],q:[0,0,0,1],vel:[0,0,100],
  w:[-1,-1,-1],ws:[3,3,3],th:1,gr:mode==='g'?1:0,md:mode,jc:[.5,.7,.6]});
const remoteFrame = z => {for(let i=0;i<30;i++){now+=1000/60;sendRemote(z);remotes.update(1/60);}};
remoteFrame(0);
assert.equal(remotes.list()[0].type,'stealth');assert.equal(remotes.model('stealth-test').name,'jet-stealth');
assert(remotes.model('stealth-test').userData.aileronL.rotation.x>0);
assert(remotes.list()[0].anim.flame>1 && remotes.list()[0].anim.lights.includes('left'));
remoteFrame(900);assert(remotes.list()[0].far,'distant aircraft uses cheap stand-in');
remoteFrame(0);assert(!remotes.list()[0].far);
remotes.dispose();console.log('PASS actual multiplayer type selection, animated puppet, lights and far stand-in');
