// Real physics + all type models, without a renderer. Run through the heavy-check gate.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { VEHICLE_TYPES, applyVehicleType } from '../game/src/vehicletypes.js';
import { drawnWheelY, wheelArch } from '../game/src/wheeltravel.js';
import { makeRemotes } from '../game/src/mp/remotes.js';

const dt = 1 / 120;
const flat = () => ({ heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  normalAt: (x,z,out = new THREE.Vector3()) => out.set(0,1,0), waterLevelAt: () => -Infinity,
  treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7,-1e7,1e7,1e7] });
const input = { throttle: 0, brake: 0, steer: 0, handbrake: false, lean: false };
const p = new THREE.Vector3();
let samples = 0, limited = 0;
// A known arch roof validates the geometry fallback independently of the production models.
{
  const model=new THREE.Group(), bodyPivot=new THREE.Group(), holder=new THREE.Group();
  const roof=new THREE.Mesh(new THREE.BoxGeometry(.5,.2,.6)); roof.position.y=.4;
  bodyPivot.add(roof); model.add(bodyPivot,holder); holder.position.y=-.1;
  model.userData={bodyPivot,wheels:[{holder,restY:-.1,r:.2}]};
  assert(Math.abs(wheelArch(model,0)-.48)<1e-6,'fallback follows the arch roof geometry');
  assert.equal(drawnWheelY(model,0,-.2),-.2);
  assert(drawnWheelY(model,0,10)<=.280001);
  model.userData.wheelArch=.4;
  assert(drawnWheelY(model,0,10)<=.200001,'explicit metadata overrides the cached fallback');
}
function check(model) {
  model.updateWorldMatrix(true, true);
  model.userData.wheels.forEach((w,i) => {
    const inv = w.holder.parent.matrixWorld.clone().invert();
    let top = -Infinity;
    w.holder.traverse(o => {
      if (!o.isMesh) return;
      const matrix = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      const positions = o.geometry.attributes.position;
      for (let j=0;j<positions.count;j++) {
        p.fromBufferAttribute(positions,j).applyMatrix4(matrix); top = Math.max(top,p.y);
      }
    });
    // Every point of the drawn tyre's precise bounding box stays below the model's arch line.
    assert(top <= wheelArch(model,i) + 1e-6, `${model.name || 'race'} wheel ${i}: top ${top} above arch ${wheelArch(model,i)}`);
    assert(Number.isFinite(top));
  });
  samples++;
}
function state(v) {
  return JSON.stringify({ p: v.pos, q: v.quat, v: v.vel, a: v.ang, wheels: v.wheels });
}
function draw(v) {
  v.interpolate(1);
  const before = state(v);
  v.syncMesh(dt);
  assert.equal(state(v),before,'drawing must not mutate physics or wheel compression');
  check(v.mesh);
}
function make(kind,id,world=flat()) {
  const v = kind === 'car' ? new Car(world,{...TUNING_DEFAULTS}) : new Bike(world,{...BIKE});
  applyVehicleType(v,id); v.reset(0,0,0); return v;
}
for (const [kind,types] of Object.entries(VEHICLE_TYPES)) for (const type of types) {
  const v = make(kind,type.id);
  for (let speed=0;speed<=1000;speed+=100) {
    v.reset(0,0,0); v.vel.set(0,0,speed/3.6);
    for (let j=0;j<180;j++) { v.step(dt,input); draw(v); }
  }
  v.reset(0,0,0); v.vel.set(0,0,1000/3.6);
  for (let j=0;j<600;j++) { v.step(dt,{...input,brake:1}); draw(v); }
  // A straight asphalt ramp with an abrupt lip, followed by a landing on the flat.
  const ramp = flat(); ramp.heightAt = ramp.terrainAt = ramp.groundAt = (x,z) => z>10 && z<25 ? (z-10)*.2 : 0;
  ramp.normalAt = (x,z,out=new THREE.Vector3()) => out.set(0,1,z>10&&z<25?-.2:0).normalize();
  const jump = make(kind,type.id,ramp); jump.vel.set(0,0,120/3.6);
  let airborne = false, landed = false;
  for (let j=0;j<720;j++) {
    jump.step(dt,input); draw(jump);
    if (jump.pos.z>25 && !jump.grounded) airborne=true;
    if (airborne && jump.grounded) landed=true;
  }
  assert(airborne && landed,`${type.id}: ramp must launch and land`);
  // Saturation and metadata are exercised beyond the physical spring's normal range too.
  for (const wh of v.wheels) { wh.contact=true; wh.comp=1; }
  draw(v); limited++;
  const arch = v.mesh.userData.wheels.map((_,i)=>wheelArch(v.mesh,i));
  v.mesh.userData.wheelArch=arch.map(y=>y-.05); draw(v);
  v.mesh.userData.wheelArch=Math.min(...arch)-.1; draw(v);
  delete v.mesh.userData.wheelArch;
  const limit=drawnWheelY(v.mesh,0,100), start=limit-.2;
  assert.equal(drawnWheelY(v.mesh,0,start),start,'free travel remains exact');
  const a=drawnWheelY(v.mesh,0,limit-.06), b=drawnWheelY(v.mesh,0,limit-.0599);
  assert(b>=a && b-a<=.000101,'soft stop is continuous and monotonic');
  console.log(`PASS ${kind}/${type.id}: 0–1000 km/h, hard braking, ramp landing, metadata, physics unchanged`);
}

// Actual network puppets, including the geometry batching step and old-client animation fallback.
const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(); camera.position.set(0,3,-20);
let now=50000; const listeners=new Map();
const mp={ me:{id:'me'}, now:()=>now, players:new Map(),
  on(t,f){ if(!listeners.has(t))listeners.set(t,new Set());listeners.get(t).add(f); },
  off(t,f){listeners.get(t)?.delete(f);}, emit(t,m){for(const f of listeners.get(t)||[])f(m);} };
const remotes=makeRemotes({scene,camera,mp,fx:false});
for(const [kind,types] of Object.entries(VEHICLE_TYPES)) for(const type of types) {
  const id=type.id;
  mp.emit('roster',{players:[{id,name:id,skin:{vehicle:kind,type:id}}]});
  for(const compression of [null,0,10,100]) {
    for(let j=0;j<20;j++) {
      mp.emit('state',{from:id,srvT:now,p:[0,0,0],q:[0,0,0,1],vel:[0,0,1000/3.6],v:kind,
        ...(compression===null?{}:{w:Array(kind==='car'?4:2).fill(compression),lo:-100,la:100})});
      now+=1000/60; remotes.update(1/60);
      const model=remotes.model(id); if(model)check(model);
    }
  }
  assert(remotes.model(id),`${id}: remote built`);
  console.log(`PASS remote ${kind}/${id}: old client + 0–100 cm spring compression`);
}
remotes.dispose();
console.log(`PASS wheel clipping: ${samples} model poses, ${limited} types forced to full compression`);
