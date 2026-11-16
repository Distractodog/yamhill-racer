// Roof-only rules for aircraft (roofs.js roofLedge, heli.js / jet.js groundPose + ledgeAway, jet.js ledge drop), on
// small made-up worlds (no tiles, a second or two):
//   * the helicopter's "slide off the roof's edge" direction is the same wherever the building stands (corners at
//     (0, 0) and at (10000, 10000)), and points from the skid ends on the roof to those over the drop;
//   * on a ROOF edge a wheel / skid end over the drop rests level on the edge; the jet rolling off it falls;
//   * NOT on terrain, ramps or bridge decks: a terrain step, the side of a jump ramp, a bridge deck's edge and a ramp
//     jump keep the old behaviour (tilted pose, a jet taxiing off a 1.2 m step follows the ground, 2 m to fall).
//   node tools/roof_rules_test.mjs            --src=<dir>/game/src runs another copy of the game code
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';

const srcArg = process.argv.find(a => a.startsWith('--src='));
const SRC = path.resolve(srcArg ? srcArg.slice(6) : 'game/src');
const imp = f => import(pathToFileURL(path.join(SRC, f)).href);
const { Heli } = await imp('heli.js');
const { Jet } = await imp('jet.js');
const { rampShape, RAMP_LEN } = await imp('data.js');
const DT = 1 / 120, up = new THREE.Vector3();
let passed = 0, failed = 0;
const ok = (cond, what) => { if (cond) passed++; else failed++; console.log(cond ? 'PASS' : 'FAIL', what); };

// ground(x, z, y) = terrain / overlay height; buildings: footprints {pts, top} (a flat roof at `top`)
function makeWorld(ground, buildings = []) {
  return {
    heightAt: (x, z, y) => ground(x, z, y), groundAt: (x, z) => ground(x, z), terrainAt: (x, z) => ground(x, z),
    surfaceAt: () => 3, normalAt: (x, z, n) => n.set(0, 1, 0), waterLevelAt: () => -Infinity,
    buildingsNear: () => buildings, treesNear: () => {}, loadedAt: () => true, extent: [-1e5, -1e5, 1e5, 1e5], spawn: [0, 0],
  };
}
const flat = () => 0;
const tilt = v => up.set(0, 1, 0).applyQuaternion(v.quat).y;

// ---------------------------------------------------------------- helicopter: the way off a roof's edge
// An L-shaped roof (10 m up) round the notch at (ox, oz): the roof covers x < ox or z < oz. The helicopter stands in the
// notch, its centre off the roof, turned so that one or three of its four skid ends are on the roof.
function heliOnCorner(ox, oz) {
  const L = [[-50, -50], [50, -50], [50, 0], [0, 0], [0, 50], [-50, 50]].map(([x, z]) => [x + ox, z + oz]);
  const w = makeWorld(flat, [{ pts: L, top: 10, h: 10 }]);
  const found = [];
  for (const [cx, cz] of [[0.9, 0.3], [0.3, 0.9], [1.4, 0.2], [0.2, 1.4], [1.0, 1.0]]) for (let yaw = 0; yaw < 6.28; yaw += 0.13) {
    const h = new Heli(w); h.pos.set(ox + cx, 11.6, oz + cz); h.yaw = yaw; h.vel.set(0, 0, 0);
    const out = new THREE.Vector3();
    if (!h.ledgeAway?.(out)) continue;
    // expected: from the centroid of the ends on the roof to the centroid of those off it
    const s = Math.sin(yaw), c = Math.cos(yaw), ends = [[1.1, 1.55], [-1.1, 1.55], [1.1, -1.65], [-1.1, -1.65]]
      .map(([gx, gz]) => [cx + c * gx + s * gz, cz - s * gx + c * gz]);
    const on = ends.filter(([x, z]) => x < 0 || z < 0), off = ends.filter(([x, z]) => !(x < 0 || z < 0));
    if (on.length === 2 || !on.length || !off.length) continue;
    const mean = a => [a.reduce((t, p) => t + p[0], 0) / a.length, a.reduce((t, p) => t + p[1], 0) / a.length];
    const [hx, hz] = mean(on), [lx, lz] = mean(off), el = Math.hypot(lx - hx, lz - hz);
    found.push({ cx, cz, yaw, out: [out.x, out.z], want: [(lx - hx) / el, (lz - hz) / el], split: `${on.length} on / ${off.length} off` });
  }
  return found;
}
{
  const a = heliOnCorner(0, 0), b = heliOnCorner(10000, 10000);
  if (!a.length && !Heli.prototype.ledgeAway) console.log('SKIP heli ledgeAway (this copy has none)');
  else {
    ok(a.length >= 4 && a.length === b.length, `heli on a roof corner: ${a.length} skid placements with 1 or 3 ends on the roof, the same at (0,0) and (10000,10000)`);
    let worst = 0;
    for (let i = 0; i < a.length; i++) {
      worst = Math.max(worst, Math.hypot(a[i].out[0] - b[i].out[0], a[i].out[1] - b[i].out[1]), Math.hypot(a[i].out[0] - a[i].want[0], a[i].out[1] - a[i].want[1]));
    }
    ok(worst < 1e-6, `heli slides off a roof edge from the skids on the roof toward those over the drop, wherever the building is (worst error ${worst.toExponential(1)}; splits ${[...new Set(a.map(f => f.split))].join(', ')})`);
  }
}

// ---------------------------------------------------------------- level on a roof's edge, tilted on a terrain step
{
  // the same 10 m drop at x = 0: a roof (building over x < 0) vs a terrain step (ground 10 m up over x < 0)
  const roof = makeWorld(flat, [{ pts: [[-60, -60], [0, -60], [0, 60], [-60, 60]], top: 10, h: 10 }]);
  const cliff = makeWorld(x => x < 0 ? 10 : 0);
  for (const [name, w, wantLevel] of [['roof edge', roof, true], ['terrain step', cliff, false]]) {
    // helicopter facing +x, centre 0.4 m inside the top, the front skid ends over the drop
    const h = new Heli(w); h.pos.set(-0.4, 12, 0); h.yaw = Math.PI / 2;
    h.groundPose(-0.4, 0, Math.PI / 2, 12);
    const hl = tilt(h);
    // jet facing +x, centre 1 m inside, the nose wheel (3.6 m ahead) over the drop
    const j = new Jet(w); j.pos.set(-1, 12, 0);
    j.groundPose(-1, 0, Math.PI / 2, 0, 12);
    const jl = tilt(j);
    if (wantLevel) ok(hl > 0.999 && jl > 0.999, `${name}: skid ends / nose wheel over the drop rest level on the edge (up.y heli ${hl.toFixed(3)}, jet ${jl.toFixed(3)})`);
    else ok(hl < 0.95 && jl < 0.95, `${name}: no roof, old pose kept: tilted over the drop (up.y heli ${hl.toFixed(3)}, jet ${jl.toFixed(3)})`);
  }
}

// ---------------------------------------------------------------- a jet taxiing off a drop
// 1.2 m: the old rule (fall only when the ground drops 2 m in a step) follows the ground; off a ROOF it falls instead.
function taxiOff(world, x0, z0, yaw, kmh, secs = 3) {
  const j = new Jet(world); j.pos.set(x0, 50, z0); j.reset(x0, z0, yaw); j.v = kmh / 3.6;     // placed from above: onto a roof
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
  const modes = new Set([j.mode]); let maxStep = 0, at = '', last = j.pos.clone();
  for (let i = 0; i < secs / DT; i++) {
    const was = j.mode;
    j.step(DT, inp); modes.add(j.mode);
    assert.ok([j.pos.x, j.pos.y, j.pos.z].every(Number.isFinite), 'finite');
    if (was === 'crashed' && j.mode !== 'crashed') break;          // a crash's respawn is not a step
    const d = last.distanceTo(j.pos);
    if (d > maxStep) { maxStep = d; at = `${(i * DT).toFixed(2)} s ${was}→${j.mode} ${last.toArray().map(q => q.toFixed(2))} → ${j.pos.toArray().map(q => q.toFixed(2))}`; }
    last.copy(j.pos);
  }
  if (process.argv.includes('--v')) console.log('   biggest step', at);
  return { j, modes: [...modes], maxStep };
}
{
  const step = taxiOff(makeWorld(x => x < 0 ? 1.2 : 0), -8, 0, Math.PI / 2, 20);
  ok(!step.modes.includes('air') && Math.abs(step.j.pos.y - 1.6) < 0.05, `terrain step 1.2 m at 20 km/h: the jet follows the ground as before (modes ${step.modes}, ends ${step.j.pos.y.toFixed(2)} m up)`);
  // a bridge deck ending: the deck (1.2 m up) only counts from deck level (y ≥ 1.2 − 3, as data.js BRIDGE_CLIMB)
  const deck = taxiOff(makeWorld((x, z, y) => x < 0 && (y ?? 99) >= 1.2 - 3 ? 1.2 : 0), -8, 0, Math.PI / 2, 20);
  ok(!deck.modes.includes('air') && Math.abs(deck.j.pos.y - 1.6) < 0.05, `bridge deck edge 1.2 m at 20 km/h: the jet follows the ground as before (modes ${deck.modes})`);
  // off the side of a jump ramp (2.2 m high, 14 m wide), where it is 1.2 m up
  const rampAt = (x, z) => Math.abs(z) < 7 ? rampShape(x)[0] : 0;
  const u12 = 1.2 / 2.2 * 11, side = taxiOff(makeWorld(rampAt), u12, 0, 0, 20);
  ok(!side.modes.includes('air'), `off the side of a jump ramp (1.2 m) at 20 km/h: the jet follows the ground as before (modes ${side.modes})`);
  // the ramp jump itself: lifts off at the lip as before, no crash, no snap
  const jump = taxiOff(makeWorld(rampAt), -60, 0, Math.PI / 2, 250, 4);
  ok(jump.modes.includes('air') && !jump.modes.includes('crashed') && jump.maxStep < 1.2, `jump ramp at 250 km/h: off the lip into the air, lands, no crash (modes ${jump.modes}, biggest step ${jump.maxStep.toFixed(2)} m)`);
  // 3 m: falls with either rule
  const big = taxiOff(makeWorld(x => x < 0 ? 3 : 0), -8, 0, Math.PI / 2, 20);
  ok(big.modes.includes('air'), `terrain step 3 m at 20 km/h: the jet falls off it, as before (modes ${big.modes})`);
  // a 1.2 m drop off a ROOF's edge (roof 1.2 m up, no parapet): it falls off the edge instead of snapping down
  {
    const low = makeWorld(flat, [{ pts: [[-60, -60], [0, -60], [0, 60], [-60, 60]], top: 1.2, h: 1.2 }]);
    const off = taxiOff(low, -8, 0, Math.PI / 2, 20);
    ok(off.modes.includes('air') && off.maxStep < 0.3, `roof edge 1.2 m at 20 km/h: the jet rolls off and falls, no snap (modes ${off.modes}, biggest step ${off.maxStep.toFixed(2)} m)`);
  }
}
// ---------------------------------------------------------------- a jet touching a roof = touching the ground
// The same touchdowns on a big flat roof 10 m up and on flat ground 10 m up: identical outcome (land / which crash),
// and a fast low pass flown into a roof's edge crashes.
function touch(world, { kmh, sink, pitch = 0, gear = 1, x = 0, yaw = Math.PI / 2, above = 0.3, secs = 1.5 }) {
  const j = new Jet(world); j.pos.set(x, 30, 0); j.reset(x, 0, yaw);
  j.mode = 'air'; j.gear = gear; j.airTime = 1; j.throttle = 0.4;
  j.pos.set(x, 10 + j.air.gearH + above, 0);
  j.quat.setFromEuler(new THREE.Euler(-pitch, yaw, 0, 'YXZ'));
  j.vel.set(Math.sin(yaw) * kmh / 3.6, -sink, Math.cos(yaw) * kmh / 3.6);
  const inp = { throttle: 0, brake: 0, steer: 0, handbrake: false, jet: { thr: 0, pitch: 0, roll: 0, yaw: 0 } };
  const modes = [j.mode]; let msg = '';
  for (let i = 0; i < secs / DT; i++) {
    j.step(DT, inp);
    if (j.mode !== modes[modes.length - 1]) { modes.push(j.mode); if (j.mode === 'crashed') msg = j.msg; }
    if (j.mode === 'crashed') break;
  }
  return { modes: modes.join('→'), msg };
}
{
  const roof = makeWorld(flat, [{ pts: [[-400, -400], [400, -400], [400, 400], [-400, 400]], top: 10, h: 10 }]);
  const field = makeWorld(() => 10);
  for (const [name, c, want] of [
    ['gentle gear touch, 250 km/h, sinking 1.2 m/s', { kmh: 250, sink: 1.2 }, 'air→ground'],
    ['hard: sinking 11 m/s', { kmh: 250, sink: 11, above: 0.1 }, 'crashed'],
    ['nose down 20°', { kmh: 250, sink: 2, pitch: -0.35, above: 0.1 }, 'crashed'],
    ['belly: gear up, gentle', { kmh: 250, sink: 1.2, gear: 0 }, 'crashed'],
    ['too fast: 600 km/h', { kmh: 600, sink: 1.2 }, 'crashed']]) {
    const a = touch(roof, c), b = touch(field, c);
    ok(a.modes === b.modes && a.msg === b.msg && a.modes.endsWith(want),
      `jet ${name} on a flat roof = on the ground: ${a.modes}${a.msg ? ' (' + a.msg + ')' : ''} vs ${b.modes}${b.msg ? ' (' + b.msg + ')' : ''}`);
  }
  // flown at 300 km/h into the edge of a roof 10 m up (the building is x < 0), wheels 0.5 m / centre 1 m below its top
  const block = makeWorld(flat, [{ pts: [[-400, -400], [0, -400], [0, 400], [-400, 400]], top: 10, h: 10 }]);
  for (const below of [0.5, 2.6]) {
    const r = touch(block, { kmh: 300, sink: 0, x: 60, yaw: -Math.PI / 2, above: -below, secs: 2 });
    ok(r.modes.endsWith('crashed'), `jet flown at 300 km/h into a roof's edge, wheels ${below} m below its top: crashes (${r.modes}, ${r.msg})`);
  }
  // the same gentle touch just past a roof's edge, moving away from it: rides the edge and goes on (no crash, no snap)
  const off = touch(block, { kmh: 250, sink: 0.3, x: 1.0, yaw: Math.PI / 2, above: 0.05, secs: 0.5 });
  ok(!off.modes.includes('crashed'), `jet touching a roof's edge gently while leaving it: no crash (${off.modes})`);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
