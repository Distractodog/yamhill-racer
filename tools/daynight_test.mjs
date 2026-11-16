// Day/night cycle + random rain (daycycle.js, atmosphere.js): clock and phases, keyframe looks and their blending (no
// jumps), sun / moon / light paths, the shower scheduler (fixed seed), multiplayer follow, saved settings and
// migration, headlights at dusk, and the per-frame cost with no objects or lights added over a whole cycle.
//   node tools/daynight_test.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as THREE from 'three';
import {
  ATMOSPHERE_PRESETS, CYCLE, MINUTE, PHASES, LOOK_KEYS, JUMPS, WEATHER, LIGHT_MIN_Y, SUN,
  lookAt, fixedLook, rainOver, makeLook, arcDir, lightDir, phaseAt, createShowers, createDayCycle,
} from '../game/src/daycycle.js';
import { createAtmosphere, loadAtmosphereSettings } from '../game/src/atmosphere.js';
import { lightsEnabled } from '../game/src/lights.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const lin = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const sameLook = (look, p, eps = 1e-9) => {
  for (const k of ['sky', 'fog', 'sun', 'hemi', 'ground']) lin(p[k]).forEach((v, i) => assert(near(look[k][i], v, eps), `${p.id} ${k}`));
  for (const k of ['near', 'far', 'power', 'ambient', 'night']) assert(near(look[k], p[k], eps), `${p.id} ${k}: ${look[k]} vs ${p[k]}`);
};
const preset = id => ATMOSPHERE_PRESETS.find(p => p.id === id);

// ---- clock: 50 minutes, morning 5 → day 20 → dusk 5 → night 20
assert.equal(CYCLE, 50 * MINUTE);
assert.deepEqual(PHASES.map(p => [p.id, p.minutes]), [['morning', 5], ['day', 20], ['dusk', 5], ['night', 20]]);
for (const [m, id] of [[0, 'morning'], [4.99, 'morning'], [5, 'day'], [24.9, 'day'], [25, 'dusk'], [29.9, 'dusk'], [30, 'night'], [49.9, 'night'], [50, 'morning'], [-1, 'night']])
  assert.equal(phaseAt(m * MINUTE), id, `phase at ${m} min`);
for (const [id, m] of Object.entries(JUMPS)) assert.equal(phaseAt(m * MINUTE), id, `"Time now: ${id}" lands in ${id}`);
{ const c = createDayCycle(); assert(!c.jump('constructor') && !c.jump(NaN) && !c.jump('noon')); assert.equal(c.time, 0);
  assert(c.jump(29.5 * MINUTE)); assert.equal(c.phase, 'dusk'); assert(c.jump(-60)); assert.equal(c.time, CYCLE - 60); }

// ---- keyframes: each key shows its preset exactly; morning stretch = misty, midday, golden → rose dusk, night
for (const [m, id] of LOOK_KEYS) sameLook(lookAt(m * MINUTE), preset(id));
sameLook(lookAt(0), preset('morning')); sameLook(lookAt(2 * MINUTE), preset('morning'));
sameLook(lookAt(15 * MINUTE), preset('midday')); sameLook(lookAt(40 * MINUTE), preset('night'));
for (const p of ATMOSPHERE_PRESETS) sameLook(fixedLook(p.id), p);
// halfway between two keys = the plain average (smoothstep(0.5) = 0.5)
{ const l = lookAt(6 * MINUTE), a = preset('morning'), b = preset('midday'); assert(near(l.far, (a.far + b.far) / 2)); assert(near(l.power, (a.power + b.power) / 2)); }

// ---- no jumps: over a whole cycle in 0.5 s steps every value moves only a little per step, and wraps cleanly
{
  const keys = ['near', 'far', 'power', 'ambient', 'night'], cols = ['sky', 'fog', 'sun', 'hemi', 'ground'];
  let prev = lookAt(-0.5), prevLight = lightDir(-0.5), worst = {};
  for (let t = 0; t <= CYCLE; t += .5) {
    const l = lookAt(t), d = lightDir(t);
    for (const k of keys) worst[k] = Math.max(worst[k] || 0, Math.abs(l[k] - prev[k]));
    for (const k of cols) for (let i = 0; i < 3; i++) worst[k] = Math.max(worst[k] || 0, Math.abs(l[k][i] - prev[k][i]));
    worst.light = Math.max(worst.light || 0, Math.hypot(d[0] - prevLight[0], d[1] - prevLight[1], d[2] - prevLight[2]));
    assert(d[1] >= LIGHT_MIN_Y - 1e-9, `light never below the horizon limit at ${t}`); assert(near(Math.hypot(...d), 1, 1e-9));
    for (const v of [...keys.map(k => l[k]), ...cols.flatMap(k => l[k]), ...d]) assert(Number.isFinite(v));
    prev = makeLook(); Object.assign(prev, structuredClone(l)); prevLight = [...d];
  }
  // biggest change in half a second (the steepest blend is golden hour → rose dusk, 2.5 min): fog distance < 3 m,
  // colours and intensities < 1%, light direction < 0.04 rad (and dimmed while it swings: see handoffDim)
  assert(worst.far < 3 && worst.near < 3, JSON.stringify(worst));
  for (const k of cols) assert(worst[k] < .005, `${k} step ${worst[k]}`);
  assert(worst.power < .01 && worst.ambient < .01 && worst.night < .005, JSON.stringify(worst));
  assert(worst.light < .04, `light direction step ${worst.light}`);
  console.log('largest change per 0.5 s:', Object.fromEntries(Object.entries(worst).map(([k, v]) => [k, +v.toPrecision(3)])));
}

// ---- sun and moon cross the sky east → west; the light is the sun by day and the moon by night
{
  const s0 = arcDir(0, SUN), sNoon = arcDir(13.5 * MINUTE, SUN), sDusk = arcDir(28 * MINUTE, SUN), sNight = arcDir(40 * MINUTE, SUN);
  assert(s0[0] > .8 && s0[1] > .1, 'morning sun low in the east'); assert(sNoon[1] > .8, 'high at midday'); assert(sDusk[0] < -.8 && sDusk[1] > 0, 'low in the west at dusk');
  assert(sNight[1] < 0, 'sun under the horizon at night');
  const m = createDayCycle(); m.jump('night'); m.update(0);
  assert(m.out.moon[1] > .3 && m.out.moonUp > .9 && m.out.sunUp === 0 && m.out.stars > .99, 'moon, stars, no sun at night');
  assert(near(Math.hypot(m.out.light[0] - m.out.moon[0], m.out.light[1] - m.out.moon[1], m.out.light[2] - m.out.moon[2]), 0, 1e-9), 'night light comes from the moon');
  m.jump('day'); m.update(0); assert(m.out.sunUp > .99 && m.out.moonUp === 0 && m.out.stars === 0);
}

// ---- headlights: automatic at dusk and night, off by day and morning
{
  const at = m => lookAt(m * MINUTE).night;
  for (const m of [0, 3, 10, 20, 25, 26]) assert(!lightsEnabled(at(m)), `lights off at ${m} min`);
  for (const m of [27, 29, 31, 40, 49]) assert(lightsEnabled(at(m)), `lights on at ${m} min`);
}

// ---- showers: same seed → same schedule; 30–60 min apart, 3–8 min long; level fades in / out in ~30 s
{
  const runs = [1, 2].map(() => { const s = createShowers({ seed: 42 }), list = []; let was = false;
    for (let t = 0; t < 24 * 3600; t += 1) { s.update(1); if (s.raining !== was) { list.push(t + 1); was = s.raining; } }
    return list; });
  assert.deepEqual(runs[0], runs[1], 'deterministic'); assert(runs[0].length >= 2 * 20, `showers in a day: ${runs[0].length / 2}`);
  const other = createShowers({ seed: 7 }); other.update(WEATHER.gap[1] * MINUTE); assert.notDeepEqual(other.next, createShowers({ seed: 42 }).next, 'a different seed differs');
  for (let i = 0; i + 1 < runs[0].length; i += 2) {
    const len = runs[0][i + 1] - runs[0][i]; assert(len >= 3 * MINUTE - 1 && len <= 8 * MINUTE + 1, `shower length ${len}`);
    const gap = i ? runs[0][i] - runs[0][i - 1] : runs[0][0]; assert(gap >= 30 * MINUTE - 1 && gap <= 60 * MINUTE + 1, `gap ${gap}`);
  }
  // the cycle's rain level follows the schedule with a 30 s fade
  const c = createDayCycle({ seed: 42 }), start = c.showers.next.start;
  c.update(0); assert.equal(c.rain, 0);
  for (let t = 0; t < start; t += .25) c.update(.25);
  assert(c.raining && c.rain < .05, 'shower begins');
  for (let t = 0; t < 15; t += .25) c.update(.25);
  assert(near(c.rain, .5, .02), `half way after 15 s: ${c.rain}`);
  for (let t = 0; t < 16; t += .25) c.update(.25);
  assert.equal(c.rain, 1); const full = c.out.look;
  assert(near(full.wetness, .8), 'full shower wetness = rain preset');
  // a full shower at midday is exactly Valley rain (sky, fog, light, ground, fog distance, wetness)
  const r = rainOver(lookAt(15 * MINUTE), 1, makeLook()); sameLook(r, { ...preset('rain'), night: 0 }, 1e-9); assert(near(r.wetness, preset('rain').wetness));
  // at night the rain stays dark
  const rn = rainOver(lookAt(40 * MINUTE), 1, makeLook()); assert(rn.sky[0] + rn.sky[1] + rn.sky[2] < .1 && rn.night === 1);
  // weather choice: Always rain / Always clear show at once
  c.set({ weather: 'clear' }); assert.equal(c.rain, 0); c.set({ weather: 'rain' }); assert.equal(c.rain, 1); c.update(.1); assert.equal(c.out.rain, 1);
}

// ---- debug speed: ?daySpeed=60 → a whole cycle in 50 s
{ const c = createDayCycle({ speed: 60 }); for (let i = 0; i < 31 * 60; i++) c.update(1 / 60); assert.equal(c.phase, 'night'); assert(near(c.time, 31 * MINUTE, 1e-6), `31 s at 60× = 31 min: ${c.time}`); }

// ---- multiplayer: a guest takes the host's settings, clock and rain, eases small differences, keeps its own after
{
  const host = createDayCycle({ seed: 3 }), guest = createDayCycle({ seed: 99, settings: { cycle: false, look: 'golden', weather: 'clear' } });
  for (let i = 0; i < 600; i++) host.update(1);           // 10 min in
  guest.follow({ ...host.shared(), ...host.clock() });
  assert(guest.following && near(guest.time, host.time, .01) && guest.settings.cycle === true);
  for (let i = 0; i < 60; i++) { host.update(1); guest.update(1); }
  guest.follow({ ...host.shared(), ...host.clock(), time: host.time + 20 });      // host clock 20 s ahead
  let last = guest.time; const steps = [];
  for (let i = 0; i < 120; i++) { guest.update(1 / 60); steps.push(guest.time - last); last = guest.time; }
  assert(Math.max(...steps) < .25, 'eases toward the host clock, no jump'); assert(guest.time > host.time + 1, 'catching up');
  for (let i = 0; i < 60 * 30; i++) guest.update(1 / 60);
  for (let i = 0; i < 32; i++) host.update(1);
  assert(near(guest.time, host.time + 20, .5), `caught up: ${guest.time} vs ${host.time + 20}`);
  // the host's shower: guest rain follows raining, not its own schedule
  guest.follow({ ...host.shared(), raining: true, rain: 1 }); assert.equal(guest.rain, 1);
  guest.follow({ ...host.shared(), raining: false }); for (let i = 0; i < 40; i++) guest.update(1); assert.equal(guest.rain, 0);
  // an older host sends only a preset: that fixed look
  guest.follow({ preset: 'night' }); assert.equal(guest.settings.cycle, false); assert.equal(guest.settings.look, 'night');
  guest.unfollow(); assert.deepEqual(guest.settings, { cycle: false, look: 'golden', weather: 'clear' }); assert(!guest.following);
  // a jump on the host changes what it shares (sent at once)
  const before = JSON.stringify(host.shared()); host.jump('night'); assert.notEqual(JSON.stringify(host.shared()), before);
}

// ---- atmosphere.js: saved settings, migration, fresh loads start at morning, the scene keeps the same objects
{
  const store = init => { const m = new Map(Object.entries(init)); return { map: m, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
  assert.deepEqual(loadAtmosphereSettings(store({})), { cycle: true, look: 'midday', weather: 'random' });
  assert.deepEqual(loadAtmosphereSettings(store({ 'yr-atmosphere-1': 'midday' })), { cycle: true, look: 'midday', weather: 'random' }, 'old default → cycle on');
  assert.deepEqual(loadAtmosphereSettings(store({ 'yr-atmosphere-1': 'dusk' })), { cycle: false, look: 'dusk', weather: 'random' }, 'old pick → cycle off + that look');
  assert.deepEqual(loadAtmosphereSettings(store({ 'yr-atmosphere-1': 'dusk', 'yr-atmo-2': '{"cycle":true,"look":"rain","weather":"clear"}' })), { cycle: true, look: 'rain', weather: 'clear' });
  assert.deepEqual(loadAtmosphereSettings(store({ 'yr-atmo-2': '{bad json' })), { cycle: true, look: 'midday', weather: 'random' });
  assert.deepEqual(loadAtmosphereSettings(store({ 'yr-atmo-2': '{"cycle":"yes","look":"mars","weather":7}' })), { cycle: true, look: 'midday', weather: 'random' });

  const scene = new THREE.Scene(); scene.background = new THREE.Color(); scene.fog = new THREE.Fog(0, 1, 2);
  scene.add(new THREE.HemisphereLight()); const sun = new THREE.DirectionalLight(); scene.add(sun);
  const dir = new THREE.Vector3(); let night = -1, wet = -1, nightCalls = 0;
  const storage = store({ 'yr-atmo-2': '{"cycle":true,"look":"midday","weather":"random"}' });
  const camera = new THREE.PerspectiveCamera(); camera.position.set(100, 50, -300);
  const a = createAtmosphere({ scene, sun, sunDirection: dir, world: { setNight: n => { night = n; nightCalls++; }, setWetness: w => wet = w }, storage, seed: 5 });
  assert.equal(a.phase, 'morning'); assert.equal(a.time, 0, 'a fresh load starts at morning');
  assert(near(scene.fog.far, preset('morning').far) && near(scene.fog.near, preset('morning').near));
  const fog = scene.fog, objects = [], lights = () => { let n = 0; scene.traverse(o => { if (o.isLight) n++; }); return n; };
  scene.traverse(o => objects.push(o)); const lightCount = lights();
  a.speed = 60; let frames = 0, ms = 0, sawNight = false, sawRain = false, maxStep = 0, lastFar = scene.fog.far;
  const onAt = [];
  for (let f = 0; f < 60 * 75; f++) {                // 75 s at 60 fps and 60× = 1.5 cycles
    const t0 = performance.now(); a.update(1 / 60, camera); ms += performance.now() - t0; frames++;
    maxStep = Math.max(maxStep, Math.abs(scene.fog.far - lastFar)); lastFar = scene.fog.far;
    if (a.phase === 'night' && a.night === 1) sawNight = true; if (a.rain > 0) sawRain = true;
    if (!onAt.length && lightsEnabled(a.night)) onAt.push(a.phase);
    assert(near(dir.length(), 1, 1e-9));
  }
  assert(sawNight); assert.equal(onAt[0], 'dusk', 'headlights come on at dusk');
  const per = ms / frames;
  console.log(`atmosphere.update: ${(per * 1000).toFixed(1)} µs/frame over ${frames} frames at 60× (budget 500 µs); world.setNight calls ${nightCalls}; rain seen ${sawRain}`);
  assert(per < .5, `per-frame cost ${per} ms`);
  assert(maxStep < 60, `fog far step per frame at 60×: ${maxStep}`);
  assert.equal(scene.fog, fog, 'same fog object'); assert(scene.fog.isFog && !scene.fog.isFogExp2, 'linear fog kept');
  const after = []; scene.traverse(o => after.push(o)); assert.deepEqual(after, objects, 'no object added or removed over time'); assert.equal(lights(), lightCount, 'light count unchanged');
  assert(nightCalls < 300, 'world.setNight only in 1% steps');
  // settings
  a.set({ weather: 'rain' }); assert.equal(a.rain, 1); assert(scene.getObjectByName('nearby-rain').visible);
  for (let i = 0; i < 8 * 60; i++) a.update(1 / 60, camera);
  assert(near(wet, 1), 'road moisture rises gradually to fully wet');
  assert.deepEqual(JSON.parse(storage.map.get('yr-atmo-2')), { cycle: true, look: 'midday', weather: 'rain' });
  a.jump('night'); a.update(0, camera); assert.equal(a.phase, 'night'); assert(scene.getObjectByName('night-stars').visible === false || a.rain === 1);
  a.set({ weather: 'clear' }); a.update(0, camera); assert(scene.getObjectByName('night-stars').visible); assert(scene.getObjectByName('sky-moon').visible);
  assert(!scene.getObjectByName('sky-sun').visible);
  a.jump('day'); a.update(0, camera); assert(scene.getObjectByName('sky-sun').visible && !scene.getObjectByName('sky-moon').visible);
  const sunMesh = scene.getObjectByName('sky-sun'); assert(near(sunMesh.position.distanceTo(camera.position), 1500, 1e-6));
  // compatibility: setPreset = cycle off + that look, exactly as before
  assert(a.setPreset('golden')); assert.equal(a.preset, 'golden'); assert.equal(a.settings.cycle, false);
  a.update(5, camera); assert(near(scene.fog.far, preset('golden').far)); assert(!sunMesh.visible, 'fixed looks draw no sun disc');
  assert(near(dir.x, new THREE.Vector3(...preset('golden').direction).normalize().x));
  let calls = 0; const off = a.onChange(() => calls++); a.jump('dusk'); a.set({ cycle: true }); off(); a.jump('day'); assert.equal(calls, 2);
  a.dispose(); for (const n of ['night-stars', 'sky-sun', 'sky-moon', 'sky-sun-halo', 'nearby-rain']) assert(!scene.getObjectByName(n));
}
console.log('PASS daynight: 50-min clock + phases + jumps, keyframe looks exact at keys, smooth blending (no jumps) incl. wrap, sun/moon/light paths, headlights at dusk, deterministic 30–60 min / 3–8 min showers with 30 s fade, rain = Valley rain at midday and dark at night, daySpeed, multiplayer follow/ease/unfollow, saved settings + migration, fresh load at morning, no objects/lights/fog changes over time, per-frame cost');
