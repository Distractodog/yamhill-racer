// Full map (M) zoom / pan gestures, run inside the page, with per-frame timings. Used by tools/map_lag_test.mjs
// (the real game, through puppeteer) and tools/map_lag_bench.html (only the map, for argus browse).
// mapGestures is passed to page.evaluate as source text: it must not use anything from this module's scope.
//   const result = await mapGestures({ scale: 1 });   // scale: gesture durations ×scale (pans: 1 s × scale)
// Needs window.game.minimap (or window.__mapBench.minimap) already open (#fullmap.open), and its update() called
// every frame by someone (the game loop, or the bench page). Events are dispatched like a mouse / trackpad would:
// several per frame, between frames (wheel notches every 25 ms, pointer moves every 8 ms, pinch wheels every 6 ms).
// Per frame: the time between frames, map main-thread ms (minimap.update + the event handlers run since the last
// frame), the whole frame's main-thread ms (every requestAnimationFrame callback: in the game its 3D render too, plus
// the handlers), and what ran: drawImage of a big picture (≥ 4096 px), other drawImage, path fills / strokes, text,
// createImageBitmap calls.
export async function mapGestures({ scale = 1, phases = null } = {}) {
  const host = window.game || window.__mapBench, minimap = host.minimap, canvas = document.querySelector('#fullmap canvas');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const M = window.__mapLag ||= { frame: null, log: null, handlers: 0 };
  if (!M.ready) {
    M.ready = true;
    const update = minimap.update;
    minimap.update = function (...a) { const t = performance.now(); try { return update.apply(this, a); } finally { if (M.frame) M.frame.update += performance.now() - t; } };
    const proto = CanvasRenderingContext2D.prototype, big = s => (s?.width || 0) >= 4096 || (s?.naturalWidth || 0) >= 4096;
    const wrap = (name, kind) => {
      const f = proto[name];
      proto[name] = function (...a) {
        const t = performance.now(); try { return f.apply(this, a); } finally {
          const fr = M.frame; if (fr) { const k = kind === 'image' && big(a[0]) ? 'bigImage' : kind; fr[k] = (fr[k] || 0) + performance.now() - t; fr[k + 'N'] = (fr[k + 'N'] || 0) + 1; }
        }
      };
    };
    wrap('drawImage', 'image'); for (const n of ['stroke', 'fill', 'fillRect']) wrap(n, 'path'); for (const n of ['fillText', 'strokeText', 'measureText']) wrap(n, 'text');
    const cib = window.createImageBitmap;
    if (cib) window.createImageBitmap = function (...a) { if (M.frame) M.frame.bitmaps = (M.frame.bitmaps || 0) + 1; return cib.apply(this, a); };
    const raf = window.requestAnimationFrame.bind(window);
    // every other frame callback (the game's whole frame: 3D render included) is timed too
    window.requestAnimationFrame = cb => raf(t => { const s = performance.now(); try { cb(t); } finally { if (M.frame) M.frame.others = (M.frame.others || 0) + performance.now() - s; } });
    let last = 0;
    const tick = t => {                   // the frame record: its interval is known when the next frame starts
      if (M.frame && last) { M.frame.interval = t - last; M.log?.push(M.frame); }
      last = t; M.frame = { update: 0, handlers: M.handlers }; M.handlers = 0; raf(tick);
    };
    raf(tick);
  }
  // synthetic pointers have no real press behind them: a capture that throws must not stop the map's own handler
  if (!Object.hasOwn(canvas, 'setPointerCapture')) {
    const capture = canvas.setPointerCapture;
    canvas.setPointerCapture = function (id) { try { capture.call(this, id); } catch {} };
  }
  // events: time spent in their handlers goes to the frame they ran before
  const send = ev => { const t = performance.now(); canvas.dispatchEvent(ev); M.handlers += performance.now() - t; };
  const box = () => canvas.getBoundingClientRect();
  const at = (fx, fy) => { const r = box(); return [r.left + r.width * fx, r.top + r.height * fy]; };
  const wheel = (x, y, deltaY, ctrlKey = false) => send(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY, deltaMode: 0, ctrlKey, bubbles: true, cancelable: true }));
  const pointer = (type, x, y, buttons) => send(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  const fit = () => document.querySelector('#fullmap [data-z="fit"]').click();
  // zoom (not measured) to about z, around canvas point (fx, fy), then let the map settle
  async function zoomTo(z, fx = .5, fy = .5) {
    fit(); await sleep(50);
    const [x, y] = at(fx, fy);
    for (let i = 0; i < 60 && minimap.zoom < z * .93; i++) { wheel(x, y, -Math.min(400, Math.log(z / minimap.zoom) / .0018)); await sleep(20); }
    await sleep(700);
  }
  async function notches(n, dy, fx, fy, every = 25) { const [x, y] = at(fx, fy); for (let i = 0; i < n; i++) { wheel(x, y, dy); await sleep(every); } }
  async function pan(ms) {            // press, move round a circle (both directions of travel), release
    const [cx, cy] = at(.5, .5), R = Math.min(box().width, box().height) * .22, t0 = performance.now();
    pointer('pointerdown', cx, cy, 1);
    let t = 0;
    while ((t = performance.now() - t0) < ms) {
      const a = t / 1000 * 2.2;      // ~ 1.3 R per second along the circle
      pointer('pointermove', cx + R * Math.sin(a) * 1.4, cy + R * (1 - Math.cos(a)) * .8, 1); await sleep(8);
    }
    pointer('pointerup', cx, cy, 0);
  }
  async function pinch(ms) {          // trackpad pinch: ctrl + small wheel deltas, in then out
    const [x, y] = at(.45, .55), t0 = performance.now();
    let t = 0;
    while ((t = performance.now() - t0) < ms) { wheel(x, y, t < ms / 2 ? -6 : 6, true); await sleep(6); }
  }
  const list = [
    ['zoom in 20 notches', async () => { fit(); await sleep(400); M.log = []; await notches(20, -100, .55, .45); }],
    ['zoom out 20 notches', async () => { M.log = []; await notches(20, 100, .4, .6); }],
    ['pan @zoom 1.6', async () => { await zoomTo(1.6); M.log = []; await pan(1000 * scale); }],
    ['pan @zoom 4', async () => { await zoomTo(4, .55, .45); M.log = []; await pan(1000 * scale); }],
    ['pan @zoom 30', async () => { await zoomTo(30, .55, .45); M.log = []; await pan(1000 * scale); }],
    ['pan @zoom 200', async () => { await zoomTo(200, .55, .45); M.log = []; await pan(1000 * scale); }],
    ['pinch zoom @4', async () => { await zoomTo(4, .55, .45); M.log = []; await pinch(1000 * scale); }],
    ['pinch zoom @60', async () => { await zoomTo(60, .55, .45); M.log = []; await pinch(1000 * scale); }],
  ].filter(([name]) => !phases || phases.some(p => name.includes(p)));
  const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0;
  const out = [];
  for (const [name, run] of list) {
    await run(); await sleep(60);    // the gesture's last frames
    const f = M.log.filter(x => x.interval > 0); M.log = null;
    const main = f.map(x => x.update + x.handlers).sort((a, b) => a - b), iv = f.map(x => x.interval).sort((a, b) => a - b);
    const whole = f.map(x => (x.others || 0) + x.handlers).sort((a, b) => a - b);
    const sum = k => f.reduce((a, x) => a + (x[k] || 0), 0), per = k => sum(k) / (f.length || 1);
    out.push({ name, frames: f.length, mainMedian: pct(main, .5), mainP95: pct(main, .95), mainWorst: main.at(-1) || 0,
      frameMedian: pct(whole, .5), frameP95: pct(whole, .95), frameWorst: whole.at(-1) || 0,
      median: pct(iv, .5), p95: pct(iv, .95), worst: iv.at(-1) || 0, over16: 100 * iv.filter(x => x > 16.7).length / (iv.length || 1),
      over8main: 100 * main.filter(x => x > 8).length / (main.length || 1),
      bigImageMs: per('bigImage'), bigImageN: sum('bigImageN'), imageMs: per('image'), imageN: per('imageN'), pathMs: per('path'), pathN: per('pathN'),
      textMs: per('text'), bitmaps: sum('bitmaps'), handlersMs: per('handlers'), zoom: minimap.zoom });
  }
  return out;
}
