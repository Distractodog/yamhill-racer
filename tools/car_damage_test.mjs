// Cosmetic crash regressions through the real collision entry points (no damage formula mocks).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { CAR_DAMAGE, refreshCarDamageAttachments, deformCarPoint } from '../game/src/cardamage.js';
import { applyVehicleType, typeModel, VEHICLE_TYPES, buildVehicleTypeModel } from '../game/src/vehicletypes.js';
import { collideBuilding } from '../game/src/roofs.js';
import { makeRaceBarriers } from '../game/src/racebarriers.js';
import { resolveCollision } from '../game/src/mp/collide.js';
import { paintedModel, createCosmetics } from '../game/src/cosmetics.js';
import { createVehicleLightLenses, createVehicleLights } from '../game/src/lights.js';
import { Glider } from '../game/src/glider.js';
import { beginTerrainStep } from '../game/src/steepterrain.js';

const input = { throttle: 0, brake: 0, steer: 0, handbrake: false }, dt = 1 / 120;
const wall = { pts: [[-20, 0], [20, 0], [20, 20], [-20, 20]], top: 10, h: 10 };
function world() {
  return { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
    normalAt: (_x, _z, n = new THREE.Vector3()) => n.set(0, 1, 0), waterLevelAt: () => -Infinity,
    buildingsNear: () => [], treesNear() {}, loadedAt: () => true, rampAt: () => 0,
    extent: [-10000, -10000, 10000, 10000], spawn: [0, 0] };
}
function car(type = 'race') { const c = new Car(world(), { ...TUNING_DEFAULTS }); applyVehicleType(c, type); c.reset(0, -10, 0); return c; }
function snapshot(model) {
  const out = [];
  model.traverse(o => { if (o.isMesh) out.push({ mesh: o, originalGeometry: o.geometry, p: o.geometry.attributes.position.array.slice(), n: o.geometry.attributes.normal?.array.slice() }); });
  return out;
}
function unchanged(before) {
  for (const { mesh, p } of before) assert.deepEqual(mesh.geometry.attributes.position.array, p);
}
function change(before) {
  let total = 0, max = 0, changed = 0;
  for (const { mesh, p } of before) {
    const a = mesh.geometry.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      const d = Math.hypot(a[i] - p[i], a[i + 1] - p[i + 1], a[i + 2] - p[i + 2]);
      total += d; max = Math.max(max, d); if (d > 1e-6) changed++;
    }
    for (const attr of ['position', 'normal']) assert([...mesh.geometry.attributes[attr].array].every(Number.isFinite), `finite ${attr}`);
  }
  return { total, max, changed };
}
function physics(c) { return [c.pos.toArray(), c.vel.toArray(), c.quat.toArray(), c.ang.toArray(), c.hit, c.drifting]; }
function building(c, speed, yaw = 0, tangent = 0) {
  c.pos.set(0, .75, -1.45 * (c.typePhysics?.width ?? 1)); c.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  c.vel.set(tangent, 0, speed); c.ang.set(0, 0, 0); c.grounded = true;
  c.collideBuildings = Car.prototype.collideBuildings;
  c.world.buildingsNear = () => [wall]; c.collideBuildings();
}
let parity = 0;
for (const { id } of VEHICLE_TYPES.car) {
  const c = car(id);
  const vehicles = { all: { car: c }, current: c, getType: () => id };
  const cosmetics = createCosmetics(vehicles, { storage: null, isUnlocked: () => true });
  const clean = snapshot(c.mesh), wheels = c.mesh.userData.wheels.flatMap(w => snapshot(w.holder));
  const colours = clean.filter(p => p.mesh.geometry.attributes.color).map(p => [p.mesh, p.mesh.geometry.attributes.color]);
  const independent = car(id), other = snapshot(independent.mesh), preview = snapshot(paintedModel('car', {}, id));
  const amounts = [];
  for (const speed of [1, 12, 45]) {
    c.reset(0, -10, 0); building(c, speed); c.damage.update(); amounts.push(change(clean).total);
  }
  assert.equal(amounts[0], 0); assert(amounts[1] > 0 && amounts[2] > amounts[1] * 1.2, `${id} low/medium/high ${amounts}`);
  assert(c.damage.sites[0].point.z > 0 && c.damage.sites[0].normal.z < 0, 'front contact');
  // Geometry work stops after an applied revision, including normal uploads.
  const versions = clean.map(({ mesh }) => [mesh.geometry.attributes.position.version, mesh.geometry.attributes.normal.version]);
  for (let i = 0; i < 120; i++) c.damage.update();
  assert.deepEqual(clean.map(({ mesh }) => [mesh.geometry.attributes.position.version, mesh.geometry.attributes.normal.version]), versions);
  unchanged(wheels); unchanged(other); unchanged(preview);
  for (const { originalGeometry, p } of clean) assert.deepEqual(originalGeometry.attributes.position.array, p, 'shared original geometry is untouched');
  assert(clean.some(({ mesh, n }) => n && mesh.geometry.attributes.normal.array.some((v, i) => Math.abs(v - n[i]) > 1e-5)), `${id}: dent normals updated`);
  // Medium hit accumulates after separation, but sustained contact never crushes it further.
  c.reset(0, -10, 0); building(c, 12); c.damage.update(); const first = change(clean).total;
  for (let i = 0; i < 120; i++) { c.damage.step(dt); building(c, 12); }
  c.damage.update(); assert.equal(change(clean).total, first, 'continuous contact debounce');
  c.damage.step(.3); building(c, 12); c.damage.update(); assert(change(clean).total > first, 'separate impact accumulates');
  for (let i = 0; i < 50; i++) { c.damage.step(.3); building(c, 1000 / 3.6); }
  c.damage.update(); const capped = change(clean);
  assert(capped.max <= CAR_DAMAGE.displacementCap + 1e-6); assert.equal(c.damage.sites.length, 1);
  c.damage.step(.3); building(c, 1000 / 3.6); c.damage.update(); assert.deepEqual(change(clean), capped);
  // Rear and side strikes preserve the first dent and deform distinct regions.
  for (const yaw of [Math.PI, Math.PI / 2, -Math.PI / 2]) { c.damage.step(.3); building(c, 45, yaw); }
  c.damage.update(); assert.equal(c.damage.sites.length, 4); assert(change(clean).total > capped.total);
  assert(c.damage.sites.some(s => s.point.z < -1)); assert(c.damage.sites.some(s => Math.abs(s.point.x) > 1));
  const levels = []; c.mesh.userData.bodyPivot.traverse(o => { if (o.isLOD) levels.push(...o.levels.map(l => l.object)); });
  for (const level of levels) assert(change(clean.filter(p => { let o = p.mesh; while (o && o !== level) o = o.parent; return !!o; })).changed > 0, `${id}: both body LODs dent`);
  // On a side strike, identical near/far rest vertices must receive identical displacement.
  const seen = new Map();
  for (const { mesh, p } of clean.filter(p => p.mesh.parent.parent?.isLOD)) {
    const a = mesh.geometry.attributes.position.array;
    for (let i = 0; i < a.length; i += 3) {
      const key = `${p[i]},${p[i + 1]},${p[i + 2]}`, value = [a[i], a[i + 1], a[i + 2]];
      if (seen.has(key)) assert.deepEqual(value, seen.get(key), `${id}: shared position LOD consistency`); else seen.set(key, value);
    }
  }
  // Paint still targets live colours after a geometry clone; previews never inherit the field.
  for (const [mesh, attr] of colours) assert.equal(mesh.geometry.attributes.color, attr, 'existing paint binding survives damage');
  cosmetics.set('car', { body: '#123456', trim: '#fedcba' });
  const garage = cosmetics.createPreview('car');
  const garageClean = snapshot(garage); cosmetics.prepare('car', c.mesh); unchanged(garageClean);
  assert.equal(c.damage.sites.length, 4, 'paint does not repair');
  // A new attachment at an existing dent follows the shell and repairs to its exact original.
  const attachment = new THREE.Mesh(new THREE.PlaneGeometry(.3, .3), new THREE.MeshBasicMaterial());
  attachment.position.set(0, 0, 2.1); c.mesh.userData.bodyPivot.add(attachment);
  const attachClean = snapshot(attachment); refreshCarDamageAttachments(c.mesh); assert(change(attachClean).changed > 0);
  c.reset(0, -10, 0); unchanged(clean); unchanged(attachClean); assert.equal(c.damage.sites.length, 0);
  building(c, 45); c.damage.update(); const cached = c.mesh;
  typeModel(c, id === 'race' ? 'truck' : 'race'); assert(c.damage.sites.length > 0, 'warm-up never repairs');
  applyVehicleType(c, id === 'race' ? 'truck' : 'race'); unchanged(clean);
  applyVehicleType(c, id); assert.equal(c.mesh, cached); unchanged(clean);
  // Direct vs glancing: same total speed, distinct normal speed.
  c.reset(0, -10, 0); building(c, 2, 0, 45); c.damage.update(); assert.equal(change(clean).total, 0);
  // Compare every numeric response with an otherwise identical car without the optional hook.
  for (const [speed, yaw, tangent] of [[1, 0, 0], [12, 0, 0], [45, 0, 60], [80, Math.PI / 2, 0]]) {
    const a = car(id), b = car(id); b.recordImpact = undefined;
    building(a, speed, yaw, tangent); building(b, speed, yaw, tangent); assert.deepEqual(physics(a), physics(b)); parity++;
  }
  // Normal driving, full braking and high speed downforce never create body-slam dents.
  const road = car(id); road.reset(0, -100, 0);
  for (let i = 0; i < 1200; i++) road.step(dt, { ...input, throttle: i < 600 ? 1 : 0, brake: i >= 600 ? 1 : 0 });
  assert.equal(road.damage.sites.length, 0, `${id} ordinary driving/braking`);
  road.vel.set(0, 0, 1000 / 3.6);
  for (let i = 0; i < 240; i++) road.step(dt, input);
  assert.equal(road.damage.sites.length, 0, `${id} downforce`);
  console.log(`PASS ${id}: speed ordering ${amounts.map(n => n.toFixed(2))}; accumulation/cap ${capped.max.toFixed(3)}m; front/rear/sides, LODs, paint, previews, reset/cache, driving/braking`);
}

// Shared collision routes: tree break returns early, barriers, multiplayer relative velocity,
// a hard underside slam, glider trunk, and swept terrain faces. Exact physics parity for each.
for (const { id } of VEHICLE_TYPES.car) for (const kind of ['tree', 'barrier', 'vehicle', 'ground', 'glider', 'terrain', 'parapet']) {
  const a = car(id), b = car(id); b.recordImpact = undefined;
  const run = c => {
    c.pos.set(0, .75, -2.6); c.vel.set(0, 0, 60); c.grounded = true; c.savePrev();
    if (kind === 'tree') {
      c.pos.z = -(1.4 * (c.typePhysics?.length ?? 1) + 1.15 * (c.typePhysics?.width ?? 1) + .2 - .03);
      let broken = false; c.world.breakTree = () => { broken = true; return true; };
      c.world.treesNear = (_x, _z, _r, fn) => { if (!broken) fn(0, 0, .2, 6, 0, 'tree'); };
      c.collideTrees(); assert(broken, 'must exercise early return for broken trunk');
    } else if (kind === 'barrier') {
      const barriers = makeRaceBarriers([[0, -40, 6], [0, 40, 6]], c.world);
      c.pos.set(5, .75, 0); c.vel.set(45, 0, 0); barriers.collide(c, dt);
    } else if (kind === 'vehicle') {
      c.pos.set(0, .75, -4.4); c.prevPos.copy(c.pos); c.vel.set(0, 0, 0);
      assert(resolveCollision(c, { v: 'car', p: [0, .75, 0], q: [0, 0, 0, 1], vel: [0, 0, -45], grounded: true }, dt));
    } else if (kind === 'ground') {
      c.pos.set(0, -.2, 0); c.vel.set(0, -30, 0); c.collideGround();
    } else if (kind === 'glider') {
      const glider = new Glider(c); glider.open = 1;
      c.pos.set(0, 5, -3.05); c.world.treesNear = (_x, _z, _r, fn) => fn(0, 0, .3, 20, 0, 'tree');
      assert(glider.hitTree());
    } else if (kind === 'parapet') {
      const roof = { ...wall, roofBuilding: { floor: 0, parts: [{ pts: wall.pts, h: 10, roof: { type: 'flat', parapet: .45 } }] } };
      c.pos.set(0, 10 + c.wheelReach(), .6); c.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI); c.vel.set(0, 0, -45);
      assert(collideBuilding(c, roof, 1.5) > 0);
    } else {
      c.world.terrainAt = () => 4;
      c.world.terrainNormalAt = (_x, _z, n) => n.set(0, .1, -Math.sqrt(.99));
      beginTerrainStep(c, c.wheelReach());
    }
  };
  run(a); run(b); assert.deepEqual(physics(a), physics(b), `${kind}: physics parity`); parity++;
  assert(a.damage.sites.length, `${kind}: records real contact`);
  const before = snapshot(a.mesh); a.damage.update(); assert(change(before).changed, `${kind}: visible damage`);
}
// Contact metadata must locate the impacting corner of an oblique barrier strike, and the
// overlap of different-sized vehicle faces, without changing either collision response.
{
  const a = car(), b = car(); b.recordImpact = undefined;
  const layer = makeRaceBarriers([[0, -40, 6], [0, 40, 6]], a.world);
  for (const c of [a, b]) {
    c.pos.set(4, .75, 0); c.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    c.vel.set(45, 0, 0); layer.collide(c, dt);
  }
  assert.deepEqual(physics(a), physics(b)); parity++;
  const hit = a.damage.sites[0];
  assert(hit && hit.point.x > .7 && hit.point.z > 1.5, 'oblique barrier contact at front corner, not door centre');
}
{
  const a = car(), b = car(); b.recordImpact = undefined;
  const remote = { v: 'bike', p: [1.3, .75, 2], q: [0, 0, 0, 1], vel: [-45, 0, 0], grounded: true };
  for (const c of [a, b]) { c.pos.set(0, .75, 0); c.prevPos.copy(c.pos); c.grounded = true; resolveCollision(c, remote, dt); }
  assert.deepEqual(physics(a), physics(b)); parity++;
  const hit = a.damage.sites[0];
  assert(hit && Math.abs(hit.point.x - 1) < 1e-6 && Math.abs(hit.point.z - 1.6) < 1e-6, 'vehicle side contact is overlap midpoint');
  assert.equal(hit.speed, 45, 'moving opponent supplies relative closing speed');
}
// Match-speed traffic is not an impact, even at very high absolute speed.
const convoy = car(); convoy.pos.set(0, .75, -4.4); convoy.prevPos.copy(convoy.pos); convoy.vel.set(0, 0, 200); convoy.grounded = true;
resolveCollision(convoy, { v: 'car', p: [0, .75, 0], q: [0, 0, 0, 1], vel: [0, 0, 200], grounded: true }, dt);
assert.equal(convoy.damage.sites.length, 0);
// Bound storage and coordinates after many different contact locations; old dents are never evicted.
const stress = car();
for (let i = 0; i < 1000; i++) { stress.damage.step(.3); building(stress, 45, i * .17); }
assert(stress.damage.sites.length <= CAR_DAMAGE.maxSites); stress.damage.update();
assert(change(snapshot(stress.mesh)).max === 0);
// Late-created lit lenses and glow centres follow dents, then return to their original anchors.
for (const { id } of VEHICLE_TYPES.car) {
  const c = car(id), reference = buildVehicleTypeModel('car', id);
  const pristineLights = createVehicleLightLenses(reference), lensClean = snapshot(pristineLights.group);
  building(c, 45); c.damage.update();
  const lights = createVehicleLightLenses(c.mesh);
  const lamps = []; lights.group.traverse(o => { if (o.isMesh && o.name !== 'vehicle-glow') lamps.push(o); });
  const pristine = lensClean.filter(p => p.mesh.name !== 'vehicle-glow');
  assert(lamps.some((m, i) => m.geometry.attributes.position.array.some((v, k) => v !== pristine[i].p[k])), `${id}: late lenses deform`);
  const glows = [], referenceGlows = [];
  lights.group.traverse(o => { if (o.name === 'vehicle-glow') glows.push(o); });
  pristineLights.group.traverse(o => { if (o.name === 'vehicle-glow') referenceGlows.push(o); });
  assert(glows.some((g, i) => g.position.distanceTo(referenceGlows[i].position) > .001), `${id}: glows follow lenses`);
  c.damage.repair();
  lamps.forEach((m, i) => assert.deepEqual(m.geometry.attributes.position.array, pristine[i].p));
  glows.forEach((g, i) => assert.deepEqual(g.position.toArray(), referenceGlows[i].position.toArray()));
  lights.dispose(); pristineLights.dispose();
}
// The existing light rig moves only its cached beam origin when damage changes, and repairs it.
{
  const c = car('truck'), lights = createVehicleLights(new THREE.Scene());
  lights.update(dt, c, 1); const before = lights.shape.from.clone();
  building(c, 45); c.damage.update(); lights.update(dt, c, 1);
  assert(lights.shape.from.distanceTo(before) > .001, 'beam follows the dented lamps');
  const after = lights.shape.from.clone(); lights.update(dt, c, 1); assert(lights.shape.from.equals(after));
  c.damage.repair(); lights.update(dt, c, 1); assert(lights.shape.from.equals(before)); lights.dispose();
}
// Deliberately malformed and excessive metadata is a robustness supplement, not visual evidence.
const bounded = car();
for (let i = 0; i < 1000; i++) {
  bounded.damage.step(.3);
  bounded.recordImpact(i % 10, 1, Math.floor(i / 10) % 10, 0, 0, -1, 45, 'test');
}
assert.equal(bounded.damage.sites.length, CAR_DAMAGE.maxSites);
const count = bounded.damage.revision;
bounded.recordImpact(NaN, 0, 0, 0, 0, -1, 45); assert.equal(bounded.damage.revision, count);

console.log(`PASS distractodog car damage: ${parity} exact collision physics comparisons; broken trees, relative vehicle speed, barriers, slams, glider, terrain, bounded state`);

// GPU uploads: emulate WebGLAttributes consuming updateRanges after real syncMesh calls.
// A new attribute gets its initial full buffer; subsequent uploads must include skin edits
// even when suspension animation runs after damage.update/repair in the same frame.
{
  const c = car(), uploads = new Map();
  const sync = () => { c.savePrev(); c.interpolate(1); c.syncMesh(1 / 60); };
  const position = () => c.mesh.userData.lod.levels[0].object.children[0].geometry.attributes.position;
  const upload = () => {
    const a = position(); let gpu = uploads.get(a);
    if (!gpu) { gpu = a.array.slice(); uploads.set(a, gpu); }
    else if (!a.updateRanges.length) gpu.set(a.array);
    else for (const r of a.updateRanges) gpu.set(a.array.subarray(r.start, r.start + r.count), r.start);
    assert.deepEqual(gpu, a.array, 'simulated GPU sees every skin/arm change');
    a.clearUpdateRanges();
  };
  sync(); upload();
  const skinCount = c.mesh.userData.lod.levels[0].object.children[0].userData.damageVertexCount * 3;
  const skinQueued = label => assert(position().updateRanges.some(r => r.start === 0 && r.count >= skinCount), label);
  building(c, 15); c.latAcc = 12; sync(); skinQueued('first dent + lean uploads skin'); upload();
  c.damage.step(.3); building(c, 45); c.latAcc = -22; sync(); skinQueued('accumulated dent + changed lean uploads skin'); upload();
  c.reset(0, -10, 0); c.latAcc = 20; c.lonAcc = -15; sync(); skinQueued('repair + changed lean uploads skin'); upload();
  c.latAcc = -20; c.lonAcc = 15; sync();
  assert(position().updateRanges.length && position().updateRanges.every(r => r.start >= skinCount), 'undamaged animation stays arms-only'); upload();
  for (let i = 0; i < 30; i++) { c.latAcc = i % 2 ? 20 : -20; sync(); }
  assert.equal(position().updateRanges.length, 1, 'pending arm animation does not grow ranges without a render'); upload();
  building(c, 45); sync(); upload(); const raceMesh = c.mesh;
  applyVehicleType(c, 'hatch'); applyVehicleType(c, 'race'); assert.equal(c.mesh, raceMesh);
  c.latAcc = 15; sync(); skinQueued('cached type repair uploads skin'); upload();
  console.log('PASS distractodog GPU ranges: real syncMesh, first/repeated dents, repair/cache, lean, arms-only and renderer consumption');
}

// Contacts use current physics pose + the cached cosmetic offset, not stale mesh world
// translation/quaternion. Pivot lean/lift and a chassis draw rise are distinct transforms.
for (const type of ['race', 'suv']) for (const transformed of [false, true]) {
  const c = car(type), pivot = c.mesh.userData.bodyPivot;
  if (transformed) {
    c.pos.set(31, 5, -17); c.quat.setFromEuler(new THREE.Euler(.25, .73, -.12));
    pivot.position.set(.05, .27, -.03); pivot.rotation.set(.12, -.06, .17);
  }
  pivot.updateMatrix();
  const offset = new THREE.Vector3(0, transformed ? .23 : 0, 0);
  const stalePosition = new THREE.Vector3(-90, 10, 84), staleQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-.2, -1, .15));
  c.damage.setDrawOffset(offset.clone().applyQuaternion(staleQuaternion).add(stalePosition), stalePosition, staleQuaternion);
  c.mesh.position.set(1e5, -1e4, 1e5); c.mesh.quaternion.copy(staleQuaternion);
  const local = new THREE.Vector3(.2, .3, 2), n = new THREE.Vector3(0, 0, -1);
  const point = local.clone().applyMatrix4(pivot.matrix).add(offset).applyQuaternion(c.quat).add(c.pos);
  const normal = n.clone().transformDirection(pivot.matrix).applyQuaternion(c.quat), before = physics(c);
  c.recordImpact(...point, ...normal, 45);
  assert(c.damage.sites[0].point.distanceTo(local) < 1e-10, `${type}: body-local point with transformed=${transformed}`);
  assert(c.damage.sites[0].normal.distanceTo(n) < 1e-10, `${type}: body-local normal`);
  assert.deepEqual(physics(c), before, 'mapping never writes physics');
  c.damage.repair(); assert.equal(c.damage.sites.length, 0);
  // Missing body pivot falls back to chassis coordinates (stand-in models/headless callers).
  c.mesh.userData.bodyPivot = null;
  const plain = local.clone().add(offset).applyQuaternion(c.quat).add(c.pos);
  c.recordImpact(...plain, ...n.clone().applyQuaternion(c.quat), 45);
  assert(c.damage.sites[0].point.distanceTo(local) < 1e-10);
  c.mesh.userData.bodyPivot = pivot; c.damage.repair();
  // Tyre envelopes are in holder/chassis space, even when the body is leaning/lifted.
  pivot.position.set(.6, .3, 0); pivot.rotation.set(.12, 0, .22); pivot.updateMatrix();
  const wheel = c.mesh.userData.wheels[0], tyreTop = wheel.holder.position.clone().add(new THREE.Vector3(0, wheel.r, 0));
  const bodyTyre = tyreTop.clone().applyMatrix4(pivot.matrix.clone().invert());
  const contact = tyreTop.clone().add(offset).applyQuaternion(c.quat).add(c.pos);
  const force = new THREE.Vector3(-1, 0, 0).applyQuaternion(c.quat);
  c.recordImpact(...contact, ...force, 45); c.damage.update();
  assert(deformCarPoint(c.mesh, bodyTyre.clone()).distanceTo(bodyTyre) < 1e-9, 'leaned/lifted body leaves the tyre envelope intact');
  c.reset(0, -10, 0); assert.equal(c.damage.sites.length, 0);
  applyVehicleType(c, type === 'race' ? 'suv' : 'race'); applyVehicleType(c, type);
  assert.equal(c.damage.sites.length, 0);
}
// The real syncMesh publishes draw rise even if its world position changes next step.
{
  const c = car(); c.pos.y = .1; c.savePrev(); c.interpolate(1); c.syncMesh(1 / 60);
  const expected = c.mesh.position.clone().sub(c.renderPos).applyQuaternion(c.renderQuat.clone().invert());
  assert(expected.length() > .05 && c.damage.drawOffset.distanceTo(expected) < 1e-10);
}
console.log('PASS distractodog contact coordinates: physics orientation, body lean/lift, draw rise, stale render pose, zero/null poses and tyre frame');

// Ray-cast triangle INTERIORS, not just vertices: independently triangulated layers used
// to sink behind the shell/grille frame. Track the visible surface colour and order at
// many grille, lamp, plate and trim points after real front/side building collisions.
for (const type of ['hatch', 'suv']) for (const level of [0, 1]) {
  const c = car(type), body = c.mesh.userData.bodyPivot.children.find(o => o.isLOD).levels[level].object;
  const meshes = []; body.traverse(o => { if (o.isMesh) meshes.push(o); });
  c.mesh.position.set(0, 0, 0); c.mesh.quaternion.identity(); c.mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(), z = c.mesh.userData.damagePanels[0].z;
  const surface = point => {
    ray.set(new THREE.Vector3(point.x, point.y, z + 2), new THREE.Vector3(0, 0, -1));
    const hit = ray.intersectObjects(meshes, false)[0]; assert(hit, `${type}: front sample must intersect at ${point.toArray()}`);
    const g = hit.object.geometry, colours = g.attributes.color, vertex = g.index ? g.index.getX(hit.faceIndex * 3) : hit.faceIndex * 3;
    const colour = colours ? [colours.getX(vertex), colours.getY(vertex), colours.getZ(vertex)] : hit.object.material.color.toArray();
    return { point: hit.point.clone(), colour: colour.map(v => v.toFixed(5)).join('/') };
  };
  const samples = [];
  const xs = type === 'suv' ? [-.52, -.38, -.21, .12, .27, .46, .78, .99] : [-.3, -.19, -.08, .14, .28, .48, .57, .73];
  const ys = type === 'suv' ? [-.04, .02, .09, .22, .31] : [.13, .155, .19, .23];
  for (const x of xs) for (const y of ys) samples.push(surface(new THREE.Vector3(x, y, z)));
  for (const speed of [15, 45]) {
    c.reset(0, -10, 0); building(c, speed); c.damage.update(); c.mesh.updateMatrixWorld(true);
    for (const original of samples) {
      const expected = deformCarPoint(c.mesh, original.point.clone()), hit = surface(expected);
      assert.equal(hit.colour, original.colour, `${type}/${speed}: front layer colour at ${original.point.toArray()}`);
      assert(hit.point.distanceTo(expected) < 2e-5, `${type}: front layer remains attached to its shell triangle`);
    }
  }
  for (const yaw of [0, Math.PI / 2, -Math.PI / 2]) { c.damage.step(.3); building(c, 45, yaw); }
  c.damage.update();
  for (const original of samples) {
    const hit = surface(deformCarPoint(c.mesh, original.point.clone()));
    assert.equal(hit.colour, original.colour, `${type}: repeated impacts preserve layer order`);
  }
  c.reset(0, -10, 0);
  for (const original of samples) assert.equal(surface(original.point).colour, original.colour);
  console.log(`PASS distractodog ${type} ${level ? 'far' : 'near'}: ${samples.length} grille/lamp/trim interior rays, medium/high/repeated/reset, no layer inversion`);
}

// Optional one-tile rehearsal of the browser runner's exact site and approach. It proves
// the low-speed setup actually reaches a real wall and every type/angle creates contact.
if (process.argv.includes('--real')) {
  const fs = await import('node:fs');
  const { makeWorld, makeTileData } = await import('../game/src/data.js');
  const { readTileData } = await import('../game/src/tilepack.js');
  const { findCarDamageSite } = await import('./lib/cardamagesite.mjs');
  const manifest = JSON.parse(fs.readFileSync('game/assets/world.json')), W = makeWorld(manifest);
  const raw = await readTileData(f => {
    const b = fs.readFileSync(`game/assets/tiles/0_0/${f}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }, manifest.packed);
  W.add(makeTileData(manifest, 0, 0, raw));
  const site = findCarDamageSite(W); let cases = 0;
  for (const { id } of VEHICLE_TYPES.car) for (const [speed, orientation] of [[2, 0], [15, 0], [45, 0], [45, Math.PI / 2], [45, Math.PI]]) {
    const c = new Car(W, { ...TUNING_DEFAULTS }); applyVehicleType(c, id);
    const radius = 1.5 * (c.typePhysics?.width ?? 1), x = site.x + site.nx * (radius + .1), z = site.z + site.nz * (radius + .1);
    c.reset(x, z, Math.atan2(-site.nx, -site.nz) + orientation); c.vel.set(-site.nx * speed, 0, -site.nz * speed);
    const record = c.recordImpact, contacts = [];
    c.recordImpact = function(...args) { if (args[7] === 'building') contacts.push(args); return record.apply(this, args); };
    for (let i = 0; i < 600 && !contacts.length; i++) c.step(dt, input);
    assert(contacts.some(c => c[6] > 0), `${id}/${speed}/${orientation}: real wall must be reached`);
    assert.equal(c.damage.sites.length > 0, speed > CAR_DAMAGE.threshold);
    c.damage.update(); cases++;
    console.log(`PASS real ${id} ${speed}m/s yaw+${orientation.toFixed(2)}: closing ${contacts[0][6].toFixed(2)}m/s, ${c.damage.sites.length} dents`);
  }
  console.log(`PASS distractodog browser rehearsal: ${cases} actual campus impacts at ${site.x.toFixed(2)}, ${site.z.toFixed(2)}; ${site.len.toFixed(1)}m wall`);
}
