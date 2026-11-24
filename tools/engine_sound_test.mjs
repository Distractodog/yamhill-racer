// Engine sounds per vehicle type (game/src/audio/*.js, audio.js) on a fake AudioContext: gears / rpm per type, loop
// crossfade, the loop files themselves, lazy loading and buffers shared by every voice on a context, volume sliders,
// shift clunk / dip, lift-off crackle, turbo, jets (whine, afterburner), propellers, helicopter, per-frame cost.
// node tools/engine_sound_test.mjs        (no server, no browser; ~1 s)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ENGINES, engineKey, gearTops, newEngineState, stepEngine, loopMix, soundRpm, soundLog } from '../game/src/audio/engines.js';
import { ENGINE_LOOPS } from '../game/src/audio/engineloops.js';
import { RECORDED_ENGINES } from '../game/src/audio/recordedengines.js';
import { SOUND_KEY, SOUND_DEFAULTS, sanitizeSound, loadSound, saveSound, sliderGain, mixerFor } from '../game/src/audio/mixer.js';
import { CarAudio } from '../game/src/audio.js';

let failed = 0;
async function check(name, fn) {
  try { const note = await fn(); console.log(`ok   ${name}${note ? ` — ${note}` : ''}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${e.message}`); }
}
const GROUND = ['race', 'sports', 'hatch', 'suv', 'truck', 'dirt', 'sport'];
const TYPES = { car: ['race', 'sports', 'hatch', 'suv', 'truck'], bike: ['dirt', 'sport'], jet: ['fighter', 'stealth', 'blackbird', 'airliner', 'prop', 'stunt', 'heli'] };

// ---------------------------------------------------------------- fake Web Audio
function fakeAudio() {
  const stats = { sources: 0, stopped: 0, decodes: 0, list: [] };
  // one-shots started since index i, by length: pop 0.06 s, clunk 0.12 s, boom 0.7 s
  stats.shots = (i, seconds) => stats.list.slice(i).filter(s => s.buffer && Math.abs(s.buffer.duration - seconds) < 1e-6).length;
  const param = v => ({ value: v, last: v, setTargetAtTime(x) { this.last = x; }, setValueAtTime(x) { this.last = x; }, cancelScheduledValues() {} });
  const node = extra => ({ outs: [], connect(n) { this.outs.push(n); return n; }, disconnect() { this.outs = []; }, ...extra });
  const source = extra => { stats.sources++; const s = node({ start() { this.started = true; }, stop() { stats.stopped++; this.stopped = true; }, ...extra }); stats.list.push(s); return s; };
  const ctx = { currentTime: 0, sampleRate: 8000, state: 'running', resume() {},
    destination: node({ name: 'destination' }),
    createGain: () => node({ gain: param(1) }), createStereoPanner: () => node({ pan: param(0) }),
    createBiquadFilter: () => node({ type: '', frequency: param(350), Q: param(1), gain: param(0) }),
    createWaveShaper: () => node({ curve: null }),
    createBuffer: (c, n, sr) => { const d = new Float32Array(n); return { duration: n / sr, sampleRate: sr, getChannelData: () => d }; },
    createBufferSource: () => source({ playbackRate: param(1), buffer: null, loop: false }),
    createOscillator: () => source({ frequency: param(440), type: 'sine' }),
    decodeAudioData: async b => { stats.decodes++; return { duration: 0.6, sampleRate: 44100, bytes: b.byteLength, id: stats.decodes }; } };
  return { ctx, stats };
}
const fetches = [];
globalThis.fetch = async url => { const s = String(url); fetches.push(s); return { ok: true, arrayBuffer: async () => new ArrayBuffer(16) }; };
const settle = () => new Promise(r => setTimeout(r, 0));
const vec = (kmh = 0) => ({ length: () => kmh / 3.6 });
const ground = (kind, type, extra = {}) => ({ kind, type, vel: vec(0), grounded: true, airTime: 0, slip: 0, surface: 3, hit: 0, landing: 0, t: {}, ...extra });
const air = (type, extra = {}) => ({ kind: 'jet', type, vel: vec(0), mode: 'ground', throttle: 0, grounded: true, hit: 0, landing: 0, mesh: { userData: type === 'heli' ? { mainRotor: {} } : {} }, typePhysics: null, ...extra });

// ---------------------------------------------------------------- vehicle types -> engines
await check('every vehicle type has its own engine', async () => {
  let real = null;
  try { real = (await import('../game/src/vehicletypes.js')).VEHICLE_TYPES; } catch { /* three.js not installed: the list above */ }
  const list = real ? Object.fromEntries(Object.entries(real).map(([k, v]) => [k, v.map(t => t.id)])) : TYPES;
  if (real) assert.deepEqual(list, TYPES, 'vehicletypes.js types = the engines this test expects');
  const keys = Object.entries(list).flatMap(([kind, ids]) => ids.map(type => engineKey(kind === 'jet' ? air(type) : { kind, type })));
  assert.equal(new Set(keys).size, keys.length, `distinct engines ${keys}`);
  for (const k of keys) assert(ENGINES[k], k);
  assert.equal(engineKey({ kind: 'car' }), 'race'); assert.equal(engineKey({ kind: 'bike', type: 'nope' }), 'dirt');
  assert.equal(engineKey(air(undefined)), 'fighter');
  assert.equal(engineKey({ kind: 'jet', mesh: { userData: { mainRotor: {} } } }), 'heli', 'rotor model = helicopter');
  assert.equal(engineKey({ kind: 'jet', typePhysics: { prop: 1.4 } }), 'stunt');
  return `${keys.length} types${real ? ' (checked against vehicletypes.js)' : ' (three.js missing: fixed list)'}`;
});

// ---------------------------------------------------------------- gears and rpm
function run(p, { from = 0, to, accel, throttle = 1, seconds, topKmh, dt = 1 / 60, grounded = true, slip = 0 }) {
  const st = newEngineState(); st.rpm = p.idle;
  const n = Math.round(seconds / dt), log = [];
  let kmh = from;
  for (let i = 0; i < n; i++) {
    if (accel) kmh = Math.min(to ?? Infinity, kmh + accel * 3.6 * dt);
    const rpmBefore = st.rpm, gear = st.gear;
    const ev = stepEngine(st, p, { kmh, throttle, grounded, slip, topKmh }, dt);
    log.push({ t: i * dt, kmh, rpm: st.rpm, gear: st.gear, ev, rpmBefore, gearBefore: gear });
  }
  return { st, log };
}
for (const key of GROUND) {
  await check(`${key}: full throttle shifts up through every gear near the redline, revs stay in range`, () => {
    const p = ENGINES[key], tops = gearTops(p, p.gearTop), top = tops.at(-1);
    const { log } = run(p, { accel: 6, to: top, seconds: top / 3.6 / 6 + 2, topKmh: p.gearTop });
    const ups = log.filter(l => l.ev === 'up'), downs = log.filter(l => l.ev === 'down');
    assert.equal(ups.length, p.gears - 1, `${ups.length} up-shifts for ${p.gears} gears`);
    assert.equal(downs.length, 0, 'no down-shift while accelerating');
    for (const u of ups) assert(u.rpmBefore > 0.9 * p.redline, `shift at ${u.rpmBefore.toFixed(0)} rpm (redline ${p.redline})`);
    for (let i = 1; i < ups.length; i++) assert(ups[i].t - ups[i - 1].t >= 0.35, 'shifts at least 0.35 s apart');
    const max = Math.max(...log.map(l => l.rpm)), min = Math.min(...log.map(l => l.rpm));
    assert(max <= p.redline * 1.03 && max >= p.redline * 0.95, `max ${max.toFixed(0)}`);
    assert(min >= p.idle * 0.999, `min ${min.toFixed(0)}`);
    // the drop after an up-shift = the gear ratio step (rpm 0.2 s later vs. just before)
    const u = ups[1], after = log.find(l => l.t >= u.t + 0.2);
    const step = p.spread ** (1 / (p.gears - 1));
    assert(Math.abs(u.rpmBefore / after.rpm - step) < 0.2, `drop ${(u.rpmBefore / after.rpm).toFixed(2)} vs ratio ${step.toFixed(2)}`);
    return `${p.gears} gears to ${top.toFixed(0)} km/h, first to ${tops[0].toFixed(0)}, shifts at ${ups.map(u => Math.round(u.kmh)).join('/')} km/h, ${Math.round(min)}–${Math.round(max)} rpm`;
  });
  await check(`${key}: steady cruising never hunts; coasting down shifts down without hunting`, () => {
    const p = ENGINES[key], top = gearTops(p, p.gearTop).at(-1);
    for (const f of [0.15, 0.3, 0.5, 0.7, 0.9]) for (const th of [0.2, 0.5, 1]) {
      // (from first gear it takes up to ~3 s to climb to the right one; after that, none)
      const { log } = run(p, { from: f * top, seconds: 14, throttle: th, topKmh: p.gearTop });
      const evs = log.filter(l => l.ev && l.t > 4);
      assert(!log.some((l, i) => l.ev === 'down' && log.slice(0, i).some(x => x.ev === 'up')), 'no up then down');
      assert.equal(evs.length, 0, `${(f * top).toFixed(0)} km/h at throttle ${th}: ${evs.length} shifts after settling`);
    }
    // coasting from top speed in top gear to a stop, braking at 8 m/s²
    const s = newEngineState(), log = [];
    s.gear = p.gears - 1; s.rpm = p.redline;
    for (let kmh = top; kmh > 0;) {
      kmh = Math.max(0, kmh - 8 * 3.6 / 60);
      const ev = stepEngine(s, p, { kmh, throttle: 0, grounded: true, slip: 0, topKmh: p.gearTop }, 1 / 60);
      log.push({ ev, gear: s.gear, rpm: s.rpm });
    }
    const evs = log.filter(l => l.ev);
    assert(evs.length >= p.gears - 2 && evs.every(l => l.ev === 'down'), `only down-shifts while slowing (${evs.map(e => e.ev)})`);
    assert(log.every(l => l.rpm < p.redline * 1.03), 'no over-rev on a down-shift');
    assert(log.at(-1).gear <= 1, `back to first or second (${log.at(-1).gear + 1})`);
    return `${evs.length} down-shifts from ${top.toFixed(0)} km/h to a stop`;
  });
}
await check('revs: on the spot, in the air, wheelspin, past the top gear', () => {
  const out = [];
  for (const key of GROUND) {
    const p = ENGINES[key];
    const still = run(p, { seconds: 2, throttle: 1, topKmh: p.gearTop }).st.rpm;
    assert(Math.abs(still - 0.5 * p.redline) < 0.05 * p.redline, `${key} revving on the spot ${still.toFixed(0)}`);
    const idle = run(p, { seconds: 2, throttle: 0, topKmh: p.gearTop }).st.rpm;
    assert(Math.abs(idle - p.idle) < 1, `${key} idle ${idle}`);
    const inAir = run(p, { from: 60, seconds: 1, throttle: 1, grounded: false, topKmh: p.gearTop }).st.rpm;
    assert(inAir > 0.98 * p.redline, `${key} free revs in the air ${inAir.toFixed(0)}`);
    const spin = run(p, { from: 20, seconds: 1, throttle: 1, slip: 0.8, topKmh: p.gearTop }).st.rpm;
    const grip = run(p, { from: 20, seconds: 1, throttle: 1, topKmh: p.gearTop }).st.rpm;
    assert(spin > grip * 1.2, `${key} wheelspin ${spin.toFixed(0)} > ${grip.toFixed(0)}`);
    // arcade top speeds: past the top gear's redline the revs keep climbing a little (no limiter), up to +10 %
    const vmax = 1000, over = run(p, { from: vmax, seconds: 3, throttle: 1, topKmh: vmax });
    assert(over.st.gear === p.gears - 1 && over.st.rpm <= 1.101 * p.redline && over.st.rpm > p.redline, `${key} at ${vmax} km/h: ${over.st.rpm.toFixed(0)}`);
    out.push(`${key} ${Math.round(p.idle)}–${p.redline}`);
  }
  assert(ENGINES.race.redline >= 12000, 'race car revs to ~12k');
  assert(ENGINES.sport.redline > ENGINES.dirt.redline && ENGINES.truck.redline < ENGINES.suv.redline, 'sport bike screams highest, truck lowest');
  return out.join(', ');
});
await check('loop crossfade: equal power, pitch = rpm / loop rpm, stays near the loops', () => {
  let worst = [9, 0];
  for (const key of [...GROUND, 'prop', 'stunt']) {
    const p = ENGINES[key], L = RECORDED_ENGINES[p.loops] || ENGINE_LOOPS[p.loops];
    for (let gr = p.idle * 0.5; gr <= p.redline * 1.1; gr += 37) {
      const r = soundRpm(p, gr), m = loopMix(L, r), pw = m.reduce((s, x) => s + x[1] ** 2, 0);
      assert(Math.abs(pw - 1) < 1e-9, `${key} ${r} power ${pw}`);
      for (const [i, , rate] of m) assert(Math.abs(rate - r / L[i].rpm) < 1e-9);
      if (gr >= p.idle) assert(soundRpm(p, gr + 1) > r, `${key} pitch rises with rpm`);
      const [, , rate] = m.reduce((a, b) => (b[1] > a[1] ? b : a));
      if (gr >= p.idle) worst = [Math.min(worst[0], rate), Math.max(worst[1], rate)];
    }
  }
  assert(worst[0] > 0.6 && worst[1] < 1.56, `loudest loop's rate ${worst[0].toFixed(2)}–${worst[1].toFixed(2)}`);
  return `loudest loop pitched ×${worst[0].toFixed(2)}–×${worst[1].toFixed(2)} from idle to 110 % redline`;
});

// ---------------------------------------------------------------- the loop files
await check('loop files: on disk, sizes as listed, mono 16-bit 44.1 kHz WAV, ≤ 150 KB, rpm ascending', () => {
  let total = 0; const per = [];
  for (const [type, L] of [...Object.entries(ENGINE_LOOPS), ...Object.entries(RECORDED_ENGINES)]) {
    let sum = 0;
    L.forEach((l, i) => {
      const b = fs.readFileSync(new URL(`../game/assets/audio/${l.file}`, import.meta.url));
      assert.equal(b.length, l.bytes, `${l.file} size`);
      assert(b.length <= 150 * 1024, `${l.file} ${b.length} bytes`);
      assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.toString('ascii', 8, 12), 'WAVE');
      assert.equal(b.readUInt16LE(22), 1, 'mono'); assert.equal(b.readUInt32LE(24), 44100, '44.1 kHz'); assert.equal(b.readUInt16LE(34), 16, '16-bit');
      if (i) assert(l.rpm > L[i - 1].rpm, `${type} rpm ascending`);
      sum += b.length;
    });
    total += sum; per.push(`${type} ${(sum / 1024).toFixed(0)} KB`);
  }
  for (const key of Object.keys(ENGINES)) if (ENGINES[key].loops) assert(ENGINE_LOOPS[ENGINES[key].loops], key);
  // crossfaded loops must sound at the same pitch: each loop listed at its true rpm (the recordings: firing Hz × 30)
  const rec = JSON.parse(fs.readFileSync(new URL('../game/assets/audio/engine.json', import.meta.url), 'utf8'));
  ENGINE_LOOPS.hatch.forEach(l => assert.equal(l.rpm, rec[l.file.match(/engine_(\w+)\.wav/)[1]].hz * 30, l.file));
  return `${per.join(', ')}; all ${(total / 1024).toFixed(0)} KB`;
});

// ---------------------------------------------------------------- lazy loading, shared buffers
await check('lazy per type, decoded once per audio context, buffers shared by your voice and other players\'', async () => {
  const { ctx, stats } = fakeAudio(); fetches.length = 0;
  const me = new CarAudio({}); me.opts.ctx = ctx; me.start();
  const other = new CarAudio({ ctx, out: ctx.createGain() }); other.start();
  assert.equal(fetches.length, 0, 'nothing fetched before an engine is heard');
  me.update(ground('car', 'race'), { throttle: 0 }, 1 / 60); other.update(ground('car', 'race'), { throttle: 0 }, 1 / 60);
  await settle();
  assert.equal(fetches.length, ENGINE_LOOPS.race.length, `race loops fetched once: ${fetches.length}`);
  assert(fetches.every(u => RECORDED_ENGINES.race.some(l => u.endsWith(l.file))), 'only the race car\'s recordings');
  assert.equal(stats.decodes, ENGINE_LOOPS.race.length);
  const a = me.engine.part.layers.map(l => l.src.buffer), b = other.engine.part.layers.map(l => l.src.buffer);
  assert.equal(a.length, ENGINE_LOOPS.race.length); a.forEach((buf, i) => assert.equal(buf, b[i], 'same AudioBuffer'));
  other.update(ground('bike', 'sport'), { throttle: 0 }, 1 / 60); await settle();
  assert.equal(fetches.length, ENGINE_LOOPS.race.length + ENGINE_LOOPS.sport.length, 'switching type loads that type');
  other.update(ground('car', 'race'), { throttle: 0 }, 1 / 60); await settle();
  assert.equal(fetches.length, ENGINE_LOOPS.race.length + ENGINE_LOOPS.sport.length, 'back to a heard type: no new fetch');
  for (const v of [air('fighter'), air('heli')]) me.update(v, { throttle: 0 }, 1 / 60);
  await settle();
  assert.equal(fetches.length, ENGINE_LOOPS.race.length + ENGINE_LOOPS.sport.length + 1, 'jet is synthesised; helicopter loads one rotor recording');
  const second = fakeAudio(), v3 = new CarAudio({ ctx: second.ctx, out: second.ctx.createGain() }); v3.start();
  v3.update(ground('car', 'race'), { throttle: 0 }, 1 / 60); await settle();
  assert.equal(second.stats.decodes, ENGINE_LOOPS.race.length, 'another context decodes its own');
  assert(soundLog.length >= fetches.length && soundLog.every(l => !l.error), 'loads logged without errors');
  return `${fetches.length} fetches for race + sport; ${stats.decodes} decodes shared by 2 voices`;
});

// ---------------------------------------------------------------- volumes
await check('volume sliders: saved, sanitised, squared, buses in the right places', async () => {
  const store = new Map(), storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(loadSound(storage), SOUND_DEFAULTS);
  saveSound({ master: 0.5, engines: 2, effects: NaN, junk: 1 }, storage);
  assert.deepEqual(JSON.parse(store.get(SOUND_KEY)), { master: 0.5, engines: 1, effects: 1 });
  assert.deepEqual(loadSound(storage), { master: 0.5, engines: 1, effects: 1 });
  store.set(SOUND_KEY, '{bad json'); assert.deepEqual(loadSound(storage), SOUND_DEFAULTS);
  assert.deepEqual(sanitizeSound({ master: null, engines: '0.3', effects: -1 }), { master: 1, engines: 1, effects: 0 });
  assert.equal(sliderGain(1), 1); assert.equal(sliderGain(0), 0); assert.equal(sliderGain(0.5), 0.25);
  const { ctx } = fakeAudio(), saved = globalThis.localStorage;
  globalThis.localStorage = storage; store.set(SOUND_KEY, JSON.stringify({ master: 0.8, engines: 0.6, effects: 0.4 }));
  try {
    const me = new CarAudio(); me.opts.ctx = ctx;
    assert.deepEqual(me.volumes, { master: 0.8, engines: 0.6, effects: 0.4 }, 'loaded before the sound starts');
    me.start();
    const m = mixerFor(ctx);
    assert(Math.abs(m.master.gain.last - 0.64) < 1e-9 && Math.abs(m.engines.gain.last - 0.36) < 1e-9 && Math.abs(m.effects.gain.last - 0.16) < 1e-9, 'bus gains = slider²');
    assert(me.engineOut.outs.includes(m.engines) && me.master.outs.includes(m.effects), 'engine -> Engines bus, tyres/wind -> Effects bus');
    assert(m.engines.outs.includes(m.master) && m.effects.outs.includes(m.master) && m.master.outs.includes(ctx.destination), 'both -> Master -> speakers');
    assert.equal(me.engineBus, m.engines, 'other players\' voices play into the Engines bus');
    me.setVolumes({ engines: 0.5 });
    assert(Math.abs(m.engines.gain.last - 0.25) < 1e-9); assert.equal(JSON.parse(store.get(SOUND_KEY)).engines, 0.5, 'saved');
    const remote = new CarAudio({ ctx, out: ctx.createGain() });
    assert.equal(remote.volumes, null, 'other players\' voices don\'t read the settings');
  } finally { globalThis.localStorage = saved; }
});
await check('remotes.js: other players\' engines go through the Engines bus', () => {
  const src = fs.readFileSync(new URL('../game/src/mp/remotes.js', import.meta.url), 'utf8');
  assert(/audio\.engineBus \|\| ctx\.destination/.test(src));
});

// ---------------------------------------------------------------- shifts, crackle, turbo
async function voice(v) {
  const { ctx, stats } = fakeAudio(), a = new CarAudio({ ctx, out: ctx.createGain() }); a.start();
  a.update(v, { throttle: 0 }, 1 / 60); await settle();
  return { a, ctx, stats };
}
await check('gear shifts: a clunk and a short dip in level, using each type\'s gearing', async () => {
  const out = [];
  for (const key of GROUND) {
    const [kind, type] = key === 'dirt' || key === 'sport' ? ['bike', key] : ['car', key];
    const v = ground(kind, type), { a, ctx, stats } = await voice(v), p = ENGINES[key];
    let kmh = 0, shifts = 0, dips = 0, clunks = 0;
    for (let i = 0; i < 60 * 30; i++) {
      kmh += 6 * 3.6 / 60; v.vel = vec(kmh); ctx.currentTime += 1 / 60;
      const before = stats.list.length, gear = a.gear;
      a.update(v, { throttle: 1 }, 1 / 60);
      if (a.gear !== gear) { shifts++; clunks += stats.shots(before, 0.12); if (a.engine.part.level.gain.last < p.gain * 1.35 * p.dip + 1e-9) dips++; }
      if (kmh > gearTops(p, p.gearTop).at(-1)) break;
    }
    assert.equal(shifts, p.gears - 1, `${key}: ${shifts} shifts`); assert.equal(clunks, shifts, 'a clunk each'); assert.equal(dips, shifts, 'level dipped each');
    out.push(`${key} ${shifts}`);
  }
  return out.join(', ');
});
await check('lift-off crackle: sports car pops, SUV doesn\'t; truck turbo whistles and blows off', async () => {
  const pops = {};
  for (const type of ['sports', 'suv']) {
    const v = ground('car', type, { vel: vec(150) }), { a, ctx, stats } = await voice(v);
    for (let i = 0; i < 120; i++) { ctx.currentTime += 1 / 60; a.update(v, { throttle: 1 }, 1 / 60); }
    const before = stats.list.length;
    for (let i = 0; i < 60; i++) { ctx.currentTime += 1 / 60; a.update(v, { throttle: 0 }, 1 / 60); }
    pops[type] = stats.shots(before, 0.06);
  }
  assert(pops.sports >= 5 && pops.suv === 0, `pops in 1 s after lifting: sports ${pops.sports}, suv ${pops.suv}`);
  const v = ground('car', 'truck', { vel: vec(90) }), { a, ctx } = await voice(v), part = a.engine.part;
  for (let i = 0; i < 180; i++) { ctx.currentTime += 1 / 60; a.update(v, { throttle: 1 }, 1 / 60); }
  const whistle = [part.whistle.gain.last, part.whistleOsc.frequency.last];
  a.update(v, { throttle: 0 }, 1 / 60);
  assert(whistle[0] > 0.01 && whistle[1] > 4000, `whistle ${whistle[0].toFixed(3)} at ${whistle[1].toFixed(0)} Hz`);
  assert(part.bov.gain.last === 0 && part.bov.gain._v === undefined, 'blow-off kicked on lift-off');
  return `sports ${pops.sports} pops, whistle ${whistle[1].toFixed(0)} Hz`;
});

// ---------------------------------------------------------------- aircraft
await check('jets: whine rises with throttle, afterburner rumbles at full with one boom; stealth and Blackbird have two whines', async () => {
  const v = air('fighter', { mode: 'air' }), { a, ctx, stats } = await voice(v), part = () => a.engine.part;
  const at = th => { v.throttle = th; for (let i = 0; i < 300; i++) { ctx.currentTime += 1 / 60; a.update(v, {}, 1 / 60); } return { whine: part().whineOsc[0].frequency.last, roar: part().roar.gain.last, ab: part().abRumble.gain.last }; };
  const lo = at(0.1), mid = at(0.8), before = stats.list.length, full = at(1), booms = stats.shots(before, 0.7);
  assert(lo.whine < mid.whine && mid.whine <= full.whine && lo.roar < mid.roar, `whine ${lo.whine.toFixed(0)} → ${mid.whine.toFixed(0)} → ${full.whine.toFixed(0)} Hz`);
  assert(mid.ab === 0 && full.ab > 0.7, `afterburner ${mid.ab} at 80 %, ${full.ab.toFixed(2)} at 100 %`);
  assert.equal(booms, 1, 'one boom when it lights');
  v.mode = 'crashed'; at(0); assert(part().roar.gain.last < 1e-3 && part().abRumble.gain.last < 1e-3, 'crashed: silent');
  for (const type of ['stealth', 'blackbird']) {
    const s = air(type), w = await voice(s);
    assert.equal(w.a.engine.part.whineOsc.length, 2, `${type}: twin`);
  }
  return `whine ${lo.whine.toFixed(0)} → ${full.whine.toFixed(0)} Hz, afterburner rumble ${full.ab.toFixed(2)}`;
});
await check('airliner: four low turbofan whines, no afterburner', async () => {
  const v = air('airliner', { mode: 'air', throttle: 1 }), { a, ctx } = await voice(v);
  for (let i = 0; i < 300; i++) { ctx.currentTime += 1 / 60; a.update(v, {}, 1 / 60); }
  assert.equal(a.engine.part.whineOsc.length, 4);
  assert.equal(a.engine.part.abRumble.gain.last, 0);
  assert.equal(a.engine.st.ab, 0);
});
await check('prop and stunt planes: piston loops at engine rpm, blade beat tied to rpm, stunt higher', async () => {
  const res = {};
  for (const type of ['prop', 'stunt']) {
    const v = air(type, { mode: 'air', throttle: 1 }), { a, ctx } = await voice(v);
    for (let i = 0; i < 240; i++) { ctx.currentTime += 1 / 60; a.update(v, {}, 1 / 60); }
    const st = a.engine.st, part = a.engine.part, p = ENGINES[type];
    assert(Math.abs(part.chopLfo.frequency.last - st.rpm / 60 * p.blades) < 1, 'beat = blade-pass rate');
    assert(st.rpm > 0.95 * p.redline, `${type} full rpm ${st.rpm.toFixed(0)}`);
    const loud = part.layers.reduce((x, l) => (l.gain.gain.last > x.gain.gain.last ? l : x));
    assert(Math.abs(loud.src.playbackRate.last / (st.rpm / loud.rpm) - 1) < 2e-3, 'loop pitched to the rpm');
    v.throttle = 0; for (let i = 0; i < 240; i++) { ctx.currentTime += 1 / 60; a.update(v, {}, 1 / 60); }
    res[type] = [part.chopLfo.frequency.last, a.engine.st.rpm];
    v.throttle = 1; for (let i = 0; i < 240; i++) { ctx.currentTime += 1 / 60; a.update(v, {}, 1 / 60); }
    res[type].push(part.chopLfo.frequency.last);
  }
  assert(res.stunt[2] > res.prop[2] * 1.4, `blade-pass at full: prop ${res.prop[2].toFixed(0)} Hz, stunt ${res.stunt[2].toFixed(0)} Hz`);
  assert(res.prop[0] < res.prop[2] * 0.6, 'beat slows at idle');
  return `blade-pass idle→full: prop ${res.prop[0].toFixed(0)}→${res.prop[2].toFixed(0)} Hz, stunt ${res.stunt[0].toFixed(0)}→${res.stunt[2].toFixed(0)} Hz`;
});
await check('helicopter: rotor chop + slap + turbine; switching vehicle stops the old engine\'s sources', async () => {
  const h = air('heli', { mode: 'air', throttle: 0.2 }), { a, ctx, stats } = await voice(h);
  for (let i = 0; i < 60; i++) { ctx.currentTime += 1 / 60; a.update(h, {}, 1 / 60); }
  const idle = [a.engine.part.rotorLfo.frequency.last, a.engine.part.rotorGain.gain.last];
  h.throttle = 1; h.vel = vec(150); for (let i = 0; i < 60; i++) { ctx.currentTime += 1 / 60; a.update(h, {}, 1 / 60); }
  const part = a.engine.part, full = [part.rotorLfo.frequency.last, part.rotorGain.gain.last];
  assert(full[0] > idle[0] * 2 && full[1] > idle[1] * 3 && part.slap.gain.last > 0.2 && part.whine.gain.last > 0.02);
  const stoppedBefore = stats.stopped;
  a.update(ground('car', 'race'), { throttle: 0 }, 1 / 60);
  assert.equal(stats.stopped - stoppedBefore, part.sources.length, 'rotor sources stopped');
  return `chop ${idle[0].toFixed(1)} → ${full[0].toFixed(1)} Hz`;
});

// ---------------------------------------------------------------- cost
await check('per-frame cost: your engine + 4 other players\' (fake audio nodes) well under 0.3 ms', async () => {
  const { ctx } = fakeAudio(), mine = new CarAudio({}); mine.opts.ctx = ctx; mine.start();
  const vs = [ground('car', 'sports'), ground('car', 'truck'), ground('bike', 'sport'), air('fighter', { mode: 'air' }), air('heli', { mode: 'air' })];
  const voices = vs.map((v, i) => (i ? new CarAudio({ ctx, out: ctx.createGain() }) : mine)); voices.forEach(v => v.start());
  voices.forEach((a, i) => a.update(vs[i], { throttle: 0 }, 1 / 60)); await settle();
  const frames = 6000, t0 = performance.now();
  for (let f = 0; f < frames; f++) {
    ctx.currentTime += 1 / 60;
    voices.forEach((a, i) => { const v = vs[i]; v.vel = vec(80 + 60 * Math.sin(f / 90 + i)); v.throttle = 0.5 + 0.5 * Math.sin(f / 50 + i); a.update(v, { throttle: f % 200 < 150 ? 1 : 0 }, 1 / 60); });
  }
  const ms = (performance.now() - t0) / frames;
  assert(ms < 0.3, `${ms.toFixed(4)} ms per frame`);
  return `${(ms * 1000).toFixed(1)} µs per frame for 5 voices (JS side only)`;
});

console.log(failed ? `\n${failed} FAILED` : '\nall engine sound checks passed');
process.exit(failed ? 1 : 0);
