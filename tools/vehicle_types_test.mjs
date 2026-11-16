// Node physics + model/integration checks. Run through the heavy-check gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { VEHICLE_TYPES, applyVehicleType, loadVehicleTypes, VEHICLE_TYPE_KEY } from '../game/src/vehicletypes.js';
import { createVehicleTypeSelector } from '../game/src/vehicletypeselector.js';
import { createCosmetics, disposeCosmeticPreview } from '../game/src/cosmetics.js';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { Net } from '../game/src/mp/net.js';

const dt=1/120, up=new THREE.Vector3(), forward=new THREE.Vector3();
const flat=(surface=3)=>({ heightAt:()=>0, terrainAt:()=>0, groundAt:()=>0, surfaceAt:()=>surface,
  normalAt:(x,z,out=new THREE.Vector3())=>out.set(0,1,0), waterLevelAt:()=>-Infinity,
  treesNear:()=>{}, buildingsNear:()=>[], loadedAt:()=>true, extent:[-1e7,-1e7,1e7,1e7] });
function make(kind,type,world=flat()) {
  const v=kind==='car'?new Car(world,{...TUNING_DEFAULTS}):new Bike(world,{...BIKE});
  disposeCosmeticPreview(applyVehicleType(v,type)); return v;
}
function simulate(v,seconds,control) {
  let flips=0,wasUp=true,t100=null,maxSpeed=0;
  const input={throttle:0,brake:0,steer:0,handbrake:false,lean:false};
  for(let i=0;i<seconds/dt;i++) {
    control(i*dt,input,v);v.step(dt,input);
    assert([...v.pos,...v.vel,...v.quat,...v.ang].every(Number.isFinite),`${v.type}: nonfinite state`);
    up.set(0,1,0).applyQuaternion(v.quat);
    if(wasUp&&up.y<0)flips++;wasUp=up.y>=0;
    const speed=v.vel.length()*3.6;maxSpeed=Math.max(maxSpeed,speed);
    if(t100===null&&speed>=100)t100=i*dt;
  }
  assert.equal(flips,0,`${v.type}: flipped`);
  v.interpolate(1);v.syncMesh(dt);
  return {flips,t100,maxSpeed,endSpeed:v.vel.length()*3.6};
}
// Load just the campus tile: no full-map memory cost.
const manifest=JSON.parse(fs.readFileSync('game/assets/world.json'));
const world=makeWorld(manifest);
const bytes=async f=>{const b=fs.readFileSync(`game/assets/tiles/0_0/${f}`);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);};
const tile=makeTileData(manifest,0,0,await readTileData(bytes,manifest.packed));world.add(tile);
// The queryable tile retains prepared road strips; use source tile.json for route centres.
const raw=await readTileData(bytes,manifest.packed);
const roads=(raw.tile.paths || []).filter(p=>p.pts.length>8 && p.pts.every(([x,z])=>Math.abs(x)<930&&Math.abs(z)<930));
const length=p=>p.pts.slice(1).reduce((n,q,i)=>n+Math.hypot(q[0]-p.pts[i][0],q[1]-p.pts[i][1]),0);
const routes=['asphalt','gravel'].map(kind=>{
  const road=roads.filter(p=>p.kind===kind && p.pts.filter(([x,z])=>world.surfaceAt(x,z)===(kind==='asphalt'?3:4)).length/p.pts.length>.8).sort((a,b)=>length(b)-length(a))[0];
  assert(road,`Missing campus ${kind} route`);console.log(`Route ${kind}: ${road.pts.length} points, ${length(road).toFixed(0)} m`);return {kind,points:road.pts};
});
function routeDrive(v,route) {
  const points=route.points;let index=1;
  v.reset(...points[0],Math.atan2(points[1][0]-points[0][0],points[1][1]-points[0][1]));
  let samples=0,onSurface=0,travelled=0,last=v.pos.clone();
  const result=simulate(v,30,(t,input)=>{
    // A modest speed leaves room for the campus's tight bends. Full acceleration is measured separately.
    while(index<points.length-1&&Math.hypot(points[index][0]-v.pos.x,points[index][1]-v.pos.z)<12)index++;
    const target=points[index],desired=Math.atan2(target[0]-v.pos.x,target[1]-v.pos.z);
    forward.set(0,0,1).applyQuaternion(v.quat);
    const angle=Math.atan2(Math.sin(desired-Math.atan2(forward.x,forward.z)),Math.cos(desired-Math.atan2(forward.x,forward.z)));
    input.steer=THREE.MathUtils.clamp(-angle*1.6,-1,1);
    const arrived=index===points.length-1&&Math.hypot(target[0]-v.pos.x,target[1]-v.pos.z)<15;
    const targetSpeed=arrived?0:Math.abs(angle)>.5?22:45, speed=v.vel.length()*3.6;
    input.throttle=!arrived&&speed<targetSpeed? .5:0;input.brake=speed>targetSpeed+3?.35:0;
    travelled+=v.pos.distanceTo(last);last.copy(v.pos);
    samples++;if(v.surface===(route.kind==='asphalt'?3:4))onSurface++;
  });
  assert(travelled>45,`${v.type} did not travel along ${route.kind}`);
  assert(onSurface/samples>.6,`${v.type} left ${route.kind} route (${(onSurface/samples*100).toFixed(0)}% on surface)`);
  return {...result,coverage:Math.round(onSurface/samples*100),travelled:Math.round(travelled)};
}
const table=[];
// Aircraft types (jet) fly; their own flight tests cover them (prop_flight_test, air_stealth_test, heli_test, drive.mjs jet).
for(const [kind,types] of Object.entries(VEHICLE_TYPES).filter(([kind])=>kind!=='jet')) for(const type of types) {
  const v=make(kind,type.id);v.reset(-4900,0,Math.PI/2);
  const straight=simulate(v,180,(t,i)=>{i.throttle=1;});
  assert(straight.t100!==null,`${type.id} never reached 100`);
  assert(straight.endSpeed>v.t.topSpeed*.9&&straight.endSpeed<v.t.topSpeed*1.08,`${type.id}: unexpected top ${straight.endSpeed}`);
  console.log(`${type.name}: 0–100 ${straight.t100.toFixed(2)} s, top ${straight.endSpeed.toFixed(0)} km/h`);
  const dirt=make(kind,type.id,flat(4));dirt.reset(0,0,0);
  const gravelAccel=simulate(dirt,10,(t,i)=>{i.throttle=1;});
  const real=make(kind,type.id,world),asphalt=routeDrive(real,routes[0]),gravel=routeDrive(real,routes[1]);
  if(type.physics) {
    assert(v.mesh.userData.lights.head.every(p=>p.isVector3));assert(v.mesh.userData.lights.tail.every(p=>p.isVector3));
    let paint=0;v.mesh.traverse(o=>{if(o.material?.userData?.cosmeticRole==='body')paint++;});assert(paint>0);
  }
  table.push({type:type.name,'0–100 s':straight.t100.toFixed(2),'top km/h':straight.endSpeed.toFixed(0),'gravel 0–100 s':gravelAccel.t100?.toFixed(2),
    'campus m / % road':`${asphalt.travelled} / ${asphalt.coverage}`,'gravel m / % road':`${gravel.travelled} / ${gravel.coverage}`,flips:0,NaN:false});
  for(const m of [v,dirt,real])disposeCosmeticPreview(m.mesh);
}
console.table(table);
// Settings stay live on top; changing a type never overwrites the shared sliders.
const settings={...TUNING_DEFAULTS},car=new Car(flat(),settings),bike=new Bike(flat(),{...BIKE});
const { Jet, JET }=await import('../game/src/jet.js');
const all={car,bike,jet:new Jet(flat(),{...JET})},scene=new THREE.Scene();scene.add(car.mesh);
const store=new Map(),storage={getItem:k=>store.get(k),setItem:(k,v)=>store.set(k,v)};
const types=createVehicleTypeSelector(all,{storage});
// Cosmetics also needs the existing jet model, but no jet simulation here.
const vehicles={all,current:car,...types},cosmetics=createCosmetics(vehicles,{storage});
cosmetics.set('car',{body:'#123456'});
const glider=new THREE.Group();car.mesh.add(glider);car.glide={mesh:glider,cancel(){}};
assert(types.setType('car','truck'));assert.equal(car.type,'truck');assert.equal(car.mesh.parent,scene);assert.equal(glider.parent,car.mesh);
assert.equal(settings.accel,30);assert.equal(car.t.accel,16);settings.accel=45;assert.equal(car.t.accel,24);
assert.equal(cosmetics.get('car').body,'#123456');
const preview=cosmetics.createPreview('car');assert.equal(preview.name,'car-truck');disposeCosmeticPreview(preview);
// A Garage type change of the same kind (a new mesh): the player's lights are rebuilt on the new model's light mount,
// the beam stays in the scene, the glider moves over, and the body shadow takes the new model's size.
{
  const { createVehicleLights }=await import('../game/src/lights.js'), { Effects }=await import('../game/src/effects.js');
  const lights=createVehicleLights(scene), fx=new Effects(scene,{shadows:false});
  fx.bodyBlob=new THREE.Mesh(new THREE.PlaneGeometry(2.4,4.9),new THREE.MeshBasicMaterial());fx.bodyBlob.userData.op=.5;
  fx.tyreBlobs=[0,1,2,3].map(()=>Object.assign(new THREE.Mesh(undefined,new THREE.MeshBasicMaterial()),{userData:{op:.75}}));
  const frame=()=>{car.interpolate(1);car.syncMesh(dt);lights.update(dt,car,1);fx.drive(dt,car);};
  const blobOf=()=>[fx.bodyBlob.scale.x*2.4,fx.bodyBlob.scale.z*4.9].map(x=>+x.toFixed(4));
  car.reset(0,0,0);frame();
  assert.deepEqual(blobOf(),car.mesh.userData.blob.map(x=>+x.toFixed(4)),'truck blob');
  assert.equal(lights.lenses.group.parent,car.mesh.userData.lightMount);
  const old=car.mesh,truckBlob=blobOf();
  assert(types.setType('car','hatch'));frame();
  assert.notEqual(car.mesh,old);assert.equal(glider.parent,car.mesh,'glider carried over to the new model');
  assert.deepEqual(blobOf(),car.mesh.userData.blob.map(x=>+x.toFixed(4)),'hatch blob after a same-kind type change');
  assert.notDeepEqual(blobOf(),truckBlob);
  assert.equal(lights.lenses.group.parent,car.mesh.userData.lightMount,'lenses rebuilt on the new model');
  assert.equal(old.getObjectByName('vehicle-lenses'),undefined,'no lenses left on the replaced model');
  assert.equal(car.mesh.getObjectsByProperty('name','vehicle-lenses').length,1);
  assert.equal(lights.spot.parent,scene);assert(lights.lenses.anchors===car.mesh.userData.lights);
  lights.dispose();assert(types.setType('car','truck'));
}
assert(types.setType('bike','sport'));assert.deepEqual(loadVehicleTypes(storage),{car:'truck',bike:'sport',jet:'fighter'});
// aircraft types: the prop plane's model, numbers over the jet sliders, Garage preview; back to the original jet
assert(types.setType('jet','prop'));assert.equal(all.jet.mesh.name,'jet-prop');assert.equal(all.jet.t.rotateKmh,60);assert.equal(all.jet.t.thrust,4.6);
{const p=cosmetics.createPreview('jet');assert.equal(p.name,'jet-prop');disposeCosmeticPreview(p);}
assert.deepEqual(loadVehicleTypes(storage),{car:'truck',bike:'sport',jet:'prop'});
// every type the jet itself flies (the helicopter has its own vehicle: tools/heli_test.mjs)
for(const {id,physics} of VEHICLE_TYPES.jet.filter(t=>!t.physics?.flight&&t.id!=='fighter')){
  assert(types.setType('jet',id));assert.equal(all.jet.mesh.name,`jet-${id}`);assert.equal(all.jet.type,id);
  assert.deepEqual(all.jet.air.gear,(physics?.gear)||all.jet.air.gear);
  const p=cosmetics.createPreview('jet');assert.equal(p.name,`jet-${id}`);disposeCosmeticPreview(p);
}
assert(types.setType('jet','fighter'));assert.equal(all.jet.mesh.name,'jet');assert.equal(all.jet.t.thrust,JET.thrust);
const reloaded={car:new Car(flat(),{...TUNING_DEFAULTS}),bike:new Bike(flat(),{...BIKE}),jet:new Jet(flat(),{...JET})};
createVehicleTypeSelector(reloaded,{storage});assert.equal(reloaded.car.type,'truck');assert.equal(reloaded.bike.mesh.name,'bike-sport');
assert.equal(types.setType('car','invalid'),false);
store.set(VEHICLE_TYPE_KEY,'{"car":"invalid","bike":null}');assert.deepEqual(loadVehicleTypes(storage),{car:'race',bike:'dirt',jet:'fighter'});
store.set(VEHICLE_TYPE_KEY,'{broken');assert.deepEqual(loadVehicleTypes(storage),{car:'race',bike:'dirt',jet:'fighter'});
assert(types.setType('car','race'));assert.equal(car.t,settings);assert.equal(car.typePhysics,null);
const sport=make('bike','sport');sport.reset(0,0,0);let wheelies=0;
simulate(sport,8,(t,i)=>{i.throttle=1;i.lean=true;if(sport.wheelie)wheelies++;});assert.equal(wheelies,0);
const net=new Net({storage:null});
assert.equal(net._skin({vehicle:car}).type,'race');assert.equal(net._skin({vehicle:sport}).type,'sport');
console.log('PASS: finite states, zero flips, models/anchors, paint rebinding, live tuning, glider attachment, storage/reload and no sport-bike Shift wheelies.');
