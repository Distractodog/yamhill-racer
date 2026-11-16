// Race car model checks in Node (no browser): triangle budget near/far, finite geometry, size and stance, the parts a
// modern open-wheeler needs (found by colour and place), Garage paint roles, livery / scuff panels on the surfaces,
// light anchors on the lenses, wheel layout for car.js / mp/remotes.js, wheels clear of the body, the suspension arms
// following the wheels (local car and a baked remote copy), and the real Car driving it.
//   node tools/racecar_model_test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildCarModel, WHEEL_POS } from '../game/src/carmodel.js';
import { PAINT, TRIM, HELMET, STANCE } from '../game/src/models/racecar.js';
import { buildVehicleTypeModel } from '../game/src/vehicletypes.js';
import { paintedModel } from '../game/src/cosmetics.js';
import { TUNING_DEFAULTS, Car } from '../game/src/car.js';

const model = buildCarModel(), ud = model.userData;
model.updateMatrixWorld(true);
assert.equal(buildVehicleTypeModel('car', 'race').name, 'car-race', 'the race type builds this model');
const tris = root => { let n = 0; root.traverse(o => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return n; };
const [nearGroup, farGroup] = ud.lod.levels.map(l => l.object);
const wheelTris = ud.wheels.reduce((s, w) => s + tris(w.holder), 0), near = tris(nearGroup) + wheelTris, far = tris(farGroup) + wheelTris;
console.log(`triangles: near body ${tris(nearGroup)}, far body ${tris(farGroup)}, wheels ${wheelTris} → near ${near}, far ${far}`);
assert(near <= 6000, `near over budget: ${near}`);
assert(tris(farGroup) <= 1000, `far body over budget: ${tris(farGroup)}`);
assert(ud.lod.levels[1].distance >= 50);
assert.deepEqual(ud.triangles, { near: tris(nearGroup), far: tris(farGroup) });

model.traverse(o => {
  if (!o.isMesh) return;
  for (const name of ['position', 'normal']) assert(o.geometry.attributes[name].array.every(Number.isFinite), `${name} NaN in ${o.parent?.name}`);
});

// size and stance: body only, model space; the ground under the parked tyres
const box = new THREE.Box3().setFromObject(nearGroup), size = box.getSize(new THREE.Vector3());
const ground = Math.min(...ud.wheels.map(w => w.holder.position.y - w.r));
console.log(`body: width ${size.x.toFixed(2)} m, length ${size.z.toFixed(2)} m, top ${(box.max.y - ground).toFixed(2)} m above ground, ` +
  `lowest ${(box.min.y - ground).toFixed(2)} m`);
assert(size.x > 1.8 && size.x < 2.1, 'width (front wing)'); assert(size.z > 4.6 && size.z < 5.2, 'length');
assert(box.max.y - ground > .9 && box.max.y - ground < 1.15, 'airbox height');
assert(box.min.y - ground > .05, 'floor clear of the ground');
// parked hubs = car.js syncMesh at rest
const comp = 900 * 24 / (4 * TUNING_DEFAULTS.springK);
assert(Math.abs(STANCE - (.3 - (TUNING_DEFAULTS.restLength - comp))) < 1e-9, 'STANCE matches car.js defaults');
ud.wheels.forEach((w, i) => {
  assert(Math.abs(w.holder.position.y - (w.restY + .3 - (TUNING_DEFAULTS.restLength - comp) - (.38 - w.r))) < 1e-9, 'parked hub');
  assert.deepEqual([w.holder.position.x, w.holder.position.z, w.r, w.front], [WHEEL_POS[i][0], WHEEL_POS[i][2], WHEEL_POS[i][4], WHEEL_POS[i][3]]);
  assert(w.spin.parent === w.holder && w.spin.children[0].isMesh && w.spin.children[1].isMesh, 'holder → spin → [tyre, rim, …]');
  assert(Math.abs(w.hubWidth - WHEEL_POS[i][5] - .01) < 1e-9, 'Garage hub covers sized to the tyres');
});

// the parts, found by their colours where they belong (body frame)
const pts = (root, hex) => {
  const c = new THREE.Color(hex), out = []; root.traverse(o => {
    const a = o.geometry?.attributes.color; if (!a) return; const p = o.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) if (Math.abs(a.getX(i) - c.r) + Math.abs(a.getY(i) - c.g) + Math.abs(a.getZ(i) - c.b) < 1e-4) out.push(new THREE.Vector3().fromBufferAttribute(p, i));
  }); return out;
};
const within = (list, test) => list.some(test);
const helmet = pts(nearGroup, HELMET), visor = pts(nearGroup, '#1c2a3a'), carbon = pts(nearGroup, '#1b1c20'), paint = pts(nearGroup, PAINT), trim = pts(nearGroup, TRIM);
assert(helmet.length > 50 && within(helmet, v => v.y > .44) && helmet.every(v => Math.abs(v.x) < .14 && v.z < .08 && v.z > -.2), 'helmet in the cockpit');
assert(visor.length && visor.every(v => v.z > -.02), 'visor faces forward');
assert(within(carbon, v => v.y > .43 && Math.abs(v.x) > .2 && v.z < 0) && within(carbon, v => v.y > .4 && Math.abs(v.x) < .03 && v.z > .4), 'halo over the cockpit');
assert(within(paint, v => v.y > .52 && v.z < -.5 && Math.abs(v.x) < .01), 'shark fin / airbox');
assert(within(paint, v => Math.abs(v.x) > .6 && v.z > .3 && v.z < .45), 'sidepods reach out to the intakes');
assert(within(paint, v => Math.abs(v.x) > .95 && v.z > 2.5), 'front wing endplates');
assert(within(trim, v => v.z > 2.0 && v.z < 2.2 && Math.abs(v.x) > .9), 'front wing top flap (trim)');
assert(within(trim, v => v.z < -2.2 && v.y > .45), 'DRS flap (trim)');
assert(within(paint, v => Math.abs(v.x) > .6 && v.y > .45 && v.z < -2.2), 'rear wing endplates');
assert(within(paint, v => Math.abs(v.x) > .4 && Math.abs(v.x) < .55 && v.y > .26 && v.z > .3 && v.z < .5), 'mirrors');
assert(within(carbon, v => v.z < -2.2 && v.y < -.18 && v.y > -.23), 'diffuser');
assert(within(carbon, v => Math.abs(v.x) > .7 && v.y < -.34), 'floor');
assert(pts(nearGroup, '#b3121c').some(v => v.z < -2.27 && Math.abs(v.x) < .05), 'rain light on the crash structure');
// paint roles: palette vertices (body / trim / helmet) on both detail levels, rims painted 'wheels'
for (const g of [nearGroup, farGroup]) for (const hex of [PAINT, TRIM, HELMET]) assert(pts(g, hex).length, `${g.name}: ${hex}`);
assert(ud.wheels.every(w => w.spin.children[1].material.userData.cosmeticRole === 'wheels'));

// Garage colours reach the vertices (cosmetics.js vertex palette) on both levels, the rims, and the remote's colours
{
  const m = paintedModel('car', { body: '#123456', trim: '#00ff00', helmet: '#ff00ff', wheels: '#abcdef' });
  for (const name of ['body-near', 'body-far']) for (const hex of ['#123456', '#00ff00', '#ff00ff']) assert(pts(m.getObjectByName(name), hex).length, `${name} painted ${hex}`);
  assert.equal('#' + m.userData.wheels[0].spin.children[1].material.color.getHexString(), '#abcdef');
  assert(pts(buildCarModel({ paint: 0x2266ff }).getObjectByName('body-near'), '#2266ff').length, 'buildCarModel colours');
}
// livery panels on the nose / sidepod tops and the scuffs: corners within 1.2 cm above the surface
{
  const body = []; nearGroup.traverse(o => { if (o.isMesh) body.push(o); });
  const ray = new THREE.Raycaster();
  for (const [w, h, x, y, z, rx] of [...ud.decalPanels, ...ud.scuffPanels]) {
    const plane = new THREE.Object3D(); plane.position.set(x, y, z); plane.rotation.set(rx, 0, 0); plane.updateMatrixWorld();
    for (const [u, v] of [[0, 0], [-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]]) {
      const p = plane.localToWorld(new THREE.Vector3(u * w, v * h, 0));
      ray.set(new THREE.Vector3(p.x, 3, p.z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObjects(body)[0]; assert(hit, 'no body under a livery panel');
      const gap = p.y - hit.point.y; assert(gap > -.001 && gap < .012, `panel at ${x},${z} corner ${u},${v}: ${gap.toFixed(4)} m off the surface`);
    }
  }
}
// lights: head anchors on the front wing endplate lamps, tail = rain light + endplate strips
assert.equal(ud.lights.head.length, 2); assert(ud.lights.tail.length >= 1);
assert(ud.lights.head.every(p => p.z > 2.5 && Math.abs(p.x) > .9) && ud.lights.tail.every(p => p.z < -2.2));
assert(ud.lights.tail.some(p => p.x === 0 && p.y < 0), 'rain light anchor');
assert.equal(ud.lightMount, ud.bodyPivot);

// wheels clear of the body at rest: no body vertex inside any tyre (wishbones end at the tyre's inner face)
{
  let hits = 0; const v = new THREE.Vector3();
  for (const g of [nearGroup, farGroup]) g.traverse(o => {
    if (!o.isMesh) return; const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      for (const [k, w] of ud.wheels.entries()) {
        const h = w.holder.position, half = WHEEL_POS[k][5] / 2;
        if (Math.abs(v.x - h.x) < half - .03 && Math.hypot(v.y - h.y, v.z - h.z) < w.r - .01) hits++;
      }
    }
  });
  assert.equal(hits, 0, `${hits} body vertices inside a tyre`);
}
// open wheels: the same tyre-top ceilings as the old model (its measured fallback: tyre top at the WHEEL_POS hub + 8 cm)
console.log('wheelArch (tyre-top ceiling, m):', ud.wheelArch.join(', '));
assert.deepEqual(ud.wheelArch, [.34, .34, .43, .43]);

// the arms follow the wheels: outer ends on the hub after a bump, a droop and body roll; back exactly at rest
const armEnds = m => {
  const mesh = m.getObjectByName('body-near').children.find(o => o.isMesh), p = mesh.geometry.attributes.position;
  return Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i));
};
function checkArms(m, label) {
  const u = m.userData, rest = armEnds(m), w = u.wheels[0], y0 = w.holder.position.y;
  // vertices near wheel 0's upright at rest (the bars' outer ends)
  const hub0 = w.holder.position.clone(), ends = rest.map((v, i) => [v, i]).filter(([v]) => Math.abs(v.x - (hub0.x - .14)) < .03 && Math.abs(v.z - hub0.z) < .04 && Math.abs(v.y - hub0.y) < .14);
  assert(ends.length >= 8, `${label}: arm ends at the front-left upright (${ends.length})`);
  for (const [dy, roll] of [[.06, 0], [-.07, 0], [0, .08]]) {
    w.holder.position.y = y0 + dy; u.bodyPivot.rotation.z = roll; u.linkage.update();
    const now = armEnds(m), inv = new THREE.Matrix4().copy(u.bodyPivot.matrix).invert(), hub = w.holder.position.clone().applyMatrix4(inv);
    for (const [v, i] of ends) {
      const want = v.y - hub0.y + hub.y;                        // same height off the hub as at rest
      // (a rigid hinge tilts the upright by the arm's swing: ~1 cm sideways at full roll)
      const wantX = v.x - hub0.x + hub.x;
      assert(Math.abs(now[i].y - want) < .012 && Math.abs(now[i].x - wantX) < .02, `${label}: arm end follows the hub (dy ${dy}, roll ${roll}): ${now[i].toArray().map(n => n.toFixed(3))} vs x ${wantX.toFixed(3)} y ${want.toFixed(3)}`);
    }
  }
  w.holder.position.y = y0; u.bodyPivot.rotation.z = 0; u.linkage.update();
  const back = armEnds(m); assert(back.every((v, i) => v.distanceTo(rest[i]) < 1e-5), `${label}: arms back at rest`);
}
checkArms(buildCarModel(), 'local');
{
  const { bakeParts } = await import('../game/src/mp/remotes.js');
  const baked = bakeParts(paintedModel('car', {}));
  let calls = 0; baked.traverseVisible(o => { if (o.isMesh) calls++; });
  assert(calls <= 5, `baked remote: body + 4 wheels (${calls} draw calls)`);
  checkArms(baked, 'remote');
}

// the real car: wheels spin, steer and follow the springs through car.js syncMesh, the arms with them, no NaN
{
  const flat = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3, normalAt: (x, z, o = new THREE.Vector3()) => o.set(0, 1, 0),
    waterLevelAt: () => -Infinity, treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7, -1e7, 1e7, 1e7] };
  const car = new Car(flat, { ...TUNING_DEFAULTS }); car.reset(0, 0, 0);
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false }, dt = 1 / 120;
  for (let i = 0; i < 240; i++) { car.step(dt, input); car.interpolate(1); car.syncMesh(dt); }
  const w = car.mesh.userData.wheels;
  w.forEach((g, i) => assert(Math.abs(g.holder.position.y - ud.wheels[i].holder.position.y) < .02, `wheel ${i} settles at the parked stance`));
  const before = armEnds(car.mesh);
  input.throttle = 1; input.steer = .6;
  for (let i = 0; i < 120; i++) { car.step(dt, input); car.interpolate(1); car.syncMesh(dt); }
  assert(w[0].holder.rotation.y !== 0 && w[2].holder.rotation.y === 0, 'front wheels steer, rears do not');
  assert(w.every(g => g.spin.rotation.x !== 0), 'wheels spin');
  assert(car.mesh.userData.bodyPivot.rotation.z !== 0, 'body rolls');
  assert(armEnds(car.mesh).some((v, i) => v.distanceTo(before[i]) > 1e-3), 'arms moved with the suspension / roll');
  car.mesh.traverse(o => { if (o.isMesh) assert(o.geometry.attributes.position.array.every(Number.isFinite)); });
}
console.log('race car model: ok');
