// Bare-terrain slope/face regression. Real tiles are loaded one at a time; run through the heavy gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { Bike, BIKE } from '../game/src/bike.js';
import { VEHICLE_TYPES, applyVehicleType } from '../game/src/vehicletypes.js';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { terrainGrip, terrainHold, terrainWheel } from '../game/src/steepterrain.js';

const DT = 1 / 120, up = new THREE.Vector3(), n = new THREE.Vector3();
const input = throttle => ({ throttle, brake: 0, steer: 0, handbrake: false, lean: false });
const types = Object.entries(VEHICLE_TYPES).filter(([k]) => k !== 'jet').flatMap(([kind, types]) => types.map(t => [kind, t.id])).filter(([, id]) => !process.env.ONLY || process.env.ONLY.split(',').includes(id));
const fails = [];
let runs = 0;
function check(ok, message) { if (!ok) fails.push(message); }
function make(kind, id, world) {
  const v = kind === 'car' ? new Car(world, { ...TUNING_DEFAULTS }) : new Bike(world, { ...BIKE });
  applyVehicleType(v, id); return v;
}
function simulate(v, seconds, throttle = 1, site = null) {
  let maxY = v.pos.y, maxRise = 0, minUp = 1, hits = 0, firstHit = null;
  for (let i = 0; i < seconds / DT; i++) {
    v.step(DT, input(throttle));
    // Real glancing impacts: observe the strike and 0.25 s of scraping, then stop before
    // entering unsurveyed terrain along the bank. Synthetic faces exercise sustained scraping.
    if (site && hits && (Math.abs((v.pos.x - site.x) * site.dz - (v.pos.z - site.z) * site.dx) > 3 ||
      (site.glancing && i * DT - firstHit >= 0.25))) break;
    assert([...v.pos, ...v.vel, ...v.quat, ...v.ang].every(Number.isFinite), `${v.type}: NaN`);
    minUp = Math.min(minUp, up.set(0, 1, 0).applyQuaternion(v.quat).y);
    maxY = Math.max(maxY, v.pos.y); hits += v.hit > 0;
    if (v.hit > 0 && firstHit === null) firstHit = i * DT;
    if (site) {
      // A bank's foot can slope along its length. Measure above that local foot, not
      // above the start of the road: uphill scraping along a curved bank is not climbing it.
      const side = (v.pos.x - site.x) * site.dz - (v.pos.z - site.z) * site.dx;
      let x = site.x + site.dz * side, z = site.z - site.dx * side;
      for (let d = 0; d < 3; d += 0.1) {
        if (!v.world.terrainNormalAt(x, z, n, v.pos.y) || n.y >= Math.cos(55 * Math.PI / 180)) break;
        x -= site.dx * 0.1; z -= site.dz * 0.1;
      }
      maxRise = Math.max(maxRise, v.pos.y - v.world.heightAt(x, z) - site.rest);
    }
    if (process.env.TRACE && i % 12 === 0) console.log('trace', JSON.stringify([v.type, (i * DT).toFixed(2), v.pos.toArray().map(x => x.toFixed(2)), v.vel.toArray().map(x => x.toFixed(2)), v.wheels.map(w => [w.terrainY?.toFixed(2), w.contact]), v.hit]));
  }
  runs++;
  check(minUp > 0, `${v.type}: flipped`);
  return { maxY, maxRise, hits };
}
function slopeWorld(degrees, face = false, designed = false, surface = 0) {
  const grade = Math.tan(degrees * Math.PI / 180);
  const height = (x, z) => face ? Math.max(0, Math.min(12, z * grade)) : z * grade;
  const W = { heightAt: height, terrainAt: height, groundAt: height, surfaceAt: () => surface,
    waterLevelAt: () => -Infinity, treesNear() {}, buildingsNear: () => [], loadedAt: () => true,
    extent: [-1e6, -1e6, 1e6, 1e6] };
  W.normalAt = (x, z, out) => out.set(0, 1, face && (z < 0 || z * grade > 12) ? 0 : -grade).normalize();
  W.terrainNormalAt = designed ? () => null : W.normalAt;
  return W;
}
if (!process.argv.includes('--real')) for (const [kind, id] of types) {
  for (const degrees of [25, 40, 45, 50, 55]) for (const sideways of [false, true]) {
    const W = slopeWorld(degrees), v = make(kind, id, W);
    v.reset(0, 0, sideways ? Math.PI / 2 : 0);
    // Start supported and aligned with the hill, without a reset/drop transient.
    if (kind === 'car') {
      v.quat.setFromEuler(new THREE.Euler(-degrees * Math.PI / 180, 0, 0));
      if (sideways) v.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));
      v.pos.y = 0.65;
    }
    const z = v.pos.z;
    simulate(v, 3, sideways ? 0 : 1);
    check(degrees === 25 ? (sideways || v.pos.z > z + 0.5) : v.pos.z < z - 1,
      `${id} ${degrees}° ${sideways ? 'side hold' : 'full throttle'}: z ${v.pos.z.toFixed(2)}`);
  }
  let worst = 0;
  for (const degrees of [56, 65, 80]) for (const kmh of [20, 60, 150]) for (const angle of [-30, 0, 30]) {
    const W = slopeWorld(degrees, true), v = make(kind, id, W), yaw = angle * Math.PI / 180;
    v.reset(0, -7, yaw); simulate(v, 0.7, 0);
    const y = v.pos.y;
    v.vel.set(Math.sin(yaw) * kmh / 3.6, 0, Math.cos(yaw) * kmh / 3.6);
    const r = simulate(v, 3);
    worst = Math.max(worst, r.maxY - y);
    check(r.maxY - y < 0.5, `${id} face ${degrees}° ${kmh}/${angle}: rose ${(r.maxY - y).toFixed(3)} m`);
    check(v.pos.z < 0, `${id} crossed face ${degrees}° ${kmh}/${angle}: z ${v.pos.z}`);
  }
  console.log(`${id}: 25° climb, 40–55° slide, 27 face impacts; max rise ${worst.toFixed(3)} m`);
}
assert.equal(terrainGrip(Math.cos(Math.PI / 6), 0), 1);
assert.equal(terrainGrip(Math.cos(Math.PI / 4), 0), 0);
assert(terrainGrip(Math.cos(Math.PI / 4), 3) > 0);
assert(!terrainHold(Math.cos(36 * Math.PI / 180)));

// Query exclusions are geometric and height-aware, not surface-colour shortcuts.
{
  const m = { tile: 2000, hstep: 2, extent: [-1000, -1000, 1000, 1000], tiles: [[0, 0]], spawn: [0, 0] };
  const W = makeWorld(m), ground = (x, z) => z * 2;
  let deck = -Infinity;
  W.add({ tx: 0, tz: 0, x0: -1000, z0: -1000, terrainAt: ground,
    overlayAt: (x, z, y = Infinity) => y >= deck - 3 ? deck : -Infinity,
    heightAt: (x, z, y = Infinity) => Math.max(ground(x, z), y >= deck - 3 ? deck : -Infinity),
    surfaceAt: () => 3, waterLevelAt: () => -Infinity, buildings: [], treesNear() {} });
  assert(W.terrainNormalAt(0, 0, n, 1), 'asphalt colour alone is still terrain');
  deck = 10;
  assert(W.terrainNormalAt(0, 0, n, 1), 'bank underneath bridge still solid');
  assert.equal(W.terrainNormalAt(0, 0, n, 10), null, 'deck exempt');
  deck = 0;
  assert.equal(W.terrainNormalAt(0, 0, n, 1), null, 'road exempt');
  deck = -Infinity;
  W.setRamps([{ x: 0, z: 0, yaw: 0, w: 8 }]);
  assert.equal(W.terrainNormalAt(0, 3, n, 8), null, 'ramp exempt');
  W.setRamps([]);
  W.setPlacedPieces({ sample: () => ({ h: 20, gx: 0, gz: 2, surface: 3 }) });
  assert.equal(W.terrainNormalAt(0, 0, n, 20), null, 'builder surface exempt');
  const wheel = { contact: true, terrainHeight: 0 };
  assert(terrainWheel(slopeWorld(40), wheel, new THREE.Vector3(0, 1, 0), n, 0.3, 0.4), 'upward spring step limited by travel');
  assert(!terrainWheel(slopeWorld(40, false, true), { contact: true, terrainHeight: 0 }, new THREE.Vector3(0, 1, 0), n, 0.3, 0.4), 'designed spring step unchanged');
}
// At ordinary hill angles and on authored slopes, enabling the terrain guard preserves
// the old trajectory exactly (same world with the bare-ground query disabled).
if (!process.argv.includes('--real')) for (const [kind, id] of types) for (const degrees of [0, 25, 65]) {
  const designed = degrees === 65, W = slopeWorld(degrees, false, designed);
  const a = make(kind, id, W), b = make(kind, id, { ...W, terrainNormalAt: () => null });
  a.reset(0, 0, 0); b.reset(0, 0, 0);
  for (let i = 0; i < 120; i++) {
    a.step(DT, input(1)); b.step(DT, input(1));
    assert(a.pos.distanceTo(b.pos) < 1e-8 && a.vel.distanceTo(b.vel) < 1e-8, `${id}: ${degrees}° trajectory changed`);
  }
}

if (!process.argv.includes('--unit')) {
  const A = process.env.YR_ASSETS || 'game/assets';
  const manifest = JSON.parse(fs.readFileSync(`${A}/world.json`));
  let roadSites = 0, cliffSites = 0;
  // These road-cutting areas come from body_lift_test's all-tile asphalt edge scan.
  for (const [tx, tz] of [[-2, 3], [0, -1], [3, 1], [-1, 8], [5, -14], [14, -6], [9, -4], [-5, 3], [11, 1], [4, 0]]) {
    const W = makeWorld(manifest);
    const bytes = async f => { const b = fs.readFileSync(`${A}/tiles/${tx}_${tz}/${f}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
    const td = makeTileData(manifest, tx, tz, await readTileData(bytes, manifest.packed)); W.add(td);
    // Scan actual triangle slopes, then walk downhill to the foot. Keep clear, wide faces
    // with a flat approach so height gain measures the collision, not the approach hill.
    const sites = [], hills = new Map(); let steep = 0, high = 0;
    for (let x = tx * 2000 - 950; x < tx * 2000 + 950; x += 4) for (let z = tz * 2000 - 950; z < tz * 2000 + 950; z += 4) {
      if (!W.terrainNormalAt(x, z, n, W.terrainAt(x, z) + 1)) continue;
      if (tx === -1 && tz === 8) {
        const angle = Math.acos(n.y) * 180 / Math.PI;
        for (const target of [25, 42, 50]) if (!hills.has(target) && Math.abs(angle - target) < 1) {
          const normal = n.clone(), probe = new THREE.Vector3();
          let planar = true;
          for (const dx of [-2, 0, 2]) for (const dz of [-2, 0, 2]) {
            if (!W.terrainNormalAt(x + dx, z + dz, probe, W.terrainAt(x + dx, z + dz) + 1) ||
              Math.abs(Math.acos(probe.y) * 180 / Math.PI - target) > 3 || probe.dot(normal) < 0.99 ||
              W.waterLevelAt(x + dx, z + dz) > -Infinity) planar = false;
          }
          if (planar) hills.set(target, { x, z, normal });
        }
      }
      if (n.y > Math.cos(56 * Math.PI / 180)) continue;
      steep++;
      const L = Math.hypot(n.x, n.z), dx = -n.x / L, dz = -n.z / L;
      let fx = x, fz = z;
      for (let d = 0; d < 15; d += 0.1) {
        fx = x - dx * d; fz = z - dz * d;
        if (!W.terrainNormalAt(fx, fz, n, W.heightAt(fx, fz) + 1) || n.y >= Math.cos(55 * Math.PI / 180)) break;
      }
      const h = W.heightAt(fx, fz);
      if (W.terrainAt(fx + dx * 3, fz + dz * 3) - h < 2) continue;
      high++;
      if (sites.some(s => Math.hypot(s.x - fx, s.z - fz) < 100)) continue;
      let clear = true;
      for (const side of [-3, 0, 3]) for (const back of [1, 4, 8]) {
        const px = fx - dx * back + dz * side, pz = fz - dz * back - dx * side;
        if (Math.abs(W.heightAt(px, pz) - h) > 0.6 || W.waterLevelAt(px, pz) > -Infinity || W.buildingsNear(px, pz, 5).some(b => b.pts.some(([bx, bz]) => Math.hypot(bx - px, bz - pz) < 6))) clear = false;
      }
      if (clear) sites.push({ x: fx, z: fz, dx, dz, h, road: W.surfaceAt(fx - dx * 3, fz - dz * 3) === 3 });
    }
    if (tx === -1 && tz === 8 && !process.env.TRACE && !process.argv.includes('--scan')) {
      assert.equal(hills.size, 3, `real 25°, 42° and 50° hills found: ${[...hills.keys()]}`);
      const terrain = Object.assign(Object.create(W), { treesNear() {}, buildingsNear: () => [] });
      for (const [angle, h] of hills) {
        const f = new THREE.Vector3(-h.normal.x, 0, -h.normal.z).normalize(), yaw = Math.atan2(f.x, f.z);
        const along = f.clone().addScaledVector(h.normal, -f.dot(h.normal)).normalize();
        const right = new THREE.Vector3().crossVectors(h.normal, along);
        for (const [kind, id] of types) {
          const v = make(kind, id, terrain); v.reset(h.x, h.z, yaw);
          if (kind === 'car') v.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, h.normal, along));
          const rest = kind === 'bike' ? 0.56 : v.t.restLength + (v.typePhysics?.radius ?? 0.38) - v.wheels[0].mount.y -
            (v.typePhysics?.mass ?? 900) * v.t.gravity / (4 * v.t.springK);
          v.pos.y = W.terrainAt(h.x, h.z) + rest / h.normal.y;
          simulate(v, 1);
          const moved = (v.pos.x - h.x) * f.x + (v.pos.z - h.z) * f.z;
          check(angle === 25 ? moved > 0.02 : moved < -0.1, `${id} real ${angle}° hill: uphill travel ${moved.toFixed(3)} m`);
        }
        console.log(`real ${angle}° hill ${h.x},${h.z}: all types climb/slide checked`);
      }
    }
    const picked = [sites.find(s => s.road), sites.find(s => !s.road)].filter(Boolean);
    for (const s of picked) { if (s.road) roadSites++; else cliffSites++; }
    console.log(`tile ${tx},${tz}: steep ${steep}, high ${high}, ${sites.length} usable banks/cliffs; picked ${JSON.stringify(picked)}`);
    if (process.argv.includes('--scan')) continue;
    for (const s of picked) {
      let worst = 0;
      if (process.env.TRACE) { for (let d = -4; d <= 8; d += 0.5) { const x = s.x + s.dx * d, z = s.z + s.dz * d; const raw = W.terrainNormalAt(x,z,n,W.heightAt(x,z)+1); console.log('profile', d, (W.terrainAt(x,z)-s.h).toFixed(2), raw ? (Math.acos(n.y)*180/Math.PI).toFixed(1) : 'designed'); } }
      // Remove trees from the approach only: this test must reach the bank rather than hit a trunk.
      const terrain = Object.assign(Object.create(W), { treesNear() {} });
      for (const [kind, id] of types) for (const kmh of [20, 60, 150]) for (const angle of [-30, 0, 30]) {
        if (process.env.TRACE && `${id}/${kmh}/${angle}` !== process.env.TRACE) continue;
        const yaw = Math.atan2(s.dx, s.dz) + angle * Math.PI / 180, dx = Math.sin(yaw), dz = Math.cos(yaw);
        const v = make(kind, id, terrain); v.reset(s.x - dx * 7, s.z - dz * 7, yaw);
        simulate(v, 0.7, 0); const rest = v.pos.y - W.heightAt(v.pos.x, v.pos.z);
        v.vel.set(dx * kmh / 3.6, 0, dz * kmh / 3.6);
        const r = simulate(v, 2, 1, { ...s, rest, glancing: angle !== 0 });
        check(r.hits > 0, `${id} real ${tx},${tz} ${kmh}/${angle}: missed face`);
        worst = Math.max(worst, r.maxRise);
        check(r.maxRise < 0.5, `${id} real ${tx},${tz} ${s.x.toFixed(1)},${s.z.toFixed(1)} ${kmh}/${angle}: rose ${r.maxRise.toFixed(3)} m`);
      }
      console.log(`  ${s.road ? 'road bank' : 'cliff'} ${s.x.toFixed(1)},${s.z.toFixed(1)} max rise ${worst.toFixed(3)} m`);
    }
  }
  assert(roadSites >= 1 && cliffSites >= 2, 'real coverage must include a road cutting and multiple cliffs');
}
console.log(`${runs} simulations; ${fails.length} failures`);
if (fails.length) { console.error(fails.slice(0, 60).join('\n')); process.exitCode = 1; }
