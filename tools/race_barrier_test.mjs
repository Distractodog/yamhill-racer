// Real ground-vehicle contacts on a flat road, plus airborne escape and course-end rules.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { applyVehicleType } from '../game/src/vehicletypes.js';
import { makeWorld } from '../game/src/data.js';
import { Bike } from '../game/src/bike.js';
import { makeTrack } from '../game/src/track.js';
import { makeRaceBarriers, raceBounds, BARRIER_WIDTH, BARRIER_HEIGHT } from '../game/src/racebarriers.js';
import { buildRaceBarrierModel } from '../game/src/racebarriermodel.js';

export function testRaceBarriers() {
  const points = Array.from({length: 526}, (_, i) => [0, -100 + i * 4, 6]);
  let layer;
  const world = { heightAt:()=>0, terrainAt:()=>0, groundAt:()=>0, surfaceAt:()=>3, waterLevelAt:()=>-Infinity,
    normalAt:(_x,_z,n)=>n.set(0,1,0), treesNear(){}, buildingsNear:()=>[], loadedAt:()=>true,
    extent:[-10000,-10000,10000,10000], rampAt:()=>0, collideRaceBarriers:(v,dt)=>layer?.collide(v,dt) };
  const input = {throttle:0,brake:0,steer:0,handbrake:false}, dt=1/120, up=new THREE.Vector3();
  const types = [['car','race'],['car','suv'],['car','truck'],['bike','dirt'],['bike','sport']];
  const footprint = v => v.half || {x:1.2,front:1.95,back:-1.95};
  const point = new THREE.Vector3();
  function bodyTop(v) {
    const h=footprint(v); let top=-Infinity;
    for(const x of [-h.x,h.x]) for(const z of [h.back,h.front])
      top=Math.max(top,point.set(x,0,z).applyQuaternion(v.quat).y+v.pos.y);
    return top;
  }
  function wheelBottoms(v) {
    const up=new THREE.Vector3(0,1,0).applyQuaternion(v.quat);
    return v.wheels.map(w => {
      if(w.mount) point.copy(w.mount); else point.set(0,0,w.z);
      return point.applyQuaternion(v.quat).add(v.pos).addScaledVector(up,-v.wheelReach()+w.comp).y;
    });
  }
  let cases=0, maxGain=0;
  for (const [kind,type] of types) {
    const v=kind==='car'?new Car(world,{...TUNING_DEFAULTS}):new Bike(world);
    applyVehicleType(v,type);
    for (const kmh of [60,150,300]) for (const angle of [5,15,30,45,60,85,90]) for (const side of [-1,1]) for(const throttle of [0,1]) {
      layer = makeRaceBarriers(points,world);
      const yaw=angle*Math.PI/180*side, h=footprint(v);
      const support=h.x*Math.abs(Math.cos(yaw))+Math.max(h.front,-h.back)*Math.abs(Math.sin(yaw));
      v.reset(side*(6-BARRIER_WIDTH/2-support-.8),0,yaw);
      for(let i=0;i<240;i++)v.step(dt,input);
      const baseBody=bodyTop(v), baseWheels=wheelBottoms(v), bounds=raceBounds(makeTrack(points));
      v.vel.set(Math.sin(yaw)*kmh/3.6,0,Math.cos(yaw)*kmh/3.6);
      let hit=false, gain=0;
      const label=`${type} ${kmh} km/h / ${angle}° / side ${side} / throttle ${throttle}`;
      for(let i=0;i<240;i++) {
        v.step(dt,{...input,throttle}); hit ||= v.hit>0;
        assert([...v.pos,...v.vel,...v.quat,...v.ang].every(Number.isFinite),`${label}: nonfinite state`);
        assert(up.set(0,1,0).applyQuaternion(v.quat).y>0, `${label}: flipped`);
        assert(!bounds.update(v,dt),`${label}: left race`);
        for(const x of [-h.x,h.x]) for(const z of [h.back,h.front]) {
          point.set(x,0,z).applyQuaternion(v.quat).add(v.pos);
          assert(Math.abs(point.x)<=6-BARRIER_WIDTH/2+1e-5,`${label}: footprint inside barrier at ${point.x}`);
        }
        gain=Math.max(gain,bodyTop(v)-baseBody,...wheelBottoms(v).map((y,j)=>y-baseWheels[j]));
      }
      assert(hit, `${label}: test must hit wall`);
      assert(gain<.1,`${label}: climbed ${gain.toFixed(3)} m`);
      if(!throttle) assert(v.vel.length()<kmh/3.6, `${label}: impact loses speed`);
      maxGain=Math.max(maxGain,gain);cases++;
    }
  }
  console.log(`PASS ${cases} barrier impacts: race/SUV/truck/dirt/sport, 60/150/300 km/h × 5/15/30/45/60/85/90° from parallel × both sides × coast/throttle; max body/wheel rise ${maxGain.toFixed(4)} m`);
  // Exercise the real world query layer: race barriers must never become wheel/ground support.
  const realWorld=makeWorld({tile:2000,hstep:1,tiles:[[0,0]],extent:[-1000,-1000,1000,1000],spawn:[0,0]});
  realWorld.add({...world,tx:0,tz:0,x0:-1000,z0:-1000,buildings:[],treeCount:0});
  const samples=[];
  for(let x=5.5;x<6.5;x+=.05) samples.push([x,realWorld.heightAt(x,0),realWorld.normalAt(x,0).toArray()]);
  realWorld.setRaceBarriers(makeRaceBarriers(points,realWorld));
  for(const [x,height,normal] of samples) {
    assert.equal(realWorld.heightAt(x,0),height,'barrier must not add ground height');
    assert.deepEqual(realWorld.normalAt(x,0).toArray(),normal,'barrier must not tilt ground normals');
  }
  // A real baked ramp profile must launch the vehicle before it can cross the wall; no injected height or vertical velocity.
  const jumpPoints=Array.from({length:51},(_,i)=>[0,-100+i*4,24]);
  realWorld.setFixedRamps([{x:-12,z:0,yaw:Math.PI/2,w:10}]);
  realWorld.setRaceBarriers(makeRaceBarriers(jumpPoints,realWorld));
  for(const kind of ['car','bike']) {
    const jumper=kind==='car'?new Car(realWorld,{...TUNING_DEFAULTS}):new Bike(realWorld);
    jumper.reset(-23,0,Math.PI/2);
    for(let i=0;i<240;i++)jumper.step(dt,input);
    jumper.vel.set(150/3.6,0,0);
    const bounds=raceBounds(makeTrack(jumpPoints)); let launched=false, crossed=false, dnf=false;
    for(let i=0;i<600&&!dnf;i++) {
      jumper.step(dt,input);
      launched ||= !jumper.grounded && jumper.pos.x>-12 && jumper.pos.y>2;
      if(jumper.pos.x>24 && !crossed) {
        assert(launched && !jumper.grounded,`${kind}: ramp jump must be airborne at crossing`);
        assert(Math.min(...wheelBottoms(jumper))>BARRIER_HEIGHT,`${kind}: tyres clear the wall top`);
        crossed=true;
      }
      dnf=bounds.update(jumper,dt);
    }
    assert(crossed&&dnf,`${kind}: ramp-launched jump clears barrier and triggers out-of-bounds`);
  }
  console.log('PASS real world height/normal isolation and car/bike ramp-launched out-of-bounds');
  // A full-wall crossing in one step still hits, with no changes to height, vertical speed or rotation.
  layer=makeRaceBarriers(points,world);
  const fast=new Car(world,{...TUNING_DEFAULTS});fast.reset(0,0,Math.PI/2);
  fast.vel.set(300,1,12);fast.pos.x=10;fast.grounded=true;
  const beforeY=fast.pos.y, beforeQ=fast.quat.clone(), beforeAng=fast.ang.clone();
  assert(layer.collide(fast,1/30)>0,'swept footprint catches a full-wall crossing');
  assert(fast.pos.x<6 && fast.vel.x<0 && fast.vel.z>11,'wall bounces normal speed, retains scrape speed');
  assert.equal(fast.pos.y,beforeY);assert.equal(fast.vel.y,1);
  assert(fast.quat.equals(beforeQ)&&fast.ang.equals(beforeAng),'wall gives no angular impulse');
  fast.reset(4.8,0,0);fast.quat.setFromAxisAngle(new THREE.Vector3(0,0,1),Math.PI/6);
  fast.pos.y=fast.wheelReach()+BARRIER_HEIGHT+.1;fast.grounded=false;fast.vel.set(10,0,0);
  assert(layer.collide(fast,dt)>0,'a low tilted wheel still hits even when the centre clears');
  const junction=[[0,0,3],[4,0,7],[8,0,9],[12,0,7],[16,0,5],[17,-2,7],[15,-6,11],[13,-10,9],[12,-14,6]];
  const joined=makeRaceBarriers(junction,world), probe=new Car(world,{...TUNING_DEFAULTS});
  for(const [x,z] of junction) {
    probe.reset(x,z,0); const before=probe.pos.clone();joined.collide(probe,dt);
    assert(probe.pos.equals(before),'overlapping junction edges must not wall off the route centre');
  }
  layer=makeRaceBarriers(points,world);
  const car=new Car(world,{...TUNING_DEFAULTS}); car.reset(0,0,Math.PI/2);
  car.pos.y=8; car.vel.set(30,0,0);
  const bounds=raceBounds(makeTrack(points)); let dnf=false;
  for(let i=0;i<180&&!dnf;i++){car.step(dt,input);dnf=bounds.update(car,dt);}
  assert(dnf && car.pos.x>8, 'jump clears low barrier and ends race');
  const hover={pos:new THREE.Vector3(20,100,0),grounded:false}; const timer=raceBounds(makeTrack(points));
  for(let i=0;i<119;i++)assert.equal(timer.update(hover,dt),false);
  for(let i=0;i<3;i++)dnf=timer.update(hover,dt);
  assert(dnf,'airborne outside for one second ends race');
  const parked={pos:new THREE.Vector3(7.1,.6,2),quat:new THREE.Quaternion(),grounded:true};
  assert(raceBounds(makeTrack(points)).update(parked,dt),'parked parallel just fully outside must DNF');
  parked.pos.x=6.5;assert(!raceBounds(makeTrack(points)).update(parked,dt),'partially inside is not DNF');
  timer.reset(); hover.pos.x=0; assert.equal(timer.update(hover,2),false,'inside overhead stays in race');
  hover.pos.x=20; hover.grounded=true; assert(timer.update(hover,dt),'landing outside ends immediately');
  car.reset(0,-105,0);car.vel.set(0,0,10);const p=car.pos.clone();layer.collide(car,dt);
  assert(car.pos.equals(p),'start is physically open');
  car.reset(0,2005,0);const end=car.pos.clone();layer.collide(car,dt);assert(car.pos.equals(end),'finish is physically open');
  // One mesh, low wall and cap, linear colour attributes, and finite geometry.
  const model=buildRaceBarrierModel(layer); assert(model.mesh.isMesh);assert.equal(model.mesh.children.length,0);
  const pos=model.mesh.geometry.attributes.position;
  for(let i=0;i<pos.count;i++) assert(pos.getY(i)<=0.65001 && pos.getY(i)>=-0.081);
  assert(model.mesh.geometry.attributes.normal.getY(24)>.99, 'top normals face upward');
  model.dispose();
  let loaded=false;
  const streamed=buildRaceBarrierModel(makeRaceBarriers([[0,0,6],[0,4,6]],{groundAt:()=>12,loadedAt:()=>loaded}));
  const geometry=streamed.mesh.geometry, attribute=geometry.attributes.position;
  assert.equal(geometry.drawRange.count,0,'unloaded ground draws no wall at sea level');
  loaded=true;streamed.update();assert.equal(geometry.attributes.position,attribute,'streaming reuses GPU buffers');
  assert.equal(geometry.drawRange.count,120);assert(Math.abs(geometry.boundingSphere.center.y-12.285)<.001);
  streamed.dispose();
  console.log('PASS barriers: no escape/flip/NaN/climb; jump/hover/landing DNF; open ends; one low mesh');
}
if (process.argv[1]?.endsWith('race_barrier_test.mjs')) testRaceBarriers();
