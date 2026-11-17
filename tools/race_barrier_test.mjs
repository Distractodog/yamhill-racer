// Real ground-vehicle contacts on a flat road, plus airborne escape and course-end rules.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike } from '../game/src/bike.js';
import { makeTrack } from '../game/src/track.js';
import { makeRaceBarriers, raceBounds } from '../game/src/racebarriers.js';
import { buildRaceBarrierModel } from '../game/src/racebarriermodel.js';

export function testRaceBarriers() {
  const points = Array.from({length: 526}, (_, i) => [0, -100 + i * 4, 6]);
  let layer;
  const world = { heightAt:()=>0, terrainAt:()=>0, groundAt:()=>0, surfaceAt:()=>3, waterLevelAt:()=>-Infinity,
    normalAt:(_x,_z,n)=>n.set(0,1,0), treesNear(){}, buildingsNear:()=>[], loadedAt:()=>true,
    extent:[-10000,-10000,10000,10000], rampAt:()=>0, collideRaceBarriers:(v,dt)=>layer?.collide(v,dt) };
  const input = {throttle:0,brake:0,steer:0,handbrake:false}, dt=1/120, up=new THREE.Vector3();
  for (const kind of ['car','bike']) for (const kmh of [50,150,300]) for (const angle of [15,45,90]) for (const side of [-1,1]) {
    layer = makeRaceBarriers(points,world);
    const v = kind === 'car' ? new Car(world,{...TUNING_DEFAULTS}) : new Bike(world);
    const yaw=angle*Math.PI/180*side; v.reset(0,0,yaw);
    for(let i=0;i<120;i++)v.step(dt,input);
    v.vel.set(Math.sin(yaw)*kmh/3.6,0,Math.cos(yaw)*kmh/3.6);
    let hit=false;
    for(let i=0;i<240;i++) {
      v.step(dt,input); hit ||= v.hit>0;
      assert(Math.abs(v.pos.x)<6, `${kind} ${kmh}/${angle}: passed through at ${v.pos.x}`);
      assert(up.set(0,1,0).applyQuaternion(v.quat).y>0, `${kind}: flipped`);
      assert(Number.isFinite(v.pos.y), 'finite position');
    }
    assert(hit, `${kind} ${kmh}/${angle}: test must hit wall`);
    assert(v.vel.length()<kmh/3.6, 'impact loses speed');
  }
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
  console.log('PASS barriers: car/bike, 50/150/300 km/h × 15/45/90° × both sides; no escape/flip; jump/hover/landing DNF; open ends; one low mesh');
}
if (process.argv[1]?.endsWith('race_barrier_test.mjs')) testRaceBarriers();
