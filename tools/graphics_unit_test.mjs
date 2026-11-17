// Settings → Graphics in Node: graphics.js (levels, Auto's pick, the fps meter, saved settings) and graphicsapply.js on
// real three.js lights / camera / fog with a stand-in renderer, world and effects; Effects' particle cap and the props'
// radius. node tools/graphics_unit_test.mjs  (the browser run is tools/graphics_test.mjs)
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GRAPHICS, GRAPHICS_KEY, LEVELS, autoPick, cleanGraphics, createFpsMeter, graphicsFor, hardwareGuess, loadGraphics, saveGraphics } from '../game/src/graphics.js';
import { createGraphics } from '../game/src/graphicsapply.js';
import { bindGraphicsSettings } from '../game/src/graphicsui.js';
import { Effects, FX_CAPS } from '../game/src/effects.js';
import { showProps, PROP_R } from '../game/src/propsmodel.js';

let checks = 0;
const ok = (cond, msg) => { assert(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// ---- levels: High is the game as it was (main.js / world.js before the setting); Medium and Low cut down
for (const dpr of [1, 1.25, 2, 3]) {
  eq(graphicsFor('high', { dpr }).pixelRatio, Math.min(dpr, 1.5), `high pixel ratio at dpr ${dpr}`);
  eq(graphicsFor('medium', { dpr }).pixelRatio, Math.min(dpr, 1.25), `medium pixel ratio at dpr ${dpr}`);
  eq(graphicsFor('low', { dpr }).pixelRatio, 1, `low pixel ratio at dpr ${dpr}`);
  eq(graphicsFor('low', { dpr, weak: true }).pixelRatio, 0.85, `weak low pixel ratio at dpr ${dpr}`);
  eq(graphicsFor('high', { dpr, weak: true }).pixelRatio, Math.min(dpr, 1.5), 'weak only changes Low');
}
const H = GRAPHICS.high, M = GRAPHICS.medium, L = GRAPHICS.low;
eq([H.view, H.load, H.terrain, H.treeNear, H.treeFar, H.props, H.scenery, H.campusItems, H.townNear, H.townFar, H.campusNear, H.shadow, H.water, H.particles],
  [1, 1, 1, 420, Infinity, 1, 1, 1, 1, 1, 250, 2048, true, 900], 'High = today');
eq([M.view, M.shadow, M.load, M.pixelCap], [0.8, 1024, 1, 1.25], 'Medium: view ×0.8, smaller shadow map, same load radius, pixel ratio ≤ 1.25');
eq([H.headlights, M.headlights], [{ range: 1, power: 1 }, { range: 1, power: 1 }], 'headlights: full beam on High and Medium');
ok(L.headlights.range < 1 && L.headlights.range >= 0.75 && L.headlights.power < 1 && L.headlights.power >= 0.85, 'Low: a slightly shorter, dimmer beam, never off');
ok(M.treeNear < H.treeNear, 'Medium: far tree level closer');
eq([L.view, L.shadow, L.water, L.treeFar], [0.6, 0, false, 600], 'Low: view ×0.6, no shadows, still water, no trees past 600 m');
ok(L.load < 1 && L.props < 1 && L.scenery < 1 && L.campusItems < 1 && L.particles < H.particles, 'Low: smaller load radius, near-only props, fewer particles');
eq(graphicsFor('nonsense').level, 'high', 'unknown level → High');

// ---- Auto: hardware guess, then the measured pick
eq(hardwareGuess({ cores: 2 }), 'low'); eq(hardwareGuess({ cores: 4 }), 'medium'); eq(hardwareGuess({ cores: 8 }), 'high');
eq(hardwareGuess({ cores: 0 }), 'high', 'unknown cores: High'); eq(hardwareGuess({ cores: 8, mobile: true }), 'medium', 'phone: Medium');
const pick = (level, fps, extra = {}) => autoPick({ level, fps, ...extra });
eq(pick('high', 60), { level: 'high', weak: false }, 'smooth on High stays');
eq(pick('high', 52), { level: 'high', weak: false }, 'a little under 60 stays');
eq(pick('high', 40), { level: 'medium', weak: false }, 'slow on High → Medium');
eq(pick('high', 26), { level: 'low', weak: false }, 'far too slow → Low');
eq(pick('high', 20), { level: 'low', weak: true }, 'very weak → Low at 0.85');
eq(pick('medium', 40), { level: 'low', weak: false });
eq(pick('medium', 60), { level: 'high', weak: false }, 'smooth on Medium → High');
eq(pick('medium', 60, { mobile: true }), { level: 'medium', weak: false }, 'a phone does not step up');
eq(pick('low', 60), { level: 'medium', weak: false });
eq(pick('low', 35, { cores: 2 }), { level: 'low', weak: true }, 'two cores on Low: weak');
eq(pick('low', 120), { level: 'medium', weak: false }, 'one step up at a time');
eq(pick(undefined, NaN, { cores: 4 }), { level: 'medium', weak: false }, 'nothing measured: the guess');

// ---- fps meter: only real play frames, gaps left out, median
{
  const m = createFpsMeter({ seconds: 5 });
  ok(!m.add(300) && !m.add(-1) && !m.add(NaN) && m.seconds === 0, 'gaps and bad intervals left out');
  let done = false, n = 0;
  while (!done) { done = m.add(n++ % 10 === 9 ? 100 : 20); }
  ok(m.done && m.seconds >= 5, 'done after 5 s');
  const r = m.result();
  eq(Math.round(r.fps), 50, 'median of 20 ms frames with spikes = 50 fps'); ok(r.p90 >= 20, 'p90');
}

// ---- saved settings
const memory = (init = {}) => { const s = new Map(Object.entries(init)); return { getItem: k => s.has(k) ? s.get(k) : null, setItem: (k, v) => s.set(k, String(v)), map: s }; };
eq(cleanGraphics(null), { mode: 'auto', auto: null }, 'default Auto');
eq(cleanGraphics({ mode: 'ultra', auto: { level: 'epic' } }), { mode: 'auto', auto: null }, 'unknown values dropped');
eq(cleanGraphics({ mode: 'low', auto: { level: 'medium', weak: 'yes', fps: 41.6 } }), { mode: 'low', auto: { level: 'medium', weak: false, fps: 42 } });
eq(loadGraphics(memory({ [GRAPHICS_KEY]: '{bad json' })), { mode: 'auto', auto: null }, 'broken JSON → default');
eq(loadGraphics({ getItem() { throw Error('blocked'); } }), { mode: 'auto', auto: null }, 'blocked storage → default');
{ const s = memory(); saveGraphics(s, { mode: 'medium', auto: null }); eq(JSON.parse(s.map.get(GRAPHICS_KEY)), { mode: 'medium', auto: null }); }

// ---- applying a level: renderer, sun, camera, fog, world, effects, all in one call
function rig(storage = memory(), env = { dpr: 2, cores: 8, mobile: false }) {
  const renderer = { ratio: Math.min(2, 1.5), sets: 0, getPixelRatio() { return this.ratio; }, setPixelRatio(r) { this.ratio = r; this.sets++; }, shadowMap: { enabled: true } };
  const scene = new THREE.Scene(); scene.fog = new THREE.Fog(0xffffff, 250, 1500);
  const camera = new THREE.PerspectiveCamera(70, 1.6, 0.3, 2200);
  const sun = new THREE.DirectionalLight(); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  let disposed = 0; sun.shadow.map = { dispose: () => disposed++ };
  const world = { calls: [], setDetail(d) { this.calls.push(d); } };
  const effects = { caps: [], setCaps(caps) { this.caps.push(caps); } };
  const lights = { calls: [], setDetail(d) { this.calls.push(d); } };
  const g = createGraphics({ renderer, scene, camera, sun, storage, env });
  g.attach({ world, effects, lights });
  const atmosphere = (near = 250, far = 1500) => { scene.fog.near = near; scene.fog.far = far; };   // atmosphere.js, every frame
  return { g, renderer, scene, camera, sun, world, effects, lights, storage, atmosphere, disposed: () => disposed };
}
{
  const r = rig(memory({ [GRAPHICS_KEY]: JSON.stringify({ mode: 'high' }) }));
  eq([r.g.mode, r.g.level, r.renderer.ratio, r.renderer.sets, r.renderer.shadowMap.enabled, r.sun.castShadow, r.sun.shadow.mapSize.x, r.camera.far],
    ['high', 'high', 1.5, 0, true, true, 2048, 2200], 'High leaves the renderer, sun and camera as they were');
  r.atmosphere(); r.g.frame(1 / 60); eq([r.scene.fog.near, r.scene.fog.far], [250, 1500], 'High: fog untouched');
  eq(r.world.calls.at(-1).treeNear, 420); eq(r.effects.caps.at(-1), FX_CAPS);
  ok(!r.g.measuring, 'a chosen level measures nothing');

  const before = r.world.calls.length;
  r.g.set('low');
  eq([r.renderer.ratio, r.renderer.shadowMap.enabled, r.sun.castShadow, r.camera.far], [1, false, false, 1600], 'Low: ratio 1, no shadows, near camera far');
  eq(r.world.calls.length, before + 1, 'one world change per switch');
  const d = r.world.calls.at(-1);
  eq([d.load, d.treeFar, d.shadows, d.water], [0.7, 600, false, false]); eq(r.effects.caps.at(-1), L.effectCaps);
  eq(r.lights.calls.at(-1), { range: 0.8, power: 0.9 }, 'Low: headlight trimmed');
  eq([r.scene.fog.near, r.scene.fog.far], [150, 900], 'fog scaled at once on a switch');
  for (let i = 0; i < 3; i++) { r.g.frame(1 / 60); }
  eq([r.scene.fog.near, r.scene.fog.far], [150, 900], 'not scaled twice when the atmosphere did not set it');
  r.atmosphere(70, 850); r.g.frame(1 / 60);
  eq([r.scene.fog.near, r.scene.fog.far].map(v => Math.round(v)), [42, 510], 'a new atmosphere fog is scaled');
  eq(JSON.parse(r.storage.map.get(GRAPHICS_KEY)).mode, 'low', 'saved');

  r.g.set('medium');
  eq([r.renderer.ratio, r.renderer.shadowMap.enabled, r.sun.castShadow, r.sun.shadow.mapSize.x, r.sun.shadow.map, r.disposed()],
    [1.25, true, true, 1024, null, 1], 'Medium: ratio 1.25 on a Retina screen, shadows back on at 1024, old map freed');
  eq(r.lights.calls.at(-1), { range: 1, power: 1 }, 'Medium: full headlight');
  eq(Math.round(r.camera.far), 1760);
  r.g.set('high'); eq([r.sun.shadow.mapSize.x, r.camera.far, r.renderer.ratio], [2048, 2200, 1.5], 'back to High');
  r.atmosphere(); r.g.frame(1 / 60); eq([r.scene.fog.near, r.scene.fog.far], [250, 1500]);
  ok(!r.g.set('ultra'), 'unknown mode refused'); eq(r.g.mode, 'high');
}

// ---- Auto: hardware guess, 5 s of play, saved pick, remembered, measured again only on request
{
  const storage = memory();
  const r = rig(storage, { dpr: 2, cores: 8, mobile: false });
  eq([r.g.mode, r.g.level, r.g.measuring], ['auto', 'high', true], 'first load: Auto at the guess, measuring');
  const changes = []; r.g.onChange(() => changes.push(r.g.level));
  for (let i = 0; i < 600; i++) r.g.frame(0.025, false);
  ok(r.g.measuring && r.g.measured === 0, 'menus / spawn map / pauses are not measured');
  let frames = 0; while (r.g.measuring) { r.g.frame(0.025, true); frames++; }
  ok(frames >= 199 && frames <= 201, `about 5 s of frames (${frames})`);
  eq([r.g.level, r.g.auto], ['medium', { level: 'medium', weak: false, fps: 40 }], '40 fps on High → Medium');
  eq(changes, ['medium'], 'one change when the pick lands');
  eq(JSON.parse(storage.map.get(GRAPHICS_KEY)), { mode: 'auto', auto: { level: 'medium', weak: false, fps: 40 } }, 'pick saved');

  const again = rig(storage, { dpr: 2, cores: 8, mobile: false });
  eq([again.g.mode, again.g.level, again.g.measuring, again.renderer.ratio, again.sun.shadow.mapSize.x], ['auto', 'medium', false, 1.25, 1024], 'next load: the saved pick, no new measurement');
  again.g.set('low'); again.g.set('auto');
  eq([again.g.level, again.g.measuring], ['medium', false], 'back to Auto keeps its pick');
  again.g.remeasure();
  eq([again.g.mode, again.g.level, again.g.measuring], ['auto', 'high', true], 'Measure again: the guess, measuring');
  while (again.g.measuring) again.g.frame(0.05, true);
  eq([again.g.level, again.g.auto.weak, again.renderer.ratio], ['low', true, 0.85], '20 fps → Low at 0.85');

  const weak = rig(memory(), { dpr: 1, cores: 2, mobile: false });
  eq([weak.g.level, weak.renderer.ratio, weak.sun.castShadow], ['low', 1, false], 'two cores start on Low');
}

// ---- Effects: actual GPU pools and mark ribbons stay bounded through level changes.
{
  const fx = new Effects(new THREE.Scene(), { shadows: false });
  eq(H.effectCaps, FX_CAPS, 'High keeps current main caps');
  for (const k of Object.keys(FX_CAPS)) ok(L.effectCaps[k] < M.effectCaps[k] && M.effectCaps[k] < H.effectCaps[k], `${k}: Low < Medium < High`);
  const buffers = [fx.puffs.data, fx.chips.data, fx.marksBuf.pos], materials = fx.objects.map(o => o.material);
  for (const level of [L, M, H, L, H]) {
    fx.setCaps(level.effectCaps);
    eq([fx.puffs.cap, fx.chips.cap, fx.marksBuf.max, fx.discCap], Object.values(level.effectCaps), 'all effect limits applied');
    const trail = fx.tyres[0]?.trail;
    ok(!trail, 'old local tyre trails cleared');
    for (let i = 0; i < level.effectCaps.puffs * 2; i++) fx.puff(new THREE.Vector3(), new THREE.Vector3(), [1, 1, 1], 1, 1, 0, 2, 1, 1, 0);
    for (let i = 0; i < level.effectCaps.chips * 2; i++) fx.chips.spawn({ ...fx.O, flat: 1, ax: 0, ay: 0, wx: 0, wy: 0 }, fx.time);
    const t = { has: false };
    for (let i = 0; i <= level.effectCaps.marks * 2; i++) fx.marksBuf.add(t, i, 0, 0, .1, 1, 0, 0, 0, fx.time, 0);
    fx.advance(.016);
    ok(fx.stats().puffs <= level.effectCaps.puffs && fx.stats().chips <= level.effectCaps.chips, 'live particles bounded');
    eq(fx.marks.geometry.drawRange.count, level.effectCaps.marks * 6, 'skid ribbon length bounded');
    ok(fx.puffs.cursor < fx.puffs.cap && fx.chips.cursor < fx.chips.cap, 'emitter cursors bounded');
    eq([fx.puffs.data, fx.chips.data, fx.marksBuf.pos], buffers, 'buffers reused');
    ok(fx.objects.every((o, i) => o.material === materials[i]), 'no shader replacement');
  }
  fx.setCaps(L.effectCaps); fx.setCaps(H.effectCaps); fx.advance(.016);
  eq([fx.stats().puffs, fx.stats().chips, fx.stats().marks], [0, 0, 0], 'expanding caps never resurrects old effects');
  fx.setCaps({ puffs: NaN }); eq(fx.caps, FX_CAPS, 'invalid caps restore full limits');
  const small = new Effects(new THREE.Scene(), { shadows: false, caps: L.effectCaps });
  small.setCaps(FX_CAPS); eq(small.caps, L.effectCaps, 'constructor caps bound runtime limits');
  small.dispose(); fx.dispose();
}

// ---- props: the radius argument (Low: near only)
{
  const mesh = { instanceMatrix: { array: new Float32Array(32), needsUpdate: false }, count: 0, visible: false };
  const src = new Float32Array(32).map((_, i) => i);
  const lods = [{ x: Infinity, z: Infinity, types: [{ mesh, src, xz: new Float32Array([0, 0, 200, 0]), n: 2 }] }];
  showProps(lods, { x: 0, z: 0 }); eq(mesh.count, 2, `default radius ${PROP_R} m`);
  lods[0].x = Infinity; showProps(lods, { x: 0, z: 0 }, PROP_R * GRAPHICS.low.props); eq(mesh.count, 1, 'Low radius drops the far one');
}

// ---- Settings → Graphics section (graphicsui.js) on a stand-in DOM: four buttons, pressed state, status, Measure again
{
  const el = (tag = 'div') => ({ tag, children: [], dataset: {}, attrs: {}, listeners: {}, hidden: false, textContent: '',
    replaceChildren(...c) { this.children = c; }, append(...c) { this.children.push(...c); },
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }, click() { (this.listeners.click || []).forEach(fn => fn()); },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; } });
  const nodes = { 'graphics-modes': el(), 'graphics-status': el('p'), 'graphics-measure': el('button') };
  const doc = { getElementById: id => nodes[id] || null, createElement: el };
  const r = rig(memory({ [GRAPHICS_KEY]: JSON.stringify({ mode: 'auto', auto: { level: 'medium', weak: false, fps: 44 } }) }));
  const ui = bindGraphicsSettings(r.g, doc);
  const buttons = nodes['graphics-modes'].children, pressed = () => buttons.filter(b => b.attrs['aria-pressed'] === 'true').map(b => b.dataset.graphics);
  eq(buttons.map(b => [b.dataset.graphics, b.textContent, b.type]), [['auto', 'Auto', 'button'], ['low', 'Low', 'button'], ['medium', 'Medium', 'button'], ['high', 'High', 'button']]);
  eq(pressed(), ['auto']); ok(/Auto picked Medium \(44 fps measured\)/.test(nodes['graphics-status'].textContent), nodes['graphics-status'].textContent);
  buttons[1].click(); eq([r.g.level, pressed()], ['low', ['low']], 'a click applies at once'); ok(/^Low:/.test(nodes['graphics-status'].textContent));
  buttons[3].click(); eq([r.g.level, r.renderer.ratio, r.sun.castShadow], ['high', 1.5, true]);
  nodes['graphics-measure'].click();
  eq([r.g.mode, r.g.measuring, pressed(), nodes['graphics-measure'].hidden], ['auto', true, ['auto'], true], 'Measure again');
  ok(/Measuring while you drive/.test(nodes['graphics-status'].textContent));
  while (r.g.measuring) r.g.frame(1 / 60, true);
  ok(/Auto picked High \(60 fps measured\)/.test(nodes['graphics-status'].textContent) && !nodes['graphics-measure'].hidden, nodes['graphics-status'].textContent);
  ok(ui && bindGraphicsSettings(r.g, { getElementById: () => null }) === null, 'no section: nothing bound');
}

// ---- headlights (lights.js): Low trims reach and strength, the light stays in the scene (no recompile)
{
  const { createVehicleLights } = await import('../game/src/lights.js');
  const { buildCarModel } = await import('../game/src/carmodel.js');
  const scene = new THREE.Scene(), vl = createVehicleLights(scene), mesh = buildCarModel();
  const car = { kind: 'car', mesh, grounded: true };
  for (let i = 0; i < 200; i++) vl.update(1 / 30, car, 1);
  const full = { distance: vl.spot.distance, intensity: vl.spot.intensity };
  ok(full.intensity > 0 && full.distance > 0, 'beam on at night');
  vl.setDetail({ range: 0.8, power: 0.9 }); vl.update(1 / 30, car, 1);
  ok(Math.abs(vl.spot.distance - full.distance * 0.8) < 1e-9 && Math.abs(vl.spot.intensity - full.intensity * 0.9) < 1e-6, 'Low beam: 80% reach, 90% strength');
  ok(scene.getObjectByName('player-headlight') === vl.spot, 'the light stays in the scene');
  vl.setDetail({ range: 1, power: 1 }); vl.update(1 / 30, car, 1);
  ok(vl.spot.distance === full.distance && Math.abs(vl.spot.intensity - full.intensity) < 1e-6, 'back to the full beam');
  vl.setDetail({ range: NaN, power: -1 }); ok(vl.spot.distance === full.distance, 'bad values: full beam');
}

console.log(`PASS graphics_unit_test: ${checks} checks (levels, Auto pick, fps meter, storage ${GRAPHICS_KEY}, applying levels, particle cap, prop radius; ${LEVELS.join('/')})`);
