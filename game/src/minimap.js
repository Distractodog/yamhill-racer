// Map: a small north-up corner map that follows the car, and a full map of the whole area (M, or click it).
// The full map zooms (scroll / pinch / + − / double-click, around the pointer) and pans (drag).
// The picture is baked by tools/build_minimap.py (ground colours + roads, trails, buildings, ponds).
const LABELS = [
  { name: 'Delphian', x: -560, z: 60 },
  { name: 'Willamina', x: -3640, z: 3330 },
  { name: 'Sheridan', x: 3800, z: 1400 },
  { name: 'Bellevue', x: 11860, z: -2110 },
  { name: 'McMinnville', x: 19100, z: -11000 },
];

export async function createMinimap(base = './assets/') {
  const meta = await fetch(base + 'minimap.json').then(r => r.json());
  const img = new Image();
  img.src = base + 'minimap.jpg';
  await img.decode();
  const [ex0, ez0] = meta.extent, mpp = meta.mpp;
  const toPx = (x, z) => [(x - ex0) / mpp, (z - ez0) / mpp];   // world metres → map image pixels

  const corner = document.createElement('div');
  corner.id = 'minimap';
  corner.title = 'Full map (M)';
  corner.innerHTML = '<canvas></canvas><button aria-label="Open full map">⤢</button><span class="mm-n">N</span>';
  const full = document.createElement('div');
  full.id = 'fullmap';
  full.innerHTML = '<canvas></canvas><div class="fm-hint">Scroll or + − to zoom · drag to move · M or Esc to close</div>' +
    '<div class="fm-zoom"><button data-z="in" title="Zoom in (+)">+</button><button data-z="out" title="Zoom out (−)">−</button>' +
    '<button data-z="fit" title="Whole map (0)">⤢</button><button data-z="car" title="Centre on car">◎</button>' +
    '<button data-z="close" title="Close (M)">✕</button></div>';
  const css = document.createElement('style');
  css.textContent = `#fullmap { cursor: default; } #fullmap canvas { cursor: grab; touch-action: none; }
    #fullmap canvas.drag { cursor: grabbing; }
    #fullmap .fm-zoom { position: absolute; right: calc(3vw + 12px); top: calc(3vh + 12px); display: flex; flex-direction: column; gap: 6px; }
    #fullmap .fm-zoom button { width: 36px; height: 36px; border: 0; border-radius: 9px; background: #000b; color: #fff;
      font: 700 20px/1 system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 8px #0005; }
    #fullmap .fm-zoom button:hover { background: #000e; }
    #fullmap .fm-zoom button:disabled { opacity: .35; cursor: default; }
    #fullmap .fm-zoom button[data-z="close"] { margin-top: 8px; font-size: 16px; }`;
  document.head.append(css);
  document.body.append(corner, full);
  const cc = corner.querySelector('canvas'), fc = full.querySelector('canvas');
  const cctx = cc.getContext('2d'), fctx = fc.getContext('2d');

  let open = false, viewM = 600;
  // full map view: zoom 1 = whole map fits; (vx, vy) = image pixel at the centre of the canvas
  const MAX_ZOOM = 12;           // the picture is 5 m per pixel: much closer is just blur
  let zoom = 1, vx = img.width / 2, vy = img.height / 2, carPx = [vx, vy];
  const toggle = v => {
    open = v ?? !open; full.classList.toggle('open', open); corner.classList.toggle('hidden', open);
    if (open) { zoom = 1; vx = img.width / 2; vy = img.height / 2; }       // always opens on the whole map
  };
  corner.addEventListener('click', () => toggle(true));
  full.addEventListener('click', e => { if (e.target === full) toggle(false); });   // the dark border closes it

  const fitScale = () => Math.min(fc.width / img.width, fc.height / img.height);
  function clampView() {          // never scroll past the edge of the map picture
    const s = fitScale() * zoom, hw = fc.width / s / 2, hh = fc.height / s / 2;
    vx = hw * 2 >= img.width ? img.width / 2 : Math.min(img.width - hw, Math.max(hw, vx));
    vy = hh * 2 >= img.height ? img.height / 2 : Math.min(img.height - hh, Math.max(hh, vy));
  }
  // zoom by factor f keeping the image point under canvas pixel (cx, cy) where it is
  function zoomAt(f, cx = fc.width / 2, cy = fc.height / 2) {
    const s0 = fitScale() * zoom, ix = vx + (cx - fc.width / 2) / s0, iy = vy + (cy - fc.height / 2) / s0;
    zoom = Math.min(MAX_ZOOM, Math.max(1, zoom * f));
    const s1 = fitScale() * zoom; vx = ix - (cx - fc.width / 2) / s1; vy = iy - (cy - fc.height / 2) / s1;
    clampView();
  }
  const canvasPt = e => { const r = fc.getBoundingClientRect(); return [(e.clientX - r.left) * fc.width / r.width, (e.clientY - r.top) * fc.height / r.height]; };
  fc.addEventListener('wheel', e => {
    e.preventDefault();
    const k = e.ctrlKey ? 0.012 : 0.0018;             // ctrlKey = trackpad pinch (small deltas)
    zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 16 : 1) * k), ...canvasPt(e));
  }, { passive: false });
  fc.addEventListener('dblclick', e => zoomAt(e.shiftKey ? 0.5 : 2, ...canvasPt(e)));
  let drag = null;
  fc.addEventListener('pointerdown', e => { drag = { id: e.pointerId, p: canvasPt(e) }; fc.setPointerCapture(e.pointerId); fc.classList.add('drag'); });
  fc.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = canvasPt(e), s = fitScale() * zoom;
    vx -= (p[0] - drag.p[0]) / s; vy -= (p[1] - drag.p[1]) / s; drag.p = p; clampView();
  });
  const endDrag = () => { drag = null; fc.classList.remove('drag'); };
  fc.addEventListener('pointerup', endDrag); fc.addEventListener('pointercancel', endDrag);
  const ZOOM_STEP = 1.6;
  function zoomCmd(z) {
    if (z === 'in') zoomAt(ZOOM_STEP);
    else if (z === 'out') zoomAt(1 / ZOOM_STEP);
    else if (z === 'fit') { zoom = 1; clampView(); }
    else if (z === 'car') { zoom = Math.max(zoom, 6); [vx, vy] = carPx; clampView(); }
    else if (z === 'close') toggle(false);
  }
  full.querySelectorAll('.fm-zoom button').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); zoomCmd(b.dataset.z); }));

  function fit(canvas) {          // keep the canvas backing store matched to its CSS size × pixel ratio
    const r = canvas.getBoundingClientRect(), d = Math.min(devicePixelRatio, 2);
    const w = Math.round(r.width * d), h = Math.round(r.height * d);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    return d;
  }

  function arrow(ctx, x, y, angle, size) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -size); ctx.lineTo(size * 0.72, size * 0.8); ctx.lineTo(0, size * 0.38); ctx.lineTo(-size * 0.72, size * 0.8);
    ctx.closePath();
    ctx.fillStyle = '#ff3b30'; ctx.strokeStyle = '#fff'; ctx.lineWidth = size * 0.28; ctx.lineJoin = 'round';
    ctx.stroke(); ctx.fill();
    ctx.restore();
  }

  function label(ctx, text, x, y, px) {
    ctx.font = `700 ${px}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = px * 0.3; ctx.strokeStyle = '#000a'; ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y); ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
  }

  // challenge route + checkpoints drawn over the map: { route: [[x, z]…], gates: [{x, z}…], next } or null
  let overlay = null;
  function drawOverlay(ctx, map, d) {      // map(x, z) → canvas px
    if (!overlay) return;
    const { route, gates, next } = overlay;
    ctx.save(); ctx.lineJoin = ctx.lineCap = 'round';
    ctx.beginPath(); route.forEach(([x, z], i) => { const [a, b] = map(x, z); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); });
    ctx.strokeStyle = '#0008'; ctx.lineWidth = 6 * d; ctx.stroke();
    ctx.strokeStyle = '#35e0ff'; ctx.lineWidth = 3 * d; ctx.stroke();
    for (let i = gates.length - 1; i >= next; i--) {
      const [a, b] = map(gates[i].x, gates[i].z), fin = i === gates.length - 1, cur = i === next;
      ctx.beginPath(); ctx.arc(a, b, (cur || fin ? 6 : 3.5) * d, 0, Math.PI * 2);
      ctx.fillStyle = fin ? '#ffd23f' : cur ? '#35e0ff' : '#ff9a2e'; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = (cur || fin ? 2 : 1.2) * d; ctx.stroke();
    }
    ctx.restore();
  }

  // x, z: car position (m); heading: radians on the map, 0 = north (up), clockwise; speed in m/s
  function update(x, z, heading, speed, dt) {
    const [px, py] = toPx(x, z);
    if (!open) {
      const d = fit(cc), W = cc.width, H = cc.height;
      viewM += (450 + Math.min(speed, 80) * 7 - viewM) * Math.min(1, dt * 1.5);   // zooms out a little at speed
      const s = W / (viewM / mpp);               // canvas px per image px
      cctx.fillStyle = '#222824'; cctx.fillRect(0, 0, W, H);   // off the map (same as the baked picture)
      cctx.imageSmoothingQuality = 'high';
      cctx.drawImage(img, W / 2 - px * s, H / 2 - py * s, img.width * s, img.height * s);
      drawOverlay(cctx, (gx, gz) => { const [a, b] = toPx(gx, gz); return [W / 2 + (a - px) * s, H / 2 + (b - py) * s]; }, d);
      arrow(cctx, W / 2, H / 2, heading, 9 * d);
    } else {
      const d = fit(fc), W = fc.width, H = fc.height;
      carPx = [px, py]; clampView();
      const s = fitScale() * zoom, ox = W / 2 - vx * s, oy = H / 2 - vy * s;
      full.querySelector('[data-z="in"]').disabled = zoom >= MAX_ZOOM; full.querySelector('[data-z="out"]').disabled = zoom <= 1;
      fctx.clearRect(0, 0, W, H);
      if (zoom > 1) { fctx.fillStyle = '#222824'; fctx.fillRect(0, 0, W, H); }
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(img, ox, oy, img.width * s, img.height * s);
      for (const l of LABELS) { const [lx, ly] = toPx(l.x, l.z); label(fctx, l.name, ox + lx * s, oy + ly * s, 15 * d); }
      drawOverlay(fctx, (gx, gz) => { const [a, b] = toPx(gx, gz); return [ox + a * s, oy + b * s]; }, d);
      // pulsing ring so you can spot yourself on the big map
      const t = performance.now() / 1000, r = (10 + 8 * ((t * 1.2) % 1)) * d;
      fctx.beginPath(); fctx.arc(ox + px * s, oy + py * s, r, 0, Math.PI * 2);
      fctx.strokeStyle = `rgba(255,59,48,${1 - ((t * 1.2) % 1)})`; fctx.lineWidth = 2.5 * d; fctx.stroke();
      arrow(fctx, ox + px * s, oy + py * s, heading, 11 * d);
    }
  }

  addEventListener('keydown', e => {
    if (e.code === 'KeyM') toggle();
    if (e.code === 'Escape' && open) toggle(false);
    if (!open) return;
    if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomCmd('in');
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomCmd('out');
    if (e.code === 'Digit0' || e.code === 'Numpad0') zoomCmd('fit');
  });
  return { update, toggle, setOverlay: o => { overlay = o; }, get open() { return open; } };
}
