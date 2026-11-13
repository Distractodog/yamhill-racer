import assert from 'node:assert/strict';
import { Jet } from '../game/src/jet.js';
const world = { extent: [-10000,-10000,10000,10000], spawn:[0,0], heightAt:()=>0, waterLevelAt:()=>-Infinity, loadedAt:()=>true };
const j = new Jet(world);
j.reset(0,0,0); j.pos.y=3; j.vel.set(80,-35,60); j.mode='air';
const start=j.pos.clone(); j.crash('hard');
assert(j.vel.length()>60); assert.equal(j.pos.y,3);
assert.equal(j.mesh.scale.y,0.65);
let bounces=0, prevY=j.vel.y;
for(let n=0;n<480;n++) { j.step(1/120,{}); if(prevY<0&&j.vel.y>0)bounces++; prevY=j.vel.y; assert(Number.isFinite(j.pos.y)); }
assert(bounces>=2, `Expected repeated bounces, got ${bounces}`);
assert(j.pos.distanceTo(start)>20); assert.equal(j.mode,'crashed');
let respawned=0;
j.respawn=()=>{respawned++;return [0,200,0,0,450];};
for(let n=0;n<65;n++)j.step(1/120,{});
assert.equal(respawned,1); assert.equal(j.mode,'air'); assert.equal(j.mesh.scale.y,1);
console.log(`PASS: ${bounces} rebounds, momentum retained, wreck model restored and race air respawn called once`);
