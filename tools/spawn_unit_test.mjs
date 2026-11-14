import assert from 'node:assert/strict';
import { createSpawn } from '../game/src/spawn.js';
import { buildCampusGateGeometry, CAMPUS_GATE } from '../game/src/campusgate.js';
const listeners=[];globalThis.addEventListener=(_,fn)=>listeners.push(fn);
const controller=createSpawn();let callback, loaded=false, resets=[], quit=0, welcome=0;
const car={pos:{y:10,set(x,y,z){this.x=x;this.y=y;this.z=z;}},vel:{set(){}},savePrev(){},interpolate(){},reset(...p){resets.push(p);}};
const minimap={open:false,pickSpawn(fn){callback=fn;this.open=!!fn;},toggle(v){this.open=v;}};
controller.start({car,minimap,world:{mapContains:x=>x>0,loadedAt:()=>loaded,pendingTiles:()=>0},settings:{closeWelcome(){},showWelcome(){welcome++;}},clearKeys(){},challenges:{quit(){quit++;}}});
await callback(-1,0);assert.equal(resets.length,0);assert(controller.blocked);
const selecting=callback(3800,1400);assert(controller.blocked);assert.equal(resets.length,0);
loaded=true;await selecting;assert.deepEqual(controller.point,[3800,1400]);assert.equal(welcome,1);assert(!controller.blocked);
await controller.goHome();assert.equal(quit,1);assert.deepEqual(resets.at(-1),[3800,1400,0]);
assert.equal(createSpawn().point,null);
const g=buildCampusGateGeometry(()=>100);g.computeBoundingBox();assert(g.boundingBox.min.y>=100);
const p=g.attributes.position,c=Math.cos(CAMPUS_GATE.yaw),s=Math.sin(CAMPUS_GATE.yaw);
for(let i=0;i<p.count;i++){assert(Number.isFinite(p.getY(i)));const u=(p.getX(i)-CAMPUS_GATE.x)*c-(p.getZ(i)-CAMPUS_GATE.z)*s;assert(Math.abs(u)>7.8,'gate must leave the driveway open');}
g.dispose();console.log('PASS: invalid choice, terrain wait, session spawn, home return, fresh session, open gate geometry');
