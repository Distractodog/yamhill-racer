// Real car/bike physics + all their type models, without a renderer. Run through the heavy-check gate.
// Aircraft use their own gear animation and flight tests, not car/bike suspension or wheel arches.
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
const p = new THREE.Vector3(), baselines = new WeakMap();
let samples = 0, limited = 0;
// Independent collision oracle: collect actual downward-facing body triangles and the parked
// tyre line before syncMesh moves anything. No call to wheelArch/drawnWheelY defines clearance.
function baseline(model) {
  if (baselines.has(model)) return baselines.get(model);
  model.updateWorldMatrix(true,true);
  const ud=model.userData, holders=new Set(ud.wheels.map(w=>w.holder));
  const data=ud.wheels.map(w=>{
    const body=ud.bodyPivot||w.holder.parent, inverse=body.matrixWorld.clone().invert(), triangles=[];
    body.traverse(o=>{
      if(!o.isMesh)return;
      for(let a=o;a&&a!==model;a=a.parent) if(holders.has(a)||a===ud.rider||a===ud.bars||a.name.startsWith('cosmetic-')||a.userData.cosmetic)return;
      const transform=new THREE.Matrix4().multiplyMatrices(inverse,o.matrixWorld);
      const pos=o.geometry.attributes.position, idx=o.geometry.index;
      for(let j=0;j<(idx?.count??pos.count);j+=3){
        const vertices=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(pos,idx?idx.getX(j+k):j+k).applyMatrix4(transform));
        const tri=new THREE.Triangle(...vertices), normal=tri.getNormal(new THREE.Vector3());
        if(normal.y < -1e-6)triangles.push(tri);
      }
    });
    const tyre=w.spin.children.find(o=>o.isMesh&&o.visible), tyreToBody=new THREE.Matrix4().multiplyMatrices(inverse,tyre.matrixWorld);
    const vertices=tyre.geometry.attributes.position;
    let restTop=-Infinity;
    for(let j=0;j<vertices.count;j++)restTop=Math.max(restTop,p.fromBufferAttribute(vertices,j).applyMatrix4(tyreToBody).y);
    return {body,triangles,restTop,restY:w.holder.position.y};
  });
  baselines.set(model,data);return data;
}
// Sutherland–Hodgman against one half-space: keep points with (v[axis]-edge)*sign >= 0.
function clip(poly,axis,edge,sign) {
  const result=[];
  for(let i=0;i<poly.length;i++){
    const a=poly[i], b=poly[(i+1)%poly.length], da=(a[axis]-edge)*sign, db=(b[axis]-edge)*sign;
    if(da>=0)result.push(a);
    if((da<0)!==(db<0))result.push(a.clone().lerp(b,da/(da-db)));
  }
  return result;
}
// Smallest distance from the wheel axis (the origin of the y,z plane) to a convex polygon seen along x: 0 if inside.
function distToPolygonYZ(poly) {
  let best=Infinity, sign=0, inside=true;
  for(let i=0;i<poly.length;i++){
    const a=poly[i], b=poly[(i+1)%poly.length], ey=b.y-a.y, ez=b.z-a.z, len2=ey*ey+ez*ez;
    const t=len2>0?Math.max(0,Math.min(1,-(a.y*ey+a.z*ez)/len2)):0;
    best=Math.min(best,Math.hypot(a.y+ey*t,a.z+ez*t));
    const cross=ey*(-a.z)-ez*(-a.y);
    if(Math.abs(cross)>1e-12){ if(sign&&Math.sign(cross)!==sign)inside=false; sign=sign||Math.sign(cross); }
  }
  return inside?0:best;
}
function check(model) {
  const data=baseline(model);
  model.updateWorldMatrix(true,true);
  model.userData.wheels.forEach((w,i)=>{
    const {body,triangles,restTop}=data[i];
    // The tyre is a cylinder (a circle in the side view) about the holder's x axis: the radius and half width come from
    // the tyre mesh, the pose from the holder, so steering, roll and dive are exact (the old test used the tyre's AABB).
    const tyre=w.spin.children.find(o=>o.isMesh&&o.visible);
    tyre.geometry.computeBoundingBox();
    const tb=tyre.geometry.boundingBox, radius=Math.max(tb.max.y,tb.max.z), xMin=tb.min.x+1e-6, xMax=tb.max.x-1e-6;
    assert(Number.isFinite(radius)&&radius>0);
    const toWheel=new THREE.Matrix4().copy(w.holder.matrixWorld).invert().multiply(body.matrixWorld);
    // Existing skin below the parked tyre-top line is not a new suspension intrusion: only the part of the body above
    // it counts, tested against the real triangles. A hit is body inside the disc (contact within 1 µm is allowed).
    for(const tri of triangles){
      let poly=[tri.a,tri.b,tri.c].map(v=>v.clone());
      poly=clip(poly,'y',restTop+2e-6,1);
      if(poly.length<3)continue;
      poly=poly.map(v=>v.applyMatrix4(toWheel));
      poly=clip(clip(poly,'x',xMin,1),'x',xMax,-1);
      if(poly.length<3)continue;
      const dist=distToPolygonYZ(poly);
      assert(dist>=radius-1e-6,`${model.name||'race'} wheel ${i}: tyre cylinder penetrates actual body underside above parked line ${restTop} (distance ${dist.toFixed(4)} < radius ${radius.toFixed(4)}, ceiling ${wheelArch(model,i)}, hub y ${w.holder.position.y.toFixed(4)}; wheel-frame polygon ${poly.map(v=>v.toArray().map(n=>n.toFixed(3)).join(',')).join(' | ')})`);
    }
  });
  samples++;
}
// Known underside, not the box roof; scalar/array metadata is always in the body frame.
function fixture(cosmetics=false) {
  const model=new THREE.Group(),bodyPivot=new THREE.Group(),holder=new THREE.Group(),spin=new THREE.Group();
  const roof=new THREE.Mesh(new THREE.BoxGeometry(.5,.2,.6));roof.position.y=.4;
  const tyre=new THREE.Mesh(new THREE.CylinderGeometry(.2,.2,.12,12).rotateZ(Math.PI/2));
  spin.add(tyre);holder.add(spin);holder.position.y=-.1;model.add(bodyPivot,holder);bodyPivot.add(roof);
  model.userData={bodyPivot,wheels:[{holder,spin,restY:-.1,r:.2}]};
  if(cosmetics)for(const name of ['cosmetic-livery','cosmetic-scuffs','addon']){
    const group=new THREE.Group();group.name=name;if(name==='addon')group.userData.cosmetic=true;
    const decal=new THREE.Mesh(new THREE.BoxGeometry(3,.01,3));decal.position.y=.12;group.add(decal);bodyPivot.add(group);
  }
  return model;
}
{
  const model=fixture();
  assert(Math.abs(wheelArch(model,0)-.3)<1e-6,'fallback uses lowest underside, not roof at .5');
  assert.equal(drawnWheelY(model,0,-.1),-.1,'rest pose exact');
  assert(drawnWheelY(model,0,10)<=.100001);
  assert(drawnWheelY(model,0,.09)>.08&&drawnWheelY(model,0,.09)<.09,'travel eases before the underside');
  model.userData.wheelArch=.25;
  assert(drawnWheelY(model,0,10)<=.050001,'scalar metadata is a body-frame tyre-top ceiling');
  delete model.userData.wheelArch;
  assert.equal(wheelArch(fixture(true),0),wheelArch(model,0),'cosmetics present before cache excluded');
  const addon=new THREE.Mesh(new THREE.BoxGeometry(3,.01,3));addon.userData.cosmetic=true;addon.position.y=.11;
  model.userData.bodyPivot.add(addon);
  assert.equal(wheelArch(model,0),wheelArch(fixture(),0),'cosmetics added after cache cannot change clearance');
  // Nonzero body translation/rotation exercises the metadata frame, not just the neutral pose.
  model.userData.wheelArch=[.3];baseline(model);
  model.userData.bodyPivot.position.y=.07;model.userData.bodyPivot.rotation.set(.08,0,-.1);
  model.userData.wheels[0].holder.position.y=drawnWheelY(model,0,10);check(model);
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
  applyVehicleType(v,id); baseline(v.mesh); v.reset(0,0,0); return v;
}
for (const [kind,types] of Object.entries(VEHICLE_TYPES).filter(([kind])=>kind!=='jet')) for (const type of types) {
  const v = make(kind,type.id);
  for(const [i,w] of v.mesh.userData.wheels.entries()){
    assert.equal(drawnWheelY(v.mesh,i,w.holder.position.y),w.holder.position.y,`${type.id}: parked pose must not lower`);
  }
  // Settled ordinary asphalt driving, including the truck's lifted stance and sport-bike fork.
  for(const speed of [0,30,60,100]){
    v.reset(0,0,0);v.vel.set(0,0,speed/3.6);
    for(let j=0;j<480;j++){
      v.step(dt,input);
      if(j<360)continue;
      v.interpolate(1);v.syncMesh(dt);
      v.wheels.forEach((wh,i)=>{
        const w=v.mesh.userData.wheels[i];
        const raw=kind==='car'?w.restY+.3-(v.t.restLength-(wh.contact?wh.comp:0))-((v.typePhysics?.radius??.38)-w.r):-(v.t.travel-(wh.contact?wh.comp:0));
        assert.equal(drawnWheelY(v.mesh,i,raw),raw,`${type.id} wheel ${i}: normal driving at ${speed} km/h must not lower`);
      });
      check(v.mesh);
    }
  }
  if(type.id==='dirt'){
    const front=wheelArch(v.mesh,0);
    assert(front>=.139999&&front<=.21,`dirt front fender ceiling must be .14–.21, got ${front}`);
    const w=v.mesh.userData.wheels[0],old=w.holder.position.y;
    w.holder.position.y=.05; // tyre top .39 passes through the real fender; oracle must reject it.
    assert.throws(()=>check(v.mesh),/actual body underside/,'independent oracle detects the old tank-height ceiling');
    w.holder.position.y=old;
  }
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
for(const [kind,types] of Object.entries(VEHICLE_TYPES).filter(([kind])=>kind!=='jet')) for(const type of types) {
  const id=type.id, reference=make(kind,type.id), remoteBaseline=baseline(reference.mesh);
  mp.emit('roster',{players:[{id,name:id,skin:{vehicle:kind,type:id}}]});
  for(const compression of [null,0,10,100]) {
    for(let j=0;j<20;j++) {
      mp.emit('state',{from:id,srvT:now,p:[0,0,0],q:[0,0,0,1],vel:[0,0,1000/3.6],v:kind,
        ...(compression===null?{}:{w:Array(kind==='car'?4:2).fill(compression),lo:-100,la:100})});
      now+=1000/60; remotes.update(1/60);
      const model=remotes.model(id); if(model){if(!baselines.has(model))baselines.set(model,remoteBaseline.map((b,i)=>({...b,body:model.userData.bodyPivot||model.userData.wheels[i].holder.parent})));check(model);}
    }
  }
  assert(remotes.model(id),`${id}: remote built`);
  console.log(`PASS remote ${kind}/${id}: old client + 0–100 cm spring compression`);
}
remotes.dispose();
console.log(`PASS wheel clipping: ${samples} model poses, ${limited} types forced to full compression`);
