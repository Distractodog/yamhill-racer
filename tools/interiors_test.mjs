// No renderer/world assets: ground interior budgets, attachment, camera, masks and damage isolation.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VEHICLE_TYPES, buildVehicleTypeModel } from '../game/src/vehicletypes.js';
import { ensureGroundInterior } from '../game/src/models/interiors.js';
import { createCockpitView } from '../game/src/models/cockpit.js';
import { applyCarDamageSites } from '../game/src/cardamage.js';

const camera = new THREE.PerspectiveCamera(66, 16 / 9, .3, 2200), view = createCockpitView(camera);
let previous;
for (const kind of ['car', 'bike']) for (const { id } of VEHICLE_TYPES[kind]) {
  const model = buildVehicleTypeModel(kind, id);
  assert.equal(model.userData.interior, undefined, 'previews have no interior');
  const interior = ensureGroundInterior(model, kind, id), { group, mount, masks } = interior;
  assert.equal(ensureGroundInterior(model, kind, id), interior, 'cached per type model');
  assert.equal(group.parent, null); assert.equal(group.visible, false);
  assert.equal(group.userData.damageRigid, true);
  let triangles = 0, draws = 0;
  const snapshot = [];
  group.traverse(o => {
    if (!o.isMesh) return;
    triangles += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; draws++;
    assert([...o.geometry.attributes.position.array].every(Number.isFinite));
    snapshot.push([o, o.geometry, o.geometry.attributes.position.array.slice()]);
  });
  assert(triangles < 850, `${kind}/${id}: ${triangles} triangles`);
  assert(draws <= 6, `${kind}/${id}: ${draws} draws`);
  assert(masks.length > 0, `${id}: blocking exterior faces found`);
  const state = { vel: new THREE.Vector3(0, 0, 20), steer: .5, t: { topSpeed: 300 } };
  view(model, true, state);
  assert.equal(group.parent, mount); assert.equal(camera.near, .06);
  model.updateMatrixWorld(true); interior.camera(camera); camera.updateMatrixWorld(true);
  if (kind === 'car' && id !== 'race') {
    // Both dial centres must be visible past the exterior, dash and wheel.
    const ray = new THREE.Raycaster(), target = new THREE.Vector3();
    for (const needle of interior.needles) {
      needle.getWorldPosition(target);
      const distance = target.distanceTo(camera.position);
      ray.set(camera.position, target.sub(camera.position).normalize());
      ray.far = distance - .002;
      assert.equal(ray.intersectObject(model).length, 0, `${id}: readable gauge centre`);
    }
    let bodyMaterial;
    mount.traverse(o => { if (o.material?.userData.cosmeticRole === 'body') bodyMaterial = o.material; });
    let paintedSills = 0;
    group.traverse(o => { if (o.isMesh && o.material === bodyMaterial) paintedSills++; });
    assert(paintedSills > 0, `${id}: sills share the live Garage body material`);
    const original = bodyMaterial.color.clone(); bodyMaterial.color.set('#3980ba');
    group.traverse(o => { if (o.material === bodyMaterial) assert.equal(o.material.color.getHexString(), '3980ba'); });
    bodyMaterial.color.copy(original);
  }
  if (id === 'sport') {
    const screen = group.getObjectByName('interior-windscreen');
    assert.equal(screen.material.opacity, .25); assert(screen.material.transparent);
    const top = new THREE.Vector3(0, .055, 0).applyMatrix4(screen.matrixWorld).project(camera);
    assert(top.y < -.35 && top.y > -1, 'sport screen stays in the bottom third');
    const ahead = new THREE.Vector3(0, 0, 1).transformDirection(mount.matrixWorld);
    const ray = new THREE.Raycaster(camera.position, ahead, .06, 2);
    assert.equal(ray.intersectObject(model).length, 0, 'sport road sightline is clear');
  }
  if (previous) assert.equal(previous.group.parent, null, 'switch detaches previous interior');
  for (const m of masks) assert.equal(m.mesh.geometry.index, m.filtered);
  model.position.set(50, 5, -30); model.rotation.set(.16, .7, -.08);
  mount.rotation.z = .3; mount.rotation.x = -.12;
  model.updateMatrixWorld(true); interior.camera(camera);
  const expected = interior.eye.clone().applyMatrix4(mount.matrixWorld);
  assert(camera.position.distanceTo(expected) < 1e-8, 'eye follows body pitch/roll and bike lean');
  assert(camera.up.distanceTo(new THREE.Vector3(0, 1, 0).transformDirection(mount.matrixWorld)) < 1e-8);
  if (kind === 'car') {
    applyCarDamageSites(model, [{ point: new THREE.Vector3(0, .4, .6), normal: new THREE.Vector3(0, 0, -1), depth: .3 }]);
    for (const [o, g, p] of snapshot) { assert.equal(o.geometry, g); assert.deepEqual(o.geometry.attributes.position.array, p); }
    applyCarDamageSites(model, []);
  }
  const angles = interior.needles.map(n => n.rotation.z);
  state.vel.set(0, 0, 60); state.steer = -.5;
  const visibility = interior.setVisible, traverse = model.traverse, projection = camera.updateProjectionMatrix;
  const fail = () => { throw Error('steady frame traversal/visibility/projection work'); };
  interior.setVisible = fail; model.traverse = fail; camera.updateProjectionMatrix = fail;
  try { for (let i = 0; i < 100; i++) view(model, true, state); }
  finally { interior.setVisible = visibility; model.traverse = traverse; camera.updateProjectionMatrix = projection; }
  interior.needles.forEach((n, i) => assert.notEqual(n.rotation.z, angles[i]));
  assert.doesNotMatch(interior.update.toString(), /\bnew\b|\.clone\(|\.traverse\(/);
  const start = performance.now();
  for (let i = 0; i < 10000; i++) interior.update(state);
  console.log(`${kind}/${id}: ${((performance.now() - start) / 10000).toFixed(4)} ms/instrument update`);
  view(null, false);
  for (const m of masks) assert.equal(m.mesh.geometry.index, m.original, 'exterior index restored after damage');
  assert.equal(group.parent, null); assert.equal(camera.near, .3);
  assert.doesNotThrow(() => interior.update(null), 'detached interiors do no work');
  view(model, true); previous = interior;
  console.log(`${kind}/${id}: +${triangles} triangles, ${draws} draws in first person; 0 attached in chase`);
}
view(null, false);
assert.equal(ensureGroundInterior(buildVehicleTypeModel('jet', 'fighter'), 'jet', 'fighter'), null);
console.log('PASS ground interior lifecycle, body camera, instruments and dent isolation');
