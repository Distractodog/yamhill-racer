import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCarModel } from '../game/src/carmodel.js';
import { buildBikeModel } from '../game/src/bike.js';
import { buildJetModel } from '../game/src/jet.js';
import { lightsEnabled, lightAnchors, createVehicleLightLenses, createVehicleLights, HEADLIGHT } from '../game/src/lights.js';
import { buildVehicleTypeModel, VEHICLE_TYPES } from '../game/src/vehicletypes.js';
assert.equal(lightsEnabled(0), false);
assert.equal(lightsEnabled(.01), true);
assert.equal(lightsEnabled(1, false), false);
assert.equal(lightsEnabled(0, true), true);
const vehicles = [buildCarModel(), buildBikeModel(), buildJetModel()].map((mesh, i) => ({ mesh, kind: ['car', 'bike', 'jet'][i] }));
for (const v of vehicles) {
  const a = lightAnchors(v.mesh, v.kind);
  assert.equal(a, v.mesh.userData.lights);
  assert.equal(a.head.length, v.kind === 'car' ? 2 : v.kind === 'bike' ? 1 : 0);
  for (const p of [...a.head, ...a.tail, ...Object.values(a.nav || {})]) assert(p.isVector3 && p.toArray().every(Number.isFinite));
  if (a.nav) { assert(a.nav.left.x > 0); assert(a.nav.right.x < 0); }
}
const fallback = new THREE.Group(); fallback.add(new THREE.Mesh(new THREE.BoxGeometry(2, 2, 4)));
fallback.position.set(90, 200, -40); fallback.rotation.y = .7;
const a = lightAnchors(fallback, 'replacement');
assert.equal(a.head.length, 1); assert(Math.abs(a.head[0].z - 2.03) < 1e-8);
// The headlight stays in the scene and visible for good (no light-count change → no shader recompiles); off = intensity 0.
const scene = new THREE.Scene(), lightCount = () => { let n = 0; scene.traverseVisible(o => { if (o.isLight) n++; }); return n; };
const settle = (v, night, s = 1.5) => { for (let t = 0; t < s; t += 1 / 60) local.update(1 / 60, v, night); };
const local = createVehicleLights(scene), car = vehicles[0];
assert.equal(lightCount(), 1); assert.equal(local.spot.parent, scene);
local.update(.01, car, 0); assert.equal(local.on, false); assert.equal(local.spot.intensity, 0);
local.toggle(); local.update(.01, car, 0); assert(local.on); assert(local.spot.intensity > 0);
local.update(.01, car, .6); assert(local.on); assert.equal(local.override, null);
local.toggle(); local.update(.01, car, .6); assert.equal(local.on, false);
local.update(.01, car, 1); assert(local.on);
const oldLenses = car.mesh.getObjectByName('vehicle-lenses');
local.update(.01, vehicles[1], 1); assert.equal(local.spot.parent, scene, 'switching vehicles keeps the beam in the scene');
assert.equal(local.lenses.group.parent, vehicles[1].mesh.userData.lightMount);
{ const m = vehicles[1].mesh.userData.lightMount, h = vehicles[1].mesh.userData.lights.head[0];
  assert(local.spot.position.distanceTo(m.localToWorld(h.clone().add(new THREE.Vector3(0, .12, 0)))) < 1e-6, 'beam starts at the head lamp'); }
assert.equal(oldLenses.parent, car.mesh.userData.lightMount, 'switching vehicles keeps the old rig on its model (no shader recompile)');
local.update(.01, car, 1); assert.equal(local.lenses.group, oldLenses, 'switching back reuses that rig');
local.update(.01, vehicles[1], 1);
assert.equal(car.mesh.getObjectByName('player-headlight'), undefined);
// A bike's lights must lean with its body, while the beam stays forward and points down.
const bike = vehicles[1].mesh;
bike.userData.lean.rotation.z = .5;
bike.updateMatrixWorld(true);
const head = bike.getObjectByName('vehicle-light-head');
const expected = bike.userData.lightMount.localToWorld(bike.userData.lights.head[0].clone());
assert(head.getWorldPosition(new THREE.Vector3()).distanceTo(expected) < 1e-8);
const beam = local.spot.target.position.clone().sub(local.spot.position);
assert(beam.z > 0 && beam.y < 0);
// A toggle immediately after a preset change must survive the next frame.
local.toggle(0); local.update(.01, vehicles[1], 0); assert(local.on);
local.toggle(1); local.update(.01, vehicles[1], 1); assert.equal(local.on, false);
local.toggle(1);
settle(vehicles[1], 1); assert.equal(local.spot.intensity, HEADLIGHT);
local.update(.01, vehicles[2], 1); assert(local.spot.intensity > 0 && local.spot.intensity < HEADLIGHT, 'the beam fades out, no pop');
settle(vehicles[2], 1); assert.equal(local.spot.intensity, 0); assert.equal(local.spot.castShadow, false);
assert.equal(local.spot.visible, true, 'off = intensity 0, never visible=false (that recompiles every lit material)');
assert.equal(lightCount(), 1, 'jet: same light count');
// day/night changes, vehicle switches and the L key only fade the intensity; the light count never changes
for (const [v, night] of [[vehicles[0], 0], [vehicles[0], 1], [vehicles[1], 0], [vehicles[2], .6], [vehicles[0], 1]]) {
  settle(v, night, .3); assert.equal(lightCount(), 1); assert.equal(local.spot.parent, scene);
}
local.toggle(); settle(vehicles[0], 1); assert.equal(local.spot.intensity, 0); assert.equal(lightCount(), 1);
local.toggle(); settle(vehicles[0], 1); assert.equal(local.spot.intensity, HEADLIGHT);
const remote = createVehicleLightLenses(fallback, 'replacement');
assert(remote.group.children.every(o => !o.isLight));
remote.update({ on: true });
const tail = remote.group.children[1], dim = tail.material.emissiveIntensity;
remote.update({ on: true, brake: 1 }); assert(tail.material.emissiveIntensity > dim);
assert(dim < 1 && tail.material.emissiveIntensity <= 1, 'brake contrast stays below output clipping');
remote.update({ on: false, brake: 1 }); assert(tail.visible); assert(!remote.group.children[0].visible);
remote.update({ on: false }); assert(!tail.visible);
remote.update({ on: true, distance: 401 }); assert(!remote.group.visible);
remote.update({ on: true, distance: 50 }); assert(remote.group.visible);
remote.dispose(); assert.equal(remote.group.parent, null);
const nav = createVehicleLightLenses(buildJetModel(), 'jet');
nav.update({ on: true, time: 0 }); assert(nav.group.children[3].visible);
nav.update({ on: true, time: .2 }); assert(!nav.group.children[3].visible);
const navTail = nav.group.getObjectByName('vehicle-light-nav-tail');
const steady = navTail.material.emissiveIntensity;
nav.update({ on: true, brake: 1 }); assert.equal(navTail.material.emissiveIntensity, steady);
nav.update({ on: false, brake: 1 }); assert(!navTail.visible, 'jet throttle/pitch input cannot light its nav tail');
// Every car / bike / aircraft type carries its own anchors.
const models = Object.entries(VEHICLE_TYPES).flatMap(([kind, list]) => list.map(t => [kind, buildVehicleTypeModel(kind, t.id)]));
for (const [kind, mesh] of models) {
  const a = mesh.userData.lights; assert(a, `${kind} ${mesh.name}: own light anchors`);
  if (kind === 'jet') {           // aircraft types: nav { left (port, +x, red), right, tail }; landing lights forward; a beam only from a landing light
    assert(['left', 'right', 'tail'].every(k => a.nav?.[k]?.isVector3) && a.nav.left.x > 0 && a.nav.right.x < 0 && a.nav.tail.z < 0, `${mesh.name}: nav lights`);
    assert(a.head.every(p => p.isVector3 && p.z > 0), `${mesh.name}: landing light forward`);
    const l = createVehicleLightLenses(mesh, kind); l.update({ on: true });
    assert.equal(l.group.getObjectByName('vehicle-light-left').material.emissive.getHexString(), 'ff1828', `${mesh.name}: port light is red`);
    l.dispose();
    local.update(.01, { mesh, kind }, 1); assert.equal(local.beam, !!mesh.userData.landingLight, `${mesh.name}: landing light beam`);
    assert.equal(lightCount(), 1); continue;
  }
  assert(a.head.length >= 1 && a.tail.length >= 1, `${kind} ${mesh.name}: head + tail`);
  for (const p of [...a.head, ...a.tail]) assert(p.isVector3 && p.toArray().every(Number.isFinite));
  assert(a.head.every(p => p.z > 0) && a.tail.every(p => p.z < 0), `${kind} ${mesh.name}: head forward, tail back`);
  local.update(.01, { mesh, kind }, 1); assert(local.beam); assert.equal(lightCount(), 1);
}
nav.dispose(); local.dispose();
console.log('PASS lights: automatic/manual, preset toggle timing, anchors/mounts, replacement fallback, brake contrast, nav/strobe, local-only spotlight kept in the scene (intensity fade, constant light count), remote distance culling, model replacement/disposal, type model anchors');
