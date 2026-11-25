// Tank integration and reproducible measurements. Run through the heavy gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { applyVehicleType, buildVehicleTypeModel, typeInfo } from '../game/src/vehicletypes.js';
import { paintedModel } from '../game/src/cosmetics.js';
import { createVehicleLightLenses } from '../game/src/lights.js';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { makeTrack } from '../game/src/track.js';
import { raceTrack, crossedRaceGate } from '../game/src/racecourse.js';
import { makeRaceBarriers } from '../game/src/racebarriers.js';
import { createRaceBot } from './lib/racebot.mjs';

const model = buildVehicleTypeModel('car', 'tank'), ud = model.userData;
assert.equal(model.name, 'car-tank');
assert(ud.turret?.isGroup && ud.barrel?.isGroup && ud.muzzle?.isObject3D);
assert.equal(ud.barrel.parent, ud.turret); assert.equal(ud.muzzle.parent, ud.barrel);
const tip = ud.muzzle.getWorldPosition(new THREE.Vector3());
ud.turret.rotation.y = .5; ud.barrel.rotation.x = -.2;
assert(ud.muzzle.getWorldPosition(new THREE.Vector3()).distanceTo(tip) > 1);
ud.turret.rotation.y = 0; ud.barrel.rotation.x = 0;
assert.equal(ud.wheelArch.length, 4);
assert.equal(ud.lights.head.length, 2);
const counts = {};
for (const name of ['body-near', 'body-far']) {
  let n = 0;
  model.getObjectByName(name).traverse(o => { if (o.isMesh) n += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
  counts[name] = n;
}
let wheels = 0;
for (const w of ud.wheels) w.holder.traverse(o => { if (o.isMesh) wheels += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
assert(counts['body-far'] < counts['body-near']);
const painted = paintedModel('car', {}, 'tank');
for (const [role, color] of Object.entries(typeInfo('car', 'tank').colors)) {
  let found = false;
  painted.traverse(o => { if (o.material?.userData.cosmeticRole === role) { found = true; assert.equal(o.material.color.getHexString(), color.slice(1)); } });
  assert(found, role);
}
console.log(`Tank triangles: near ${counts['body-near'] + wheels}, far ${counts['body-far'] + wheels} (wheels ${wheels})`);
// The live lenses must fit the small lamp faces and remain clear of the towing hooks.
const skin = [];
model.traverseVisible(o => { if (o.isMesh) skin.push(o); });
const lights = createVehicleLightLenses(model, 'car'); lights.update({ on: true }); model.updateMatrixWorld(true);
const ray = new THREE.Raycaster(), sample = new THREE.Vector3(), direction = new THREE.Vector3();
lights.group.traverse(o => {
  if (!/^vehicle-light-(head|tail)$/.test(o.name)) return;
  const position = o.geometry.attributes.position, normal = o.geometry.attributes.normal;
  direction.fromBufferAttribute(normal, 0).transformDirection(o.matrixWorld).negate();
  for (let i = 0; i < position.count; i++) {
    sample.fromBufferAttribute(position, i).applyMatrix4(o.matrixWorld);
    ray.set(sample.clone().addScaledVector(direction, -.4), direction); ray.far = .5;
    assert.equal(ray.intersectObjects([...skin, o], false)[0]?.object, o, 'lit lens visible');
    const hit = ray.intersectObjects(skin, false)[0];
    assert(hit && hit.distance > .398 && hit.distance < .417, 'lit lens sits on the drawn lamp');
    const color = new THREE.Color().fromBufferAttribute(hit.object.geometry.attributes.color, hit.face.a).getHexString();
    assert.equal(color, o.name.endsWith('head') ? 'fff1cf' : 'a3221c', 'lamp face behind every lens sample');
  }
});
lights.dispose();
const dt = 1 / 120, input = { throttle: 1, brake: 0, steer: 0, handbrake: false };
const flat = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7, -1e7, 1e7, 1e7] };
const top = new Car(flat, { ...TUNING_DEFAULTS }); applyVehicleType(top, 'tank'); top.reset(-4900, 0, Math.PI / 2);
for (let t = 0; t < 180; t += dt) top.step(dt, input);
console.log(`Tank flat asphalt top: ${(top.vel.length() * 3.6).toFixed(2)} km/h (180 s, x=-4900 eastward)`);
assert(top.vel.length() * 3.6 > 68 && top.vel.length() * 3.6 < 72);

// High track traction still obeys the shared bare-terrain slope rule.
for (const degrees of [45, 50, 55]) {
  const slope = Math.tan(degrees * Math.PI / 180);
  const height = (_x, z) => z * slope;
  const normal = (_x, _z, out = new THREE.Vector3()) => out.set(0, 1, -slope).normalize();
  const hill = { ...flat, heightAt: height, terrainAt: height, groundAt: height, surfaceAt: () => 0,
    normalAt: normal, terrainNormalAt: normal };
  const tank = new Car(hill, { ...TUNING_DEFAULTS }); applyVehicleType(tank, 'tank'); tank.reset(0, 0, 0);
  for (let t = 0; t < 20; t += dt) tank.step(dt, input);
  assert([...tank.pos, ...tank.vel].every(Number.isFinite));
  assert(tank.pos.z < 0, `${degrees}° bare slope cannot be climbed`);
  console.log(`Tank ${degrees}° bare slope: slides ${(-tank.pos.z).toFixed(1)} m downhill`);
}

// Real South woods trail course with a cautious bot and a 30 km/h cap.
// Uses the normal race barriers and ordered gate crossings; never corrects vehicle pose or velocity.
const manifest = JSON.parse(fs.readFileSync('game/assets/world.json')), world = makeWorld(manifest);
const bytes = async f => { const b = fs.readFileSync(`game/assets/tiles/0_0/${f}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
world.add(makeTileData(manifest, 0, 0, await readTileData(bytes, manifest.packed)));
const race = JSON.parse(fs.readFileSync('game/assets/challenges.json')).find(r => r.id === 'bike-south-loop');
const route = raceTrack(race.track, race.gates.at(-1));
for (const type of ['tank']) {
  const track = makeTrack(route), bot = createRaceBot({ ...race, vehicle: 'car' }, route, track);
  world.setRaceBarriers(makeRaceBarriers(route, world));
  const car = new Car(world, { ...TUNING_DEFAULTS }); applyVehicleType(car, type);
  car.reset(race.start.x, race.start.z, race.start.yaw);
  let next = 1, time = 0, loose = 0, flips = 0, wasUp = true;
  const previous = car.pos.clone(), up = new THREE.Vector3();
  while (time < 180 && next < race.gates.length) {
    bot.drive(car, input, dt);
    if (car.vel.length() * 3.6 > 30) { input.throttle = 0; input.brake = 1; }
    car.step(dt, input); time += dt;
    assert([...car.pos, ...car.vel, ...car.quat].every(Number.isFinite));
    up.set(0, 1, 0).applyQuaternion(car.quat); if (wasUp && up.y < 0) flips++; wasUp = up.y >= 0;
    if ([0, 1, 2, 4].includes(car.surface)) loose++;
    if (crossedRaceGate(race.gates[next], previous, car.pos, next === race.gates.length - 1 ? track : null)) next++;
    previous.copy(car.pos);
  }
  console.log(`${type}: South woods ${race.length} m course ${time.toFixed(2)} s, gates ${next - 1}/${race.gates.length - 1}, loose ${(loose * dt / time * 100).toFixed(1)}%, flips ${flips}, backups ${bot.backs}`);
  assert(next >= 4, 'Tank makes progress through the campus trail');
  assert(loose * dt > 60, 'At least a minute on loose trail surfaces');
  assert.equal(flips, 0);
}
world.setRaceBarriers(null);
// Straight tracks and all rollers animate through the existing local/remote syncMesh hook.
top.interpolate(1); top.syncMesh(dt);
assert(ud.wheels.every(w => w.spin.isGroup));
assert(top.mesh.userData.wheels.every(w => w.holder.rotation.y === 0 && Math.abs(w.spin.rotation.x) > 1));
assert.equal(top.cam, typeInfo('car', 'tank').cam, 'Tank uses its hull-sized chase camera');
applyVehicleType(top, 'race');
assert.equal(top.cam, undefined, 'switching away restores the normal car camera');
applyVehicleType(top, 'tank');
assert.equal(top.cam, typeInfo('car', 'tank').cam, 'cached Tank restores its camera');
console.log('PASS Tank model hooks, factory paint, top speed, track animation and campus trail');
