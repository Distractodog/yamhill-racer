// distractodog quick tests: timing guardrails and instrumentation, no browser/port/tiles.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { compareFrames, dentLimits, distribution, installDentTiming } from './lib/cardamageperf.mjs';
const limits = dentLimits();
const frame = (cpu, before = 16, after = 16) => ({ stepMs: .1, syncMs: cpu - .2, damageMs: cpu / 2, renderMs: .1, intervalBeforeMs: before, intervalAfterMs: after });
assert.deepEqual(distribution([4, 1, 3, 2]), { count: 4, median: 2, p95: 4, worst: 4 });
assert.throws(() => distribution([])); assert.throws(() => distribution([NaN]));
assert.throws(() => dentLimits('{"unknown":2}')); assert.throws(() => dentLimits('{"impactCpuP95AddedMs":-1}'));
assert(compareFrames([frame(1)], [frame(2)], 'impact', limits).pass);
const cpuFail = compareFrames([frame(1)], [frame(6)], 'impact', limits);
assert(!cpuFail.pass); assert(Math.abs(cpuFail.added.cpuP95Ms - 5) < 1e-9);
// Deformation stalls happen before render; GPU/driver stalls may appear after it.
for (const f of [frame(1, 60, 16), frame(1, 16, 60)]) {
  const result = compareFrames([frame(1)], [f], 'impact', limits);
  assert(!result.pass); assert.equal(result.enabled.frameMs.worst, 60); assert.equal(result.added.slow33Points, 100);
}
assert(!compareFrames([frame(1)], [frame(4)], 'moving', limits).pass);
assert(compareFrames([frame(1)], [frame(6)], 'impact', dentLimits('{"impactCpuP95AddedMs":5}')).pass);

const wall = { pts: [[-20, 0], [20, 0], [20, 20], [-20, 20]], top: 10, h: 10 };
function run(mode) {
  const W = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3,
    normalAt: (_x, _z, n = new THREE.Vector3()) => n.set(0, 1, 0), waterLevelAt: () => -Infinity,
    buildingsNear: () => [wall], treesNear() {}, loadedAt: () => true, rampAt: () => 0,
    extent: [-10000, -10000, 10000, 10000], spawn: [0, 0] };
  const c = new Car(W, { ...TUNING_DEFAULTS }); c.reset(0, -1.6, 0); c.vel.set(0, 0, 45);
  const originals = [c.step, c.recordImpact, c.syncMesh, c.damage.update];
  globalThis.game = { vehicles: { current: c } };
  globalThis.dentShots = { mode, kind: 'impact', running: true, measure: true, contacts: [], steps: 0, frame: null };
  installDentTiming(); const s = globalThis.dentShots;
  for (let i = 0; i < 601 && s.running; i++) { c.savePrev(); c.step(1 / 120); c.interpolate(1); c.syncMesh(1 / 60); }
  assert(s.finished && s.contacts.length && s.contactPhysics && s.finalPhysics);
  assert(s.steps > 36, 'follow-through physics must continue after contact');
  assert(s.frame.impact && s.frame.syncMs >= s.frame.damageMs && s.frame.stepMs > 0);
  assert.equal(c.damage.sites.length > 0, mode === 'enabled');
  const result = { contact: s.contactPhysics, final: s.finalPhysics };
  s.restore(); assert.deepEqual([c.step, c.recordImpact, c.syncMesh, c.damage.update], originals);
  return result;
}
assert.deepEqual(run('baseline'), run('enabled'), 'instrumented production collision physics match');
delete globalThis.game; delete globalThis.dentShots;
console.log('distractodog PASS: guardrails catch CPU/before-render/after-render regressions; matched real collision physics and method restoration');
