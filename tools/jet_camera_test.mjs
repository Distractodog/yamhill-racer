// Exercise the actual camera function without a renderer, at speeds/frame rates that triggered snapping.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import * as THREE from 'three';
const source = fs.readFileSync(new URL('../game/src/main.js', import.meta.url), 'utf8');
const cameraCode = source.slice(source.indexOf('let camMode = 0;'), source.indexOf('function updateCamera(dt)'));
for (const fps of [30, 60, 120]) for (const kmh of [600, 1000, 1750, 3500]) {
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
// The jumbo's optional chase scales frame its entire 36 x 32 m airframe in both chase modes.
const { Jet } = await import('../game/src/jet.js');
const { applyVehicleType } = await import('../game/src/vehicletypes.js');
for (const mode of [0, 1]) for (const fps of [30, 60, 120]) {
 const v = new Jet({}); applyVehicleType(v, 'airliner');
 v.renderPos.set(0, 1500, 0); v.vel.set(0, 0, 950 / 3.6); v.mode = 'air';
 const camera = new THREE.PerspectiveCamera(68, 16/9, .1, 10000);
 const ctx = vm.createContext({ THREE, vehicles: { current: v }, world: { heightAt: () => 0 }, camera });
 vm.runInContext(cameraCode + `\ncamMode = ${mode}; this.tick = updateJetCamera;`, ctx);
 let previous, jump = 0;
 for (let n = 0; n < fps*8; n++) {
  v.renderPos.addScaledVector(v.vel, 1/fps); ctx.tick(1/fps);
  const offset = camera.position.clone().sub(v.renderPos);
  if (previous) jump = Math.max(jump, offset.distanceTo(previous)); previous = offset;
 }
 assert(jump < .001); camera.updateMatrixWorld();
 for (const x of [-16, 16]) for (const y of [-3.2, 7]) for (const z of [-18, 18]) {
  const p = new THREE.Vector3(x, y, z).add(v.renderPos).project(camera);
  assert(Math.abs(p.x) < .95 && Math.abs(p.y) < .95 && p.z < 1, 'jumbo fits inside chase view');
 }
 applyVehicleType(v, 'fighter');
 assert.equal(v.cam.chaseDistance, undefined); assert.equal(v.cam.chaseHeight, undefined);
 console.log(`PASS jumbo chase ${mode} @ ${fps} fps: whole airframe visible, no snaps, factory scales restored`);
}
