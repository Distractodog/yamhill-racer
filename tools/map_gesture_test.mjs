// The full map's gestures in Node: the real game/src/minimap.js under a fake DOM (2D calls ignored) with a controlled
// clock and devicePixelRatio 2. A wheel notch eases (no jump; the point under the cursor stays put), moving frames draw
// at pixel ratio 1 and the still view at 2 again, a drag follows the pointer exactly through that switch, a trackpad
// pinch (ctrlKey) zooms at once, `busy` ends 300 ms after the last input. The browser timings: tools/map_lag_test.mjs.
//   node tools/map_gesture_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
const ROOT = new URL('..', import.meta.url).pathname;
const meta = JSON.parse(fs.readFileSync(ROOT + 'game/assets/minimap.json', 'utf8'));
const world = JSON.parse(fs.readFileSync(ROOT + 'game/assets/world.json', 'utf8'));
let clock = 1000;
Object.defineProperty(globalThis, 'performance', { value: { now: () => clock }, configurable: true });
globalThis.devicePixelRatio = 2;
const CSS_W = 1200, CSS_H = 700;
const canvases = [];
const fakeCtx = canvas => new Proxy({ canvas }, { get(t, k) { if (k in t) return t[k]; if (k === 'measureText') return () => ({ width: 10 }); return () => {}; }, set(t, k, v) { t[k] = v; return true; } });
function el(tag = 'div') {
  const kids = new Map(), listeners = {};
  const e = { tag, style: {}, dataset: {}, hidden: false, disabled: false, textContent: '', innerHTML: '', width: 300, height: 150,
    classList: { set: new Set(), toggle(c, v) { (v ?? !this.set.has(c)) ? this.set.add(c) : this.set.delete(c); }, add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
    listeners, addEventListener(t, f) { (listeners[t] ||= []).push(f); }, dispatch(t, ev) { for (const f of listeners[t] || []) f(ev); },
    insertAdjacentHTML() {}, append() {}, setAttribute() {}, setPointerCapture() {}, remove() {},
    querySelector(sel) { if (!kids.has(sel)) kids.set(sel, el(sel === 'canvas' ? 'canvas' : 'div')); return kids.get(sel); },
    querySelectorAll() { return []; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: CSS_W, height: CSS_H }),
    get clientWidth() { return CSS_W; }, get clientHeight() { return CSS_H; } };
  if (tag === 'canvas') { const c = fakeCtx(e); e.getContext = () => c; canvases.push(e); }
  return e;
}
globalThis.document = { createElement: el, head: el(), body: el() };
globalThis.addEventListener = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {} };
URL.createObjectURL = () => 'blob:x';
globalThis.Image = class { constructor() { this.width = meta.size[0]; this.height = meta.size[1]; this.naturalWidth = this.width; this.naturalHeight = this.height; } decode() { return Promise.resolve(); } };
globalThis.fetch = async url => ({ ok: true, json: async () => url.endsWith('minimap.json') ? meta : world, blob: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) });
const { createMinimap } = await import(ROOT + 'game/src/minimap.js');
const m = await createMinimap('./assets/');
const fc = canvases.find(c => c.listeners.wheel);
m.toggle(true);
const frame = (ms = 1000 / 60) => { clock += ms; m.update(-542, 440, 0, 0, ms / 1000); };
const ev = (x, y, more = {}) => ({ clientX: x, clientY: y, preventDefault() {}, button: 0, pointerId: 1, deltaMode: 0, ...more });
for (let i = 0; i < 5; i++) frame();
assert.equal(fc.width, CSS_W * 2, 'still: full ratio');
assert(!m.busy && !m.moving);
// 1) wheel notch eases, anchored at the cursor
const z0 = m.zoom;
fc.dispatch('wheel', ev(900, 200, { deltaY: -100 }));
assert.equal(m.zoom, z0, 'a notch does not jump');
assert(m.targetZoom > z0 && m.busy, 'goal set, busy');
let t = 0, sawLow = false;
while (Math.abs(Math.log(m.targetZoom / m.zoom)) > 1e-9 && t < 1000) { frame(); t += 1000 / 60; if (fc.width === CSS_W) sawLow = true; }
console.log(`notch eased ${z0} → ${m.zoom.toFixed(4)} in ${t.toFixed(0)} ms (goal ${m.targetZoom.toFixed(4)})`);
assert(t <= 260, 'eases within ~250 ms');
assert(sawLow, 'moving frames at ratio 1');
for (let i = 0; i < 12; i++) frame();
assert.equal(fc.width, CSS_W * 2, 'settled: full ratio again');
assert(!m.moving);
for (let i = 0; i < 12; i++) frame();
assert(!m.busy, 'quiet 300 ms after');
// probe: the world point under a CSS point, through the spawn picker's click
let picked = null; m.pickSpawn((x, z) => { picked = [x, z]; });
const probe = (x, y) => { picked = null; fc.dispatch('pointerdown', ev(x, y, { pointerId: 9 })); fc.dispatch('pointerup', ev(x, y, { pointerId: 9 })); return picked; };
{ // anchoring: the world point under the cursor stays put through the ease (zoomed in first: no edge clamping)
  for (let i = 0; i < 6; i++) fc.dispatch('wheel', ev(600, 350, { deltaY: -100 }));
  for (let i = 0; i < 40; i++) frame();
  const p0 = probe(700, 300);
  fc.dispatch('wheel', ev(700, 300, { deltaY: -100 }));
  let worst = 0;
  for (let i = 0; i < 30; i++) { frame(); const p = probe(700, 300); worst = Math.max(worst, Math.hypot(p[0] - p0[0], p[1] - p0[1])); }
  console.log('zoom ' + m.zoom.toFixed(2) + ': the point under the cursor moved at most ' + worst.toExponential(2) + ' m during the ease');
  assert(worst < 1e-6);
}
{ // drag across the ratio switch: the picture follows the pointer exactly
  for (let i = 0; i < 30; i++) frame();
  assert.equal(fc.width, CSS_W * 2);
  const a0 = probe(300, 350);
  fc.dispatch('pointerdown', ev(600, 350));
  let x = 600;
  for (let i = 0; i < 20; i++) { x += 5; fc.dispatch('pointermove', ev(x, 350)); frame(); }
  assert.equal(fc.width, CSS_W, 'dragging: ratio 1');
  fc.dispatch('pointerup', ev(x, 350));
  const a1 = probe(400, 350);       // what was under 300 is now under 400
  const off = Math.hypot(a1[0] - a0[0], a1[1] - a0[1]);
  console.log('drag 100 CSS px across the ratio switch: picture point off by ' + off.toExponential(2) + ' m');
  assert(off < 1e-6, 'drag follows the pointer');
  for (let i = 0; i < 30; i++) frame();
  assert.equal(fc.width, CSS_W * 2, 'settled: full ratio');
  assert(!m.busy);
}
{ // trackpad pinch: at once
  const z = m.zoom;
  fc.dispatch('wheel', ev(600, 350, { deltaY: -6, ctrlKey: true }));
  assert(m.zoom > z && m.targetZoom === m.zoom, 'pinch zooms at once');
}
console.log('PASS: wheel notch eases around the cursor, moving at pixel ratio 1 then sharp at 2, drag exact through the switch, pinch at once, busy ends after 300 ms');
