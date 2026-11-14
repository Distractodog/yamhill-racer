import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DrivingFX } from '../game/src/drivingfx.js';
const scene=new THREE.Scene(), fx=new DrivingFX(scene);
const car={kind:'car',renderPos:new THREE.Vector3(),renderQuat:new THREE.Quaternion(),vel:new THREE.Vector3(0,0,25),hit:8,input:{throttle:1},wheels:[{contact:true,surf:4,contactPoint:new THREE.Vector3()}]};
for(let i=0;i<120;i++)fx.update(1/60,car);
assert(fx.cursor>0);assert(fx.life.some(n=>n>0));
car.kind='jet';car.mode='air';car.vel.z=100;
for(let i=0;i<120;i++){car.renderPos.z+=1.6;fx.update(1/60,car);}
assert(fx.trailLife.some(n=>n>0));
car.renderPos.z+=10000;fx.update(1/60,car);assert(!fx.trailLife.some(n=>n>0));
for(const a of [fx.pos,fx.colors,fx.trailPos])assert(a.every(Number.isFinite));
assert.equal(fx.life.length,220);assert.equal(fx.trailLife.length,80);
fx.dispose();assert.equal(scene.children.length,0);
console.log('PASS: gravel/sparks/exhaust, wing trails, teleport reset, bounded buffers, disposal');
