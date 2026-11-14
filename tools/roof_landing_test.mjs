import assert from 'node:assert/strict';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike } from '../game/src/bike.js';
import { Jet } from '../game/src/jet.js';
import { Glider } from '../game/src/glider.js';
import { buildingRoofAt } from '../game/src/roofs.js';
const building={pts:[[-50,-50],[50,-50],[50,50],[-50,50]],top:10,h:10};
const world={heightAt:()=>0,groundAt:()=>0,terrainAt:()=>0,surfaceAt:()=>3,normalAt:(x,z,n)=>n.set(0,1,0),waterLevelAt:()=>-Infinity,buildingsNear:()=>[building],treesNear:()=>{},loadedAt:()=>true,extent:[-1000,-1000,1000,1000],spawn:[100,100]};
const idle={throttle:0,brake:0,steer:0,handbrake:false};
const step=(v,n)=>{for(let i=0;i<n;i++){v.savePrev();v.step(1/120,idle);assert.ok(Number.isFinite(v.pos.y));}};
for(const [name,make] of [['car',()=>new Car(world,{...TUNING_DEFAULTS})],['bike',()=>new Bike(world)],['jet',()=>new Jet(world)]]) {
 const v=make();v.reset(0,0,0);assert.ok(v.pos.y<2,`${name}: no teleport from beneath roof`);
 v.pos.set(0,12.5,0);v.vel.set(0,-2,0);v.savePrev();
 if(name==='jet'){v.mode='air';v.airTime=1;v.gear=1;v.vel.set(0,-2,0);}
 step(v,3600);
 assert.ok(v.pos.y>10 && v.pos.y<12,`${name} settled on roof ${v.pos.y}`);
 assert.ok(v.grounded,`${name} grounded on roof`);
 assert.ok(Math.abs(v.pos.x)<10 && Math.abs(v.pos.z)<50,`${name} not ejected by wall`);
 console.log(name,'roof settled at',v.pos.y.toFixed(3),'surface',v.surface);
 if(name==='jet') { v.pos.set(0,11.6,49); v.v=5; v.mode='ground'; let fell=false; for(let i=0;i<100;i++) { step(v,1); if(v.mode==='air') { fell=true; assert.ok(v.pos.y>8,'departure retains roof altitude'); break; } } assert.ok(fell,'taxiing off a roof enters flight'); }
 v.pos.set(49,4,0);v.vel.set(-2,0,0);v.collideBuildings(1.5);assert.ok(v.pos.x>=50,`${name} side wall blocks`);
 v.pos.set(0,100,0);v.vel.set(0,-300,0);v.collideBuildings(1.5);assert.equal(v.pos.x,0);
}
for(const [name,make] of [['car',()=>new Car(world,{...TUNING_DEFAULTS})],['bike',()=>new Bike(world)]]) {
 const v=make(),g=new Glider(v);v.reset(0,0,0);v.pos.set(0,11.3,0);v.vel.set(0,-2,20);g.active=true;g.t=1;v.savePrev();step(v,150);
 assert.equal(g.active,false,`${name} glider folds on roof`);assert.equal(g.result,'landed');assert.ok(v.pos.y>10,`${name} glider stays on roof`);
 console.log(name,'glider roof landing',g.result);
}
const b={...building,roofBuilding:{floor:0,parts:[{rect:{c:[0,0],L:40,W:20,a:0},h:10,roof:{type:'gable',pitch:45}}]}};
assert.equal(buildingRoofAt(b,0,0,world),20);assert.equal(buildingRoofAt(b,0,5,world),15);assert.equal(buildingRoofAt(b,0,15,world),-Infinity);
console.log('Roof landing, wall, underside, and sloped-height tests passed');
// A stationary vehicle can query before streaming completes; roofs must appear when the tile arrives.
let ready=false;
const streaming={...world,loadedAt:()=>ready,buildingsNear:()=>ready?[building]:[]};
const waiting=new Car(streaming,{...TUNING_DEFAULTS});waiting.pos.set(0,20,0);
assert.equal(waiting.world.heightAt(0,0),0);ready=true;assert.equal(waiting.world.heightAt(0,0),10);
assert.equal(waiting.world.heightAt,waiting.world.heightAt,'query functions are reused');
console.log('Stationary streaming cache refresh passed');
