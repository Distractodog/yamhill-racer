import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { makeTrack } from '../game/src/track.js';
import { raceTrack, crossedRaceGate, FINISH_RUNOFF } from '../game/src/racecourse.js';
import { makeRaceBarriers, raceBounds } from '../game/src/racebarriers.js';
import { createChallenges } from '../game/src/challenges.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';

const races = JSON.parse(fs.readFileSync('game/assets/challenges.json'));
let layer;
const world = { heightAt:()=>0, terrainAt:()=>0, groundAt:()=>0, surfaceAt:()=>3, waterLevelAt:()=>-Infinity,
  normalAt:(_x,_z,n)=>n.set(0,1,0), treesNear(){}, buildingsNear:()=>[], loadedAt:()=>true,
  pendingTiles:()=>0, extent:[-50000,-50000,50000,50000], rampAt:()=>0,
  setRaceBarriers:l=>{layer=l;}, collideRaceBarriers:(v,dt)=>layer?.collide(v,dt) };
const car = new Car(world, {...TUNING_DEFAULTS}), dt = 1/120;
for (const race of races.filter(r=>r.track)) {
  const g = race.gates.at(-1), source = JSON.stringify(race.track), points = raceTrack(race.track, g);
  assert.equal(JSON.stringify(race.track), source, 'baked route stays unchanged');
  const end = points.at(-1), fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);
  assert(Math.abs(Math.hypot(end[0]-g.x,end[1]-g.z)-FINISH_RUNOFF)<1e-6);
  const track = makeTrack(points), bounds = raceBounds(track);
  layer = makeRaceBarriers(points, world);
  // Probe the complete body through the arch and run-off, with its nose at the
  // far end. Past the finish the manager removes all walls, including other laps.
  for (let distance=-6; distance<=FINISH_RUNOFF-2; distance+=.25) {
    car.reset(g.x+fx*distance,g.z+fz*distance,g.yaw);
    car.vel.set(fx*80,0,fz*80); car.grounded=true;
    const before=car.pos.clone(); layer.collide(car,dt);
    assert(car.pos.distanceTo(before)<1e-6, `${race.id}: finish corridor blocked at ${distance} m`);
    assert(!bounds.update(car,dt),`${race.id}: finish run-off outside at ${distance} m`);
  }
  const from={x:g.x-fx,y:car.pos.y,z:g.z-fz}, to={x:g.x+fx,y:car.pos.y,z:g.z+fz};
  assert(track.contains(end[0],end[1]),'full 20 m run-off is inside');
  assert(crossedRaceGate(g,from,to,track),race.id);
  assert(!crossedRaceGate(g,to,from,track),'backwards crossing rejected');
  assert(!crossedRaceGate(g,from,{...to,x:to.x+fx*50,z:to.z+fz*50},track),'teleport rejected');
}
console.log('PASS all 11 ground race finish approaches: solid body clearance, 20 m run-off, crossing/bounds agreement');
const loop=makeTrack([[100,-10,6],[100,20,6],[0,-10,6],[0,20,6]]);
assert(!crossedRaceGate({x:0,z:0,yaw:0,w:2},{x:100,z:-1},{x:100,z:1},loop),
  'crossing the finish plane on another part of the course cannot finish');

// Real manager: physics/bounds runs BEFORE the frame's finish check. The arch
// can be narrower than the corridor, and a fast frame can pass the run-off end.
const element=()=>({style:{},append(){},querySelectorAll:()=>[],querySelector:()=>({addEventListener(){}}),
  getContext:()=>({fillRect(){},beginPath(){},moveTo(){},lineTo(){},fill(){}})});
globalThis.document={createElement:element,head:element(),body:element()};
globalThis.localStorage={getItem:()=>null,setItem(){}};
globalThis.addEventListener=()=>{};
const race={id:'finish-test',name:'Finish',start:{x:0,z:0,yaw:0},route:[[0,0],[0,10]],
  track:[[0,0,6],[0,10,6]],gates:[0,10].map(z=>({x:0,z,yaw:0,w:2}))};
globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('challenges.json')?[race]:[]});
const scene=new THREE.Scene(), ch=await createChallenges({scene,world,car,minimap:{}});
for (const mp of [false,true]) {
  await ch.start(0,{mp,gridCount:4}); ch.update(3.01);
  car.pos.set(4,car.pos.y,9);ch.update(.01);
  car.pos.z=44;car.grounded=true;ch.constrain();
  assert.equal(ch.state,'running','valid crossing must win over same-step out-of-bounds');
  ch.update(.1);
  assert.equal(ch.state,'finished');assert(!ch.result.dnf);assert.equal(ch.next,2);
  assert.equal(layer,null);assert(!scene.getObjectByName('race-barriers'));
  const result=ch.result;
  for(let i=0;i<240;i++){car.pos.x+=1;car.pos.z+=1;ch.constrain();ch.update(dt);}
  assert.equal(ch.result,result,'post-finish coast cannot become DNF');
  ch.quit();
}
await ch.start(0);ch.update(3.01);car.pos.set(12,car.pos.y,9);ch.update(.01);
car.pos.z=11;ch.constrain();ch.update(.01);
assert(ch.result.dnf,'crossing outside corridor must still DNF');ch.quit();
console.log('PASS solo/MP finish priority, corridor width, post-finish coast, mesh/collider cleanup and invalid crossing DNF');
