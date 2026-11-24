// Rally integration and reproducible measurements. Run through the heavy gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { applyVehicleType, buildVehicleTypeModel, typeInfo } from '../game/src/vehicletypes.js';
import { paintedModel } from '../game/src/cosmetics.js';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { makeTrack } from '../game/src/track.js';
import { raceTrack, crossedRaceGate } from '../game/src/racecourse.js';
import { makeRaceBarriers } from '../game/src/racebarriers.js';
import { createRaceBot } from './lib/racebot.mjs';

const model = buildVehicleTypeModel('car', 'rally'), ud = model.userData;
assert.equal(model.name, 'car-rally');
assert.equal(ud.damagePanels.length, 2);
assert.equal(ud.wheelArch.length, 4);
assert.equal(ud.lights.head.length, 6);
const counts = {};
for (const name of ['body-near', 'body-far']) {
  let n = 0;
  model.getObjectByName(name).traverse(o => { if (o.isMesh) n += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
  counts[name] = n;
}
let wheels = 0;
for (const w of ud.wheels) w.holder.traverse(o => { if (o.isMesh) wheels += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
assert(counts['body-far'] < counts['body-near']);
const painted = paintedModel('car', {}, 'rally');
for (const [role, color] of Object.entries(typeInfo('car', 'rally').colors)) {
  let found = false;
  painted.traverse(o => { if (o.material?.userData.cosmeticRole === role) { found = true; assert.equal(o.material.color.getHexString(), color.slice(1)); } });
  assert(found, role);
}
console.log(`Rally triangles: near ${counts['body-near'] + wheels}, far ${counts['body-far'] + wheels} (wheels ${wheels})`);
const dt = 1 / 120, input = { throttle: 1, brake: 0, steer: 0, handbrake: false };
const flat = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  normalAt: (x, z, out = new THREE.Vector3()) => out.set(0, 1, 0), waterLevelAt: () => -Infinity,
  treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7, -1e7, 1e7, 1e7] };
const top = new Car(flat, { ...TUNING_DEFAULTS }); applyVehicleType(top, 'rally'); top.reset(-4900, 0, Math.PI / 2);
for (let t = 0; t < 180; t += dt) top.step(dt, input);
console.log(`Rally flat asphalt top: ${(top.vel.length() * 3.6).toFixed(2)} km/h (180 s, x=-4900 eastward)`);
assert(top.vel.length() * 3.6 > 590 && top.vel.length() * 3.6 < 620);

// Real South woods trail course, identical cautious bot and 60 km/h cap for both cars.
// Uses the normal race barriers and ordered gate crossings; never corrects vehicle pose or velocity.
const manifest = JSON.parse(fs.readFileSync('game/assets/world.json')), world = makeWorld(manifest);
const bytes = async f => { const b = fs.readFileSync(`game/assets/tiles/0_0/${f}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
world.add(makeTileData(manifest, 0, 0, await readTileData(bytes, manifest.packed)));
const race = JSON.parse(fs.readFileSync('game/assets/challenges.json')).find(r => r.id === 'bike-south-loop');
const route = raceTrack(race.track, race.gates.at(-1));
for (const type of ['rally', 'suv']) {
  const track = makeTrack(route), bot = createRaceBot({ ...race, vehicle: 'car' }, route, track);
  world.setRaceBarriers(makeRaceBarriers(route, world));
  const car = new Car(world, { ...TUNING_DEFAULTS }); applyVehicleType(car, type);
  car.reset(race.start.x, race.start.z, race.start.yaw);
  let next = 1, time = 0, loose = 0, flips = 0, wasUp = true;
  const previous = car.pos.clone(), up = new THREE.Vector3();
  while (time < 700 && next < race.gates.length) {
    bot.drive(car, input, dt);
    if (car.vel.length() * 3.6 > 60) { input.throttle = 0; input.brake = 1; }
    car.step(dt, input); time += dt;
    assert([...car.pos, ...car.vel, ...car.quat].every(Number.isFinite));
    up.set(0, 1, 0).applyQuaternion(car.quat); if (wasUp && up.y < 0) flips++; wasUp = up.y >= 0;
    if ([0, 1, 2, 4].includes(car.surface)) loose++;
    if (crossedRaceGate(race.gates[next], previous, car.pos, next === race.gates.length - 1 ? track : null)) next++;
    previous.copy(car.pos);
  }
  console.log(`${type}: South woods ${race.length} m course ${time.toFixed(2)} s, gates ${next - 1}/${race.gates.length - 1}, loose ${(loose * dt / time * 100).toFixed(1)}%, flips ${flips}, backups ${bot.backs}`);
  assert.equal(next, race.gates.length, `${type}: trail course finished`);
  assert.equal(flips, 0);
}
world.setRaceBarriers(null);
console.log('PASS Rally integration, factory paint, top speed and real trail comparison');
