// No world data or renderer: every aircraft's interior, visibility lifecycle and actual cockpit camera.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { VEHICLE_TYPES, buildVehicleTypeModel } from '../game/src/vehicletypes.js';
import { createCockpitView } from '../game/src/models/cockpit.js';

const triangles = root => {
  let n = 0;
  root.traverse(o => { if (o.geometry) n += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
  return n;
};
const source = fs.readFileSync(new URL('../game/src/main.js', import.meta.url), 'utf8');
const cameraCode = source.slice(source.indexOf('let camMode = 0;'), source.indexOf('function updateCamera(dt)'));
const camera = new THREE.PerspectiveCamera(70, 16 / 9, .3, 2200), view = createCockpitView(camera);
let previous;
for (const { id } of VEHICLE_TYPES.jet) {
  const model = buildVehicleTypeModel('jet', id), { cockpit, canopy } = model.userData;
  assert(cockpit, `${id}: cockpit exists`);
  assert.equal(cockpit.group.visible, false, `${id}: no preview/chase clutter`);
  assert.equal(cockpit.group.parent, model);
  const added = triangles(cockpit.group), total = triangles(model);
  assert(added < 800, `${id}: small interior (${added} triangles)`);
  assert.equal(cockpit.group.children.length, 2, `${id}: two merged draw calls`);
  cockpit.group.traverse(o => {
    if (!o.geometry) return;
    assert([...o.geometry.attributes.position.array].every(Number.isFinite));
    assert.equal(o.material.userData.cosmeticRole, undefined);
  });
  view(model, true);
  assert.equal(camera.near, .06);
  assert(cockpit.group.visible); assert.equal(canopy.visible, false);
  if (previous) { assert.equal(previous.userData.cockpit.group.visible, false); assert(previous.userData.canopy.visible); }
  // A reset invokes wreck(false) even while flying in cockpit mode: it must not restore the canopy.
  model.userData.wreck(false); assert.equal(canopy.visible, false);
  model.userData.wreck(true); assert.equal(cockpit.group.visible, false); assert.equal(canopy.visible, false);
  model.userData.wreck(false); assert(cockpit.group.visible); assert.equal(canopy.visible, false);
  // Steady frames must not write visibility or projection again.
  const setter = cockpit.setVisible; cockpit.setVisible = () => { throw Error('steady-frame visibility work'); };
  view(model, true); cockpit.setVisible = setter;
  const v = { mesh: model, renderPos: new THREE.Vector3(120, 400, 900),
    renderQuat: new THREE.Quaternion().setFromEuler(new THREE.Euler(.2, .6, -.5)),
    vel: new THREE.Vector3(0, 0, 90), mode: 'air', hit: 0, landing: 0 };
  const ctx = vm.createContext({ THREE, vehicles: { current: v }, world: { heightAt: () => 0 }, camera });
  vm.runInContext(cameraCode + '\ncamMode = 2; this.tick = updateJetCamera;', ctx); ctx.tick(1 / 60);
  const expected = new THREE.Vector3(0, ...cockpit.eye).applyQuaternion(v.renderQuat).add(v.renderPos);
  assert(camera.position.distanceTo(expected) < 1e-8, `${id}: camera matches interior eye while banked`);
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(v.renderQuat);
  assert(camera.getWorldDirection(new THREE.Vector3()).distanceTo(forward) < 1e-8);
  // The glare shield is below the horizon and within the bottom 25–35% at the usual flying FOV.
  camera.fov = 70; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  const shield = new THREE.Vector3(0, cockpit.eye[0] - .2675, cockpit.eye[1] + (id === 'heli' ? 1 : id === 'stunt' ? .72 : .8));
  shield.applyQuaternion(v.renderQuat).add(v.renderPos).project(camera);
  assert(shield.y < -.35 && shield.y > -.6, `${id}: shield leaves horizon clear (${shield.y})`);
  console.log(`${id}: exterior before ${total - added}; model after ${total}; interior +${added} triangles / 2 draws (0 in chase)`);
  previous = model;
}
view(null, false); assert.equal(camera.near, .3); assert.equal(previous.userData.cockpit.group.visible, false);
// Leaving cockpit while wrecked must not regrow the shattered canopy.
view(previous, true); previous.userData.wreck(true); view(null, false);
assert.equal(previous.userData.canopy.visible, false);
previous.userData.wreck(false); assert(previous.userData.canopy.visible);
console.log('PASS cockpit visibility, reset/wreck, type switches, near plane, banked eye and sightline');
