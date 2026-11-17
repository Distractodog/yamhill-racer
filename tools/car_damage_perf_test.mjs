// distractodog focused CPU benchmark. Real model + building collision paths, independent
// of world streaming. Browser imports this same workload; rendering is supplied by its fixture.
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { CarDamage, carDamageCacheInfo } from '../game/src/cardamage.js';
import { applyVehicleType, VEHICLE_TYPES } from '../game/src/vehicletypes.js';
import { createVehicleLightLenses } from '../game/src/lights.js';
const wall = { pts: [[-20, 0], [20, 0], [20, 20], [-20, 20]], top: 10, h: 10 };
const world = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
  normalAt: (_x, _z, n = new THREE.Vector3()) => n.set(0, 1, 0), waterLevelAt: () => -Infinity,
  buildingsNear: () => [wall], treesNear() {}, loadedAt: () => true, rampAt: () => 0,
  extent: [-10000, -10000, 10000, 10000], spawn: [0, 0] };
export function makeCar(type, Damage = CarDamage) {
  const c = new Car(world, { ...TUNING_DEFAULTS }); applyVehicleType(c, type);
  c.damage = new Damage(c); c.reset(0, -10, 0); createVehicleLightLenses(c.mesh);
  c.savePrev(); c.interpolate(1); c.syncMesh(1 / 60); return c;
}
export function impact(c, speed = 45, yaw = 0, x = 0) {
  c.damage.step(.3);
  c.pos.set(x, .75, -1.45 * (c.typePhysics?.width ?? 1));
  c.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw); c.vel.set(0, 0, speed);
  c.collideBuildings();
}
function dispose(c) {
  const geometries = new Set(), materials = new Set();
  for (const model of new Set([c.mesh, ...c._typeModels.values()])) model.traverse(o => {
    if (o.geometry) geometries.add(o.geometry);
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) materials.add(m);
  });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
}
export function stats(values) {
  const a = [...values].sort((a, b) => a - b);
  return { n: a.length, median: a[Math.floor(a.length / 2)], p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) };
}
export async function benchmark({ Damage = CarDamage, samples = 100, coldSamples = 12, types = VEHICLE_TYPES.car.map(t => t.id), render = () => {}, yieldFrame = async () => {} } = {}) {
  const report = {};
  for (const id of types) {
    const cold = [], coldSyncRender = [], prepare = [], preparedFirst = [];
    for (let i = 0; i < coldSamples; i++) {
      const c = makeCar(id, Damage); render(c); impact(c);
      let t = performance.now(); c.damage.update(); cold.push(performance.now() - t);
      t = performance.now(); c.syncMesh(1 / 60); render(c); coldSyncRender.push(performance.now() - t); dispose(c);
      const ready = makeCar(id, Damage); render(ready);
      t = performance.now(); ready.damage.prepare?.(); prepare.push(performance.now() - t);
      impact(ready); t = performance.now(); ready.damage.update(); preparedFirst.push(performance.now() - t); dispose(ready);
      await yieldFrame();
    }
    const c = makeCar(id, Damage); render(c); const result = { cold: stats(cold), coldSyncRender: stats(coldSyncRender), prepare: stats(prepare), preparedFirst: stats(preparedFirst) };
    for (const scenario of ['impact', 'repeated', 'maxSites', 'repair']) {
      const times = [], syncRender = [];
      for (let i = -12; i < samples; i++) {
        c.damage.repair();
        const pivot = c.mesh.userData.bodyPivot;
        pivot.rotation.set(.04 * Math.sin(i), 0, .07 * Math.cos(i)); pivot.position.y = .06 + .02 * Math.sin(i);
        c.latAcc = 12 * Math.cos(i); c.lonAcc = 8 * Math.sin(i);
        if (scenario === 'maxSites') {
          // Supplementary bounded-state stress, explicit metadata (not a driving claim).
          for (let k = 0; k < 24; k++) {
            const a = k * Math.PI * 2 / 24;
            c.damage.impact(c.pos.x + Math.sin(a) * 3, c.pos.y + (k % 3) * .8, c.pos.z + Math.cos(a) * 3,
              -Math.sin(a), 0, -Math.cos(a), 45, 'perf-stress'); c.damage.step(.3);
          }
          if (c.damage.sites.length !== 24) throw Error(`distractodog ${id}: expected 24 sites, got ${c.damage.sites.length}`);
        } else {
          impact(c);
          if (scenario !== 'impact') {
            c.damage.update();
            for (const yaw of [0, 0, Math.PI / 2, -Math.PI / 2, Math.PI]) impact(c, 45, yaw);
          }
        }
        if (scenario === 'repair') c.damage.update();
        let t = performance.now();
        if (scenario === 'repair') c.damage.repair(); else c.damage.update();
        const elapsed = performance.now() - t;
        t = performance.now(); c.savePrev(); c.interpolate(1); c.syncMesh(1 / 60); render(c);
        if (i >= 0) { times.push(elapsed); syncRender.push(performance.now() - t); }
        if (i % 10 === 0) await yieldFrame();
      }
      result[scenario] = stats(times); result[`${scenario}SyncRender`] = stats(syncRender);
    }
    const idle = []; for (let i = 0; i < 100; i++) { const t = performance.now(); c.damage.update(); idle.push(performance.now() - t); }
    result.unchanged = stats(idle); result.cache = carDamageCacheInfo(c.mesh); report[id] = result; dispose(c); await yieldFrame();
  }
  return report;
}
// Compare the optimized buffers to a frozen pre-optimization module supplied by the
// caller. No production baseline copy or timing threshold tied to this machine is shipped.
export function verifyPreservation(Reference, prepared = false) {
  let values = 0, maxPosition = 0, maxNormal = 0;
  for (const { id } of VEHICLE_TYPES.car) {
    const pair = [makeCar(id, Reference), makeCar(id)];
    if (prepared) pair[1].damage.prepare();
    for (let stage = 0; stage < 12; stage++) {
      for (const c of pair) {
        c.mesh.userData.bodyPivot.rotation.set(.04 * Math.sin(stage), 0, .07 * Math.cos(stage));
        c.mesh.userData.bodyPivot.position.y = .08 * Math.sin(stage);
        for (const w of c.mesh.userData.wheels) w.holder.position.y = w.restY + .03 * Math.cos(stage);
        if (stage === 11) c.damage.repair();
        else { impact(c, stage % 2 ? 45 : 15, stage * .7); c.damage.update(); }
      }
      const meshes = pair.map(c => { const a = []; c.mesh.traverse(o => { if (o.isMesh) a.push(o); }); return a; });
      for (let i = 0; i < meshes[0].length; i++) for (const key of ['position', 'normal']) {
        const a = meshes[0][i].geometry.attributes[key]?.array, b = meshes[1][i].geometry.attributes[key]?.array;
        if (!a) continue;
        if (a.length !== b.length) throw Error('distractodog geometry length changed');
        for (let j = 0; j < a.length; j++) {
          const error = Math.abs(a[j] - b[j]); values++;
          if (key === 'position') maxPosition = Math.max(maxPosition, error); else maxNormal = Math.max(maxNormal, error);
          if (!Number.isFinite(a[j]) || !Number.isFinite(b[j]) || a[j] !== b[j]) throw Error(`distractodog ${id}/${stage}/${key}/${i}/${j}: error ${error}`);
        }
      }
    }
    pair.forEach(dispose);
  }
  return { values, maxPosition, maxNormal };
}
if (typeof process !== 'undefined' && process.argv?.[1]?.endsWith('car_damage_perf_test.mjs')) {
  const { writeFileSync } = await import('node:fs'), { pathToFileURL } = await import('node:url');
  const option = (key, fallback) => { const i = process.argv.indexOf(key); return i < 0 ? fallback : process.argv[i + 1]; };
  const reference = option('--reference', null), out = option('--out', '/tmp/distractodog-car-damage-perf.json');
  const Damage = reference ? (await import(pathToFileURL(reference))).CarDamage : CarDamage;
  if (process.argv.includes('--verify')) {
    if (!reference) throw Error('--verify needs --reference to the frozen baseline');
    console.log('distractodog buffer parity', verifyPreservation(Damage));
  }
  const report = await benchmark({ Damage, samples: Number(option('--samples', 100)), coldSamples: Number(option('--cold', 12)) });
  writeFileSync(out, JSON.stringify({ author: 'distractodog', reference, report }, null, 2));
  console.table(Object.entries(report).map(([type, r]) => Object.fromEntries([['type', type], ...['cold', 'prepare', 'preparedFirst', 'impact', 'repeated', 'maxSites', 'repair'].map(k => [k + 'P95', r[k].p95.toFixed(3)])])));
  console.log(`distractodog timings (ms), ${out}; cold includes lazy preparation, sync/render reported separately; Node has no GPU`);
}
