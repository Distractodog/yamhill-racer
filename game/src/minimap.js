// Map: a small north-up corner map that follows the car, and a full map of the whole area (M, or click it).
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
  full.innerHTML = '<canvas></canvas><div class="fm-hint">M or Esc to close</div>';
  document.body.append(corner, full);
  const cc = corner.querySelector('canvas'), fc = full.querySelector('canvas');
  const cctx = cc.getContext('2d'), fctx = fc.getContext('2d');

  let open = false, viewM = 600;
  const toggle = v => { open = v ?? !open; full.classList.toggle('open', open); corner.classList.toggle('hidden', open); };
  corner.addEventListener('click', () => toggle(true));
  full.addEventListener('click', () => toggle(false));

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
      arrow(cctx, W / 2, H / 2, heading, 9 * d);
    } else {
      const d = fit(fc), W = fc.width, H = fc.height;
      const s = Math.min(W / img.width, H / img.height), ox = (W - img.width * s) / 2, oy = (H - img.height * s) / 2;
      fctx.clearRect(0, 0, W, H);
      fctx.imageSmoothingQuality = 'high';
      fctx.drawImage(img, ox, oy, img.width * s, img.height * s);
      for (const l of LABELS) { const [lx, ly] = toPx(l.x, l.z); label(fctx, l.name, ox + lx * s, oy + ly * s, 15 * d); }
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
  });
  return { update, toggle, get open() { return open; } };
}
