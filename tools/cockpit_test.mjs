// No world data or renderer: every aircraft's interior, visibility lifecycle and actual cockpit camera.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as THREE from 'three';
import { VEHICLE_TYPES, buildVehicleTypeModel } from '../game/src/vehicletypes.js';
import { createCockpitView } from '../game/src/models/cockpit.js';

const triangles = root => {
  let n = 0;
  root.traverse(o => { if (o.geometry) n += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3 * (o.isInstancedMesh ? o.count : 1); });
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
  assert(added < 900, `${id}: small interior (${added} triangles)`);
  assert.equal(cockpit.group.children.length, cockpit.attitude ? 4 : 3, `${id}: merged fittings and instanced instruments`);
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
    vel: new THREE.Vector3(0, 0, 20), mode: 'air', hit: 0, landing: 0 };
  // Dynamic updates reuse the same matrices, buffers and object graph, with no construction/traversal.
  const matrices = cockpit.needles.instanceMatrix, geometry = cockpit.needles.geometry;
  const children = [...cockpit.group.children];
  assert.doesNotMatch(cockpit.update.toString(), /\bnew\b|\.clone\(|\.map\(|\.traverse\(/, 'no allocation or traversal in update');
  cockpit.update(v); const before = Array.from(matrices.array);
  v.vel.set(20, 10, 60); v.renderPos.y = 650; v.throttle = .8; v.rotor = .85;
  v.renderQuat.setFromEuler(new THREE.Euler(-.15, 1.2, .4));
  const fail = () => { throw Error('allocation or traversal during instrument update'); };
  const prototypes = [THREE.Vector3.prototype, THREE.Quaternion.prototype, THREE.Matrix4.prototype, THREE.BufferGeometry.prototype];
  const clones = prototypes.map(p => p.clone);
  const traverse = cockpit.group.traverse, compose = THREE.Matrix4.prototype.compose;
  // This also checks every compose uses the same preallocated scratch objects.
  let scratch = null;
  THREE.Matrix4.prototype.compose = function(position, rotation, scale) {
    if (!scratch) scratch = [this, position, rotation, scale];
    else { assert.equal(this, scratch[0]); assert.equal(position, scratch[1]); assert.equal(rotation, scratch[2]); assert.equal(scale, scratch[3]); }
    return compose.call(this, position, rotation, scale);
  };
  prototypes.forEach(p => { p.clone = fail; }); cockpit.group.traverse = fail;
  const setter2 = cockpit.setVisible, projection = camera.updateProjectionMatrix;
  cockpit.setVisible = fail; camera.updateProjectionMatrix = fail;
  try { for (let i = 0; i < 100; i++) view(model, true, v); }
  finally {
    prototypes.forEach((p, i) => { p.clone = clones[i]; }); cockpit.group.traverse = traverse;
    THREE.Matrix4.prototype.compose = compose; cockpit.setVisible = setter2; camera.updateProjectionMatrix = projection;
  }
  for (let i = 0; i < cockpit.needles.count; i++)
    assert.notDeepEqual(Array.from(matrices.array.slice(i * 16, i * 16 + 16)), before.slice(i * 16, i * 16 + 16), `${id}: needle ${i} follows its reading`);
  const start = performance.now();
  for (let i = 0; i < 10000; i++) cockpit.update(v);
  console.log(`${id}: instrument CPU ${((performance.now() - start) / 10000).toFixed(4)} ms/update`);
  assert.equal(cockpit.needles.instanceMatrix, matrices); assert.equal(cockpit.needles.geometry, geometry);
  assert.deepEqual(cockpit.group.children, children);
  assert([...matrices.array].every(Number.isFinite));
  if (cockpit.attitude) { assert.notEqual(cockpit.attitude.material.uniforms.bank.value, 0); assert.notEqual(cockpit.attitude.material.uniforms.pitch.value, 0); }
  if (id === 'heli') assert.equal(model.userData.mainRotor.visible, false, 'rotor hidden above cockpit roof');
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
  console.log(`${id}: exterior before ${total - added}; model after ${total}; interior +${added} triangles / ${cockpit.group.children.length} draws (0 in chase)`);
  previous = model;
}
view(null, false);
const version = previous.userData.cockpit.needles.instanceMatrix.version;
previous.userData.cockpit.update(null); // Hidden interiors do not even read vehicle state.
assert.equal(previous.userData.cockpit.needles.instanceMatrix.version, version);
assert.equal(camera.near, .3); assert.equal(previous.userData.cockpit.group.visible, false);
// Leaving cockpit while wrecked must not regrow the shattered canopy.
view(previous, true); previous.userData.wreck(true); view(null, false);
assert.equal(previous.userData.canopy.visible, false);
previous.userData.wreck(false); assert(previous.userData.canopy.visible);
assert(previous.userData.mainRotor.visible, 'helicopter rotor restored in chase');
view({ userData: {} }, true); assert.equal(camera.near, .3, 'ground vehicles without cockpits unchanged');
console.log('PASS cockpit visibility, reset/wreck, type switches, near plane, banked eye and sightline');
