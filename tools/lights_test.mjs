import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCarModel } from '../game/src/carmodel.js';
import { buildBikeModel } from '../game/src/bike.js';
import { buildJetModel } from '../game/src/jet.js';
import { lightsEnabled, lightAnchors, createVehicleLightLenses, createVehicleLights, beamFor, beamAttenuation, BEAM_SHADER,
  BEAM_GLSL, BEAMS, AIM_DISTANCE } from '../game/src/lights.js';
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
local.update(.01, { ...car, grounded: false, glide: { active: true } }, 0, { brake: 1 });
assert.equal(local.lenses.group.getObjectByName('vehicle-light-tail').material.emissiveIntensity, .2, 'S while gliding does not brighten the tail');
local.update(.01, { ...car, grounded: true, glide: { active: false } }, 0, { brake: 1 });
assert.equal(local.lenses.group.getObjectByName('vehicle-light-tail').material.emissiveIntensity, 1, 'braking on the ground brightens the tail');
assert.equal(lightCount(), 1); assert.equal(local.spot.parent, scene);
local.update(.01, car, 0); assert.equal(local.on, false); assert.equal(local.spot.intensity, 0);
local.toggle(); local.update(.01, car, 0); assert(local.on); assert(local.spot.intensity > 0);
local.update(.01, car, .6); assert(local.on); assert.equal(local.override, null);
local.toggle(); local.update(.01, car, .6); assert.equal(local.on, false);
local.update(.01, car, 1); assert(local.on);
const oldLenses = car.mesh.getObjectByName('vehicle-lenses');
local.update(.01, vehicles[1], 1); assert.equal(local.spot.parent, scene, 'switching vehicles keeps the beam in the scene');
assert.equal(local.lenses.group.parent, vehicles[1].mesh.userData.lightMount);
{ const m = vehicles[1].mesh.userData.lightMount, lamp = m.localToWorld(vehicles[1].mesh.userData.lights.beam[0].clone());
  assert(local.spot.position.distanceTo(lamp) < .3, 'beam starts at the head lamp'); }
assert.equal(oldLenses.parent, car.mesh.userData.lightMount, 'switching vehicles keeps the old rig on its model (no shader recompile)');
local.update(.01, car, 1); assert.equal(local.lenses.group, oldLenses, 'switching back reuses that rig');
local.update(.01, vehicles[1], 1);
assert.equal(car.mesh.getObjectByName('player-headlight'), undefined);
// A bike's lights must lean with its body (the dirt bike's headlight also turns with the bars), while the beam stays
// forward and points down.
const bike = vehicles[1].mesh;
bike.userData.lean.rotation.z = .5; bike.userData.bars.rotation.y = .3;
bike.updateMatrixWorld(true);
const head = bike.getObjectByName('vehicle-light-head'), anchors = bike.userData.lights;
const expected = anchors.mounts.head.localToWorld(anchors.head[0].clone());
assert(head.getWorldPosition(new THREE.Vector3()).distanceTo(expected) < 1e-8);
assert.equal(head.parent.parent, bike.userData.bars, 'dirt bike headlight lens rides on the bars');
local.update(.01, vehicles[1], 1);
const beam = local.spot.target.position.clone().sub(local.spot.position);
assert(beam.z > 0 && beam.y < 0);
bike.userData.lean.rotation.z = 0; bike.userData.bars.rotation.y = 0;
// A toggle immediately after a preset change must survive the next frame.
local.toggle(0); local.update(.01, vehicles[1], 0); assert(local.on);
local.toggle(1); local.update(.01, vehicles[1], 1); assert.equal(local.on, false);
local.toggle(1);
settle(vehicles[1], 1); assert.equal(local.spot.intensity, local.shape.intensity);
const bikeLevel = local.spot.intensity;
local.update(.01, vehicles[2], 1); assert(local.spot.intensity > 0 && local.spot.intensity < bikeLevel, 'the beam fades out, no pop');
settle(vehicles[2], 1); assert.equal(local.spot.intensity, 0); assert.equal(local.spot.castShadow, false);
assert.equal(local.spot.visible, true, 'off = intensity 0, never visible=false (that recompiles every lit material)');
assert.equal(lightCount(), 1, 'jet: same light count');
// day/night changes, vehicle switches and the L key only fade the intensity; the light count never changes
for (const [v, night] of [[vehicles[0], 0], [vehicles[0], 1], [vehicles[1], 0], [vehicles[2], .6], [vehicles[0], 1]]) {
  settle(v, night, .3); assert.equal(lightCount(), 1); assert.equal(local.spot.parent, scene);
}
local.toggle(); settle(vehicles[0], 1); assert.equal(local.spot.intensity, 0); assert.equal(lightCount(), 1);
local.toggle(); settle(vehicles[0], 1); assert.equal(local.spot.intensity, local.shape.intensity);
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

// ---- every car / bike / aircraft type: its own anchors, and each lit lens lies on the lamp drawn on the model
const HEAD_LAMPS = new Set(['e4ebf0', 'd6dde3', '3b4149', 'f3f5f7', 'eef1f4', 'fff1cf', 'fff0d1', '1b2833', 'eef4ff', 'fff2c9']);
const lampColour = (hex, role) => role === 'head' ? HEAD_LAMPS.has(hex)
  : (([r, g, b]) => r > 115 && r > 2.2 * g && r > 2.2 * b)([0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)));   // sRGB red
// the meshes drawn up close: LOD levels other than the nearest are left out
function drawn(root) {
  const out = [];
  (function walk(o) {
    if (!o.visible || o.name.startsWith('vehicle-')) return;
    if (o.isMesh) out.push(o);
    const kids = o.isLOD && o.levels.length ? [o.levels[0].object] : o.children;
    for (const c of kids) walk(c);
  })(root);
  return out;
}
const colourAt = h => {
  const o = h.object, g = o.geometry, mat = Array.isArray(o.material) ? o.material[h.face.materialIndex] : o.material;
  return (g.attributes.color ? new THREE.Color().fromBufferAttribute(g.attributes.color, h.face.a) : mat.color).getHexString(THREE.SRGBColorSpace);
};
const ray = new THREE.Raycaster(), lensReport = [];
const models = Object.entries(VEHICLE_TYPES).flatMap(([kind, list]) => list.map(t => [kind, t.id, buildVehicleTypeModel(kind, t.id)]));
for (const [kind, id, mesh] of models) {
  const a = mesh.userData.lights; assert(a, `${kind} ${mesh.name}: own light anchors`);
  if (kind === 'jet') {           // aircraft types: subtle nav / strobe dots only; no landing lights or beam
    assert(['left', 'right', 'tail'].every(k => a.nav?.[k]?.isVector3) && a.nav.left.x > 0 && a.nav.right.x < 0 && a.nav.tail.z < 0, `${mesh.name}: nav lights`);
    assert.deepEqual(a.head, [], `${mesh.name}: no landing-light anchor`);
    assert.equal(mesh.userData.landingLight, undefined, `${mesh.name}: no landingLight flag`);
    const l = createVehicleLightLenses(mesh, kind); l.update({ on: true });
    assert.equal(l.group.getObjectByName('vehicle-light-left').material.emissive.getHexString(), 'ff1828', `${mesh.name}: port light is red`);
    l.dispose();
    local.update(.01, { mesh, kind }, 1); assert.equal(local.beam, false, `${mesh.name}: no aircraft beam`);
    assert.equal(local.spot.intensity, 0, `${mesh.name}: shared spotlight immediately off`);
    assert.equal(lightCount(), 1);
  } else {
    assert(a.head.length >= 1 && a.tail.length >= 1, `${kind} ${mesh.name}: head + tail`);
    for (const p of [...a.head, ...a.tail]) assert(p.isVector3 && p.toArray().every(Number.isFinite));
    if (!a.mounts?.head) assert(a.head.every(p => p.z > 0), `${kind} ${mesh.name}: head forward`);
    assert(a.tail.every(p => p.z < 0), `${kind} ${mesh.name}: tail back`);
    local.update(.01, { mesh, kind }, 1); assert(local.beam); assert.equal(lightCount(), 1);
  }
  // lenses: sample the middle and points 30% and 75% of the way to each corner of every head / tail lens; looking at the lens
  // from in front it must be what you see (not under the body), and right behind it (within 1.6 cm) the drawn lamp
  const fresh = buildVehicleTypeModel(kind, id), lenses = createVehicleLightLenses(fresh, kind);   // (the played one has the beam's rig)
  lenses.update({ on: true, brake: 1 }); fresh.updateMatrixWorld(true);
  const body = drawn(fresh), lensMeshes = [];
  fresh.traverse(o => { if (o.isMesh && /^vehicle-light-(head|tail)$/.test(o.name)) lensMeshes.push(o); });
  assert.equal(lensMeshes.length, a.head.length + a.tail.length, `${mesh.name}: one lens per lamp`);
  for (const lens of lensMeshes) {
    const role = lens.name.endsWith('head') ? 'head' : 'tail', pos = lens.geometry.attributes.position;
    const n = new THREE.Vector3().fromBufferAttribute(lens.geometry.attributes.normal, 0).transformDirection(lens.matrixWorld);
    const c = new THREE.Vector3().fromBufferAttribute(pos, 0).applyMatrix4(lens.matrixWorld), samples = [c];
    for (let i = 1; i < pos.count; i++) for (const f of [.3, .75]) samples.push(c.clone().lerp(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(lens.matrixWorld), f));
    let seen = 0, onLamp = 0;
    for (const p of samples) {
      ray.set(p.clone().addScaledVector(n, .4), n.clone().negate()); ray.far = .5;
      if (ray.intersectObjects([...body, lens], false)[0]?.object === lens) seen++;
      const behind = ray.intersectObjects(body, false)[0];
      if (behind && behind.distance - .4 < .017 && behind.distance - .4 > -.002 && lampColour(colourAt(behind), role)) onLamp++;
    }
    lensReport.push(`${mesh.name} ${role} (${lens.position.toArray().map(v => v.toFixed(2))}): seen ${seen}/${samples.length}, on lamp ${onLamp}/${samples.length}`);
    assert(seen >= .6 * samples.length, `${mesh.name} ${role} lens hidden by the body: ${lensReport.at(-1)}`);
    assert(onLamp >= .6 * samples.length, `${mesh.name} ${role} lens not on its drawn lamp: ${lensReport.at(-1)}`);
  }
  // a glow on every beam lamp of a ground vehicle or landing light
  const glows = []; fresh.traverse(o => { if (o.name === 'vehicle-glow') glows.push(o); });
  if (kind === 'jet') assert.equal(glows.length, 0, `${mesh.name}: no landing-light glow`);
  else assert.equal(glows.length, (a.mounts?.head ? a.head : a.beam || a.head).length, `${mesh.name}: glows`);
  lenses.dispose();
}
if (process.env.V) console.log(lensReport.join('\n'));

// ---- the beam: one light between the lamps, a wide even pool on the road from ~5 to ~25 m, dark by 55-60 m
assert(BEAM_SHADER, 'beam shape installed in three\'s spot light');
const pars = THREE.ShaderChunk.lights_pars_begin;
assert(pars.includes('float spotAttenuation = yrBeamAttenuation( spotLight, lVector );') && !pars.includes('getSpotAttenuation( spotLight.coneCos'));
for (const [o, c] of [['(', ')'], ['{', '}']]) assert.equal(BEAM_GLSL.split(o).length, BEAM_GLSL.split(c).length, `GLSL ${o}${c} balanced`);
{ const col = new THREE.Color(BEAMS.road.color).getRGB({}, THREE.SRGBColorSpace);      // the old beam: #fff4dc
  assert(col.r >= col.g && col.g >= col.b && col.b / col.r > .88 && col.g - col.b < .06, 'warm white, not yellow'); }
const win = (d, cut) => Math.max(0, 1 - (d / cut) ** 4) ** 2;
for (const [kind, id, mesh] of models) {
  if (kind === 'jet') continue;
  const b = beamFor(mesh, kind), axis = b.to.clone().sub(b.from).normalize(), ground = b.from.y - b.height;
  const lamps = mesh.userData.lights.beam || mesh.userData.lights.head, mid = lamps.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / lamps.length);
  assert(Math.abs(b.from.x - mid.x) < 1e-6 && Math.abs(b.from.y - mid.y) < 1e-6 && b.from.z - mid.z > 0 && b.from.z - mid.z < .3, `${id}: beam starts between its lamps`);
  assert(axis.y < 0 && Math.abs(b.to.y - ground) < 1e-6 && Math.abs(b.to.z - b.from.z - AIM_DISTANCE) < 1e-6, `${id}: aimed ahead and low`);
  const E = (x, d) => {         // irradiance on flat ground d ahead of the light, x to the side (decay 0: the shape does it)
    const L = new THREE.Vector3(x, ground - b.from.y, d), r = L.length();
    return b.intensity * (b.height / r) * beamAttenuation(L, axis, b.angle, b.penumbra) * win(r, b.distance);
  };
  const even = E(0, 12), row = [2, 5, 8, 12, 16, 20, 25, 35, 45, 55, 60].map(d => E(0, d) / even);
  assert(even > .7 && even < 2, `${id}: road brightness ${even}`);
  assert(row.slice(2, 7).every(v => v > .8 && v < 1.05) && row[1] > .75, `${id}: even from 5 to 25 m ${row.map(v => v.toFixed(2))}`);
  assert(row[0] < .25 && row[7] < .9 && row[8] < .5 && row[9] < .1 && row[10] === 0, `${id}: dark near the bumper, fades by 55-60 m ${row.map(v => v.toFixed(2))}`);
  assert(E(4, 15) > .8 * even && E(-4, 15) > .8 * even && E(9, 20) > .3 * even, `${id}: spreads to the sides`);
  assert.equal(E(0, -.3), 0, `${id}: nothing behind the light (the car itself)`);
  // a wall 15 m ahead (y = height over the lamps) is lit up to about the lamps' height, dark from 1 m above (a low
  // beam's cut-off: trees and signs above the road stay dark)
  const wall = y => { const L = new THREE.Vector3(0, y, 15); return beamAttenuation(L, axis, b.angle, b.penumbra); };
  assert(wall(-.2) > .9 && wall(.5) < .5 && wall(1) === 0, `${id}: cut-off above the lamps`);
}

nav.dispose(); local.dispose();
console.log('PASS lights: automatic/manual, preset toggle timing, anchors/mounts, replacement fallback, brake contrast, nav/strobe, local-only spotlight kept in the scene (intensity fade, constant light count), remote distance culling, model replacement/disposal, type model anchors, every lens on its drawn lamp and glows, beam shape installed, road pool even 5-25 m and gone by 60 m, spread, cut-off');
