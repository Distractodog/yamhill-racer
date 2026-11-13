// Exercise the actual camera function without a renderer, at speeds/frame rates that triggered snapping.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const source = fs.readFileSync(new URL('../game/src/main.js', import.meta.url), 'utf8');
const cameraCode = source.slice(source.indexOf('let camMode = 0;'), source.indexOf('function updateCamera(dt)'));
for (const fps of [30, 60, 120]) for (const kmh of [600, 1000, 1750]) {
 const v = {renderPos:new THREE.Vector3(0,1500,0),renderQuat:new THREE.Quaternion(),vel:new THREE.Vector3(0,0,kmh/3.6),mode:'air',hit:0,landing:0};
 const camera = new THREE.PerspectiveCamera(68,1,0.1,10000);
 const ctx=vm.createContext({THREE,vehicles:{current:v},world:{heightAt:()=>0},camera});
 vm.runInContext(cameraCode+'\nthis.tick=updateJetCamera;',ctx);
 let prevOffset=null,maxJump=0;
 for(let n=0;n<fps*8;n++) {
  v.renderPos.addScaledVector(v.vel,1/fps); ctx.tick(1/fps);
  const offset=camera.position.clone().sub(v.renderPos);
  if(prevOffset) maxJump=Math.max(maxJump,offset.distanceTo(prevOffset));
  prevOffset=offset;
 }
 assert(maxJump<0.001,`${kmh} km/h @ ${fps} fps: camera offset jumped ${maxJump}m`);
 // A teleport should immediately reattach the camera instead of dragging it across the map.
 v.renderPos.x+=5000;ctx.tick(1/fps);assert(camera.position.distanceTo(v.renderPos)<60);
 console.log(`PASS ${kmh} km/h @ ${fps} fps: no camera snaps; teleport follows`);
}
