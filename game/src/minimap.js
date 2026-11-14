import { drawMapImage } from './mapimage.js';
import { createMapDetail, mapDetailLevel } from './mapdetail.js';
import { createMapDetail as createMapImagery } from './minimapdetail.js';
// Map: a small north-up corner map that follows the car, and a full map of the whole area (M, or click it).
// The full map zooms (scroll / pinch / + −, around the pointer) and pans (drag). A click drops a pin
// (click it again, 📍 or P to clear); pin.js guides you to it.
// The picture is baked by tools/build_minimap.py (ground colours + roads, trails, buildings, ponds).
const LABELS = [
  { name: 'Delphian', x: -560, z: 60 },
  { name: 'Willamina', x: -3640, z: 3330 },
  { name: 'Sheridan', x: 3800, z: 1400 },
  { name: 'Bellevue', x: 11860, z: -2110 },
  { name: 'McMinnville', x: 19100, z: -11000 },
  { name: 'Amity', x: 18620, z: -560 },
  { name: 'Ballston', x: 13430, z: 4790 },
  { name: 'Perrydale', x: 13830, z: 7900 },
  { name: 'Whiteson', x: 19090, z: -4680 },
];

export const PIN_COLOR = '#ff2fd6';      // magenta: apart from the challenge colours (cyan / orange / yellow)

export async function createMinimap(base = './assets/') {
  const meta = await fetch(base + 'minimap.json').then(r => r.json());
  const img = new Image();
  img.src = base + 'minimap.jpg';
  await img.decode();
  const imagery = createMapImagery(meta, base);
  const [ex0, ez0] = meta.extent, mpp = meta.mpp;
  const detail = createMapDetail(base);
  const mapBase = document.createElement('canvas'), mapCtx = mapBase.getContext('2d');
  let mapBaseKey = '';
  const toPx = (x, z) => [(x - ex0) / mpp, (z - ez0) / mpp];   // world metres → map image pixels
  const rim = meta.rim || null;
  // canvas position of the scenery circle, given the image's top-left and px-per-image-pixel
  const rimAt = (ox, oy, s) => {
    const [ix, iy] = toPx(rim.cx, rim.cz);
    return [ox + ix * s, oy + iy * s, rim.r / mpp * s];
  };
  function strokeRim(ctx, ox, oy, s, d) {
    if (!rim) return;
    const [x, y, r] = rimAt(ox, oy, s);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#c2f3ff'; ctx.lineWidth = Math.max(1.5 * d, Math.min(3.5 * d, 24 / mpp * s)); ctx.stroke();
  }

  const corner = document.createElement('div');
  corner.id = 'minimap';
  corner.title = 'Full map (M)';
  corner.innerHTML = '<canvas></canvas><button aria-label="Open full map">⤢</button><span class="mm-n">N</span>';
  const full = document.createElement('div');
  full.id = 'fullmap';
  full.innerHTML = '<canvas></canvas><div class="fm-hint">↱ for road directions · click to drop a pin · scroll or + − to zoom · drag to move · M or Esc to close</div>' +
    '<div class="fm-status" aria-live="polite"></div><div class="fm-scale"></div><div class="fm-zoom"><button data-z="in" title="Zoom in (+)">+</button><button data-z="out" title="Zoom out (−)">−</button>' +
    '<button data-z="fit" title="Whole map (0)">⤢</button><button data-z="car" title="Centre on car">◎</button>' +
    '<button data-z="directions" title="Road directions" aria-label="Road directions">↱</button><button data-z="unpin" title="Remove the pin (P)">📍</button><button data-z="close" title="Close (M)">✕</button></div>';
  const routeBadge = '<div class="mm-route" hidden><span></span><button type="button" aria-label="Clear directions" title="Clear directions">✕</button></div>';
  corner.insertAdjacentHTML('beforeend', routeBadge);
  full.insertAdjacentHTML('beforeend', routeBadge);
  const css = document.createElement('style');
  css.textContent = `#minimap .mm-route, #fullmap .mm-route { position:absolute; bottom:8px; left:8px; right:8px; display:flex; align-items:center; justify-content:space-between; gap:6px; padding:5px 7px; border-radius:7px; background:#10251fee; color:#fff; font:600 12px/1.3 system-ui; }
    #fullmap .mm-route { left:calc(3vw + 12px); right:auto; bottom:calc(3vh + 12px); max-width:min(420px,70vw); font-size:14px; }
    #minimap .mm-route[hidden], #fullmap .mm-route[hidden] { display:none; }
    #minimap .mm-route button, #fullmap .mm-route button { position:static; flex:0 0 20px; width:20px; height:20px; border:0; border-radius:4px; background:transparent; color:#fff; font:16px/1 system-ui; cursor:pointer; padding:0; }
    #fullmap { cursor: default; } #fullmap canvas { cursor: grab; touch-action: none; }
    #fullmap canvas.drag { cursor: grabbing; }
    #fullmap .fm-status { position:absolute; left:calc(3vw + 12px); bottom:calc(3vh + 12px); color:#f2f5e9; background:#14291ed9; border-radius:8px; padding:6px 10px; font:12px system-ui,sans-serif; pointer-events:none; }
    #fullmap .fm-scale { position:absolute; right:calc(3vw + 16px); bottom:calc(3vh + 16px); border:solid #fff; border-width:0 2px 2px; height:18px; color:white; font:11px system-ui,sans-serif; text-align:center; text-shadow:0 1px 3px #000; pointer-events:none; }
    #fullmap.spawn-picker .fm-hint { top: 20px; padding: 12px 20px; border-radius: 12px; background: #10251fee; font-size: 18px; font-weight: 700; text-align: center; width: min(700px, 75vw); }
    #fullmap .fm-zoom { position: absolute; right: calc(3vw + 12px); top: calc(3vh + 12px); display: flex; flex-direction: column; gap: 6px; }
    #fullmap .fm-zoom button { width: 36px; height: 36px; border: 0; border-radius: 9px; background: #000b; color: #fff;
      font: 700 20px/1 system-ui, sans-serif; cursor: pointer; box-shadow: 0 2px 8px #0005; }
    #fullmap .fm-zoom button:hover { background: #000e; }
    #fullmap .fm-zoom button:disabled { opacity: .35; cursor: default; }
    #fullmap .fm-zoom button[data-z="close"] { font-size: 16px; }
    #fullmap .fm-zoom button[data-z="unpin"] { margin-top: 8px; font-size: 16px; position: relative; }
    #fullmap .fm-zoom button[data-z="unpin"]::after { content: ''; position: absolute; left: 7px; right: 7px; top: 17px;
      height: 2px; background: #fff; transform: rotate(-45deg); }`;
  document.head.append(css);
  document.body.append(corner, full);
  const cc = corner.querySelector('canvas'), fc = full.querySelector('canvas');
  const cctx = cc.getContext('2d'), fctx = fc.getContext('2d');
  const zoomIn = full.querySelector('[data-z="in"]'), zoomOut = full.querySelector('[data-z="out"]');
  const unpinButton = full.querySelector('[data-z="unpin"]'), statusEl = full.querySelector('.fm-status'), scaleEl = full.querySelector('.fm-scale');

  let directionMode = false, directionBegin = null, directionChoose = null, directionClear = null, directions = null;
  let open = false, viewM = 600, spawnPicker = null;
  const normalHint = full.querySelector(".fm-hint").textContent;
  // full map view: zoom 1 = whole map fits; (vx, vy) = image pixel at the centre of the canvas
  const MAX_ZOOM = 1024;         // vector detail remains crisp down to individual metres
  let zoom = 1, vx = img.width / 2, vy = img.height / 2, carPx = [vx, vy];
  const toggle = v => {
    if (spawnPicker && v !== true) return;
    open = v ?? !open; full.classList.toggle('open', open); corner.classList.toggle('hidden', open);
    if (!open) detail.update([0,0,0,0],0);
    if (open) { zoom = 1; vx = img.width / 2; vy = img.height / 2; }       // always opens on the whole map
  };
  for (const panel of [corner, full]) panel.querySelector('.mm-route button').addEventListener('click', e => { e.stopPropagation(); directionClear?.(); });
  corner.addEventListener('click', () => toggle(true));
  full.addEventListener('click', e => { if (e.target === full) toggle(false); });   // the dark border closes it

  const fitScale = () => Math.min(fc.width / img.width, fc.height / img.height);
  function clampView() {          // never scroll past the edge of the map picture
    const s = fitScale() * zoom, hw = fc.width / s / 2, hh = fc.height / s / 2;
    vx = hw * 2 >= img.width ? img.width / 2 : Math.min(img.width - hw, Math.max(hw, vx));
    vy = hh * 2 >= img.height ? img.height / 2 : Math.min(img.height - hh, Math.max(hh, vy));
    if (rim && zoom > 1) {
      const [rx, ry] = toPx(rim.cx, rim.cz), dx = vx - rx, dy = vy - ry;
      const limit = Math.max(0, rim.r / mpp - Math.min(hw, hh) * .35), length = Math.hypot(dx, dy);
      if (length > limit + 1e-7) { vx = rx + dx / length * limit; vy = ry + dy / length * limit; }
    }
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
  // pin: { x, z } in world metres, or null. A click (press + release without dragging) drops it; clicking on it removes it
  let pin = null; const pinListeners = [];
  try { const p = JSON.parse(localStorage.getItem('yr-pin-1') || 'null'); if (p && isFinite(p.x) && isFinite(p.z)) pin = p; } catch {}
  function setPin(p) {
    pin = p ? { x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10 } : null;
    try { localStorage.setItem('yr-pin-1', JSON.stringify(pin)); } catch {}
    for (const f of pinListeners) f(pin);
  }
  const onMap = (x, z) => { const [a, b] = toPx(x, z); return a >= 0 && b >= 0 && a < img.width && b < img.height && (!rim || Math.hypot(x-rim.cx,z-rim.cz)<=rim.r); };
  let drag = null, pinch = null;
  const pointers = new Map();
  const pinchState = () => { const [a,b] = [...pointers.values()]; return { x:(a[0]+b[0])/2, y:(a[1]+b[1])/2, distance:Math.hypot(a[0]-b[0],a[1]-b[1]) }; };
  fc.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const p=canvasPt(e); pointers.set(e.pointerId,p);fc.setPointerCapture(e.pointerId);fc.classList.add('drag');
    if (pointers.size === 1) drag = { id:e.pointerId,p,p0:p,moved:0 };
    else if (pointers.size === 2) { pinch=pinchState(); if(drag)drag.moved=Infinity; }
  });
  fc.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const p=canvasPt(e);pointers.set(e.pointerId,p);
    if (pointers.size === 2 && pinch) {
      const next=pinchState(),s=fitScale()*zoom;
      vx-=(next.x-pinch.x)/s;vy-=(next.y-pinch.y)/s;
      if(pinch.distance>1)zoomAt(next.distance/pinch.distance,next.x,next.y);pinch=next;clampView();return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const s = fitScale() * zoom;
    drag.moved = Math.max(drag.moved, Math.hypot(p[0] - drag.p0[0], p[1] - drag.p0[1]));
    vx -= (p[0] - drag.p[0]) / s; vy -= (p[1] - drag.p[1]) / s; drag.p = p; clampView();
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);pinch=null;
    if(pointers.size===1){const[id,p]=[...pointers][0];drag={id,p,p0:p,moved:Infinity};}
    else {drag=null;fc.classList.remove('drag');}
  }
  fc.addEventListener('pointerup', e => {
    const click = pointers.size === 1 && drag && drag.id === e.pointerId && drag.moved < 6 * Math.min(devicePixelRatio, 2);
    endPointer(e);
    if (!click) return;
    const [cx, cy] = canvasPt(e), s = fitScale() * zoom, d = Math.min(devicePixelRatio, 2);
    const ix = vx + (cx - fc.width / 2) / s, iy = vy + (cy - fc.height / 2) / s;
    if (spawnPicker) {
      spawnPicker(ex0 + ix * mpp, ez0 + iy * mpp);
      return;
    }
    if (directionMode) { directionChoose?.(ex0 + ix * mpp, ez0 + iy * mpp, 6 * d * mpp / s); return; }
    if (pin) {                                     // clicked on the pin (its head sits ~19 px above the point): remove it
      const [qx, qy] = toPx(pin.x, pin.z);
      if (Math.hypot((qx - ix) * s, (qy - iy) * s - 13 * d) < 16 * d) { setPin(null); return; }
    }
    const x = ex0 + ix * mpp, z = ez0 + iy * mpp;
    if (onMap(x, z)) setPin({ x, z });
  });
  fc.addEventListener('pointercancel', endPointer);
  fc.addEventListener('lostpointercapture', e => { if (pointers.has(e.pointerId)) endPointer(e); });
  const ZOOM_STEP = 1.6;
  function zoomCmd(z) {
    if (z === 'directions' && !spawnPicker) directionBegin?.();
    else if (z === 'in') zoomAt(ZOOM_STEP);
    else if (z === 'out') zoomAt(1 / ZOOM_STEP);
    else if (z === 'fit') { zoom = 1; clampView(); }
    else if (z === 'car') { zoom = Math.max(zoom, 40); [vx, vy] = carPx; clampView(); }
    else if (z === 'close') toggle(false);
    else if (z === 'unpin' && !spawnPicker) setPin(null);
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

  // map pin: a teardrop whose point sits on (x, y)
  function drawPin(ctx, x, y, size) {
    ctx.save(); ctx.translate(x, y);
    ctx.beginPath(); ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-size * 0.25, -size * 0.7, -size * 0.75, -size * 1.0, -size * 0.75, -size * 1.45);
    ctx.arc(0, -size * 1.45, size * 0.75, Math.PI, 0);
    ctx.bezierCurveTo(size * 0.75, -size * 1.0, size * 0.25, -size * 0.7, 0, 0); ctx.closePath();
    ctx.fillStyle = PIN_COLOR; ctx.strokeStyle = '#fff'; ctx.lineWidth = size * 0.22; ctx.lineJoin = 'round';
    ctx.stroke(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, -size * 1.45, size * 0.28, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.restore();
  }
  // car → pin as a faint dashed line (map(x, z) → canvas px)
  function drawPinLine(ctx, map, cx, cy, d) {
    if (!pin || directions) return;
    const [a, b] = map(pin.x, pin.z);
    ctx.save(); ctx.setLineDash([6 * d, 6 * d]); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(a, b);
    ctx.strokeStyle = PIN_COLOR + '99'; ctx.lineWidth = 2.5 * d; ctx.stroke(); ctx.restore();
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

  function drawDirections(ctx, map, d) {
    if (!directions?.length) return;
    ctx.save(); ctx.lineJoin = ctx.lineCap = 'round'; ctx.beginPath();
    directions.forEach(([x,z],i) => { const p=map(x,z); i ? ctx.lineTo(...p) : ctx.moveTo(...p); });
    ctx.strokeStyle='#10251f'; ctx.lineWidth=7*d; ctx.stroke();
    ctx.strokeStyle='#83ff78'; ctx.lineWidth=4*d; ctx.stroke();
    const end=map(...directions[directions.length-1]);
    ctx.beginPath(); ctx.arc(...end,7*d,0,Math.PI*2); ctx.fillStyle='#83ff78'; ctx.fill();
    ctx.strokeStyle='#fff'; ctx.lineWidth=2*d; ctx.stroke(); ctx.restore();
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
      const cox = W / 2 - px * s, coy = H / 2 - py * s;
      drawMapImage(cctx, img, cox, coy, s);
      cctx.save();
      if (rim) { const [rx, ry, rr] = rimAt(cox, coy, s); cctx.beginPath(); cctx.arc(rx, ry, rr, 0, Math.PI * 2); cctx.clip(); }
      imagery.draw(cctx, cox, coy, s);
      cctx.restore();
      strokeRim(cctx, cox, coy, s, d);
      const cmap = (gx, gz) => { const [a, b] = toPx(gx, gz); return [W / 2 + (a - px) * s, H / 2 + (b - py) * s]; };
      drawOverlay(cctx, cmap, d);
      drawDirections(cctx, cmap, d);
      if (pin) {                                   // pin on the corner map; held at the edge when it's further away
        let [a, b] = cmap(pin.x, pin.z); const m = 12 * d, inside = a > m && a < W - m && b > m * 2 && b < H - m;
        if (!inside) {
          const dx = a - W / 2, dy = b - H / 2, k = Math.min((W / 2 - m) / Math.abs(dx || 1e-9), (H / 2 - m) / Math.abs(dy || 1e-9));
          a = W / 2 + dx * k; b = H / 2 + dy * k;
          cctx.beginPath(); cctx.arc(a, b, 5 * d, 0, Math.PI * 2); cctx.fillStyle = PIN_COLOR; cctx.fill();
          cctx.strokeStyle = '#fff'; cctx.lineWidth = 1.6 * d; cctx.stroke();
        } else { drawPinLine(cctx, cmap, W / 2, H / 2, d); drawPin(cctx, a, b, 9 * d); }
      }
      arrow(cctx, W / 2, H / 2, heading, 9 * d);
    } else {
      const d = fit(fc), W = fc.width, H = fc.height;
      carPx = [px, py]; clampView();
      const s = fitScale() * zoom, ox = W / 2 - vx * s, oy = H / 2 - vy * s;
      if (zoomIn.disabled !== (zoom >= MAX_ZOOM)) zoomIn.disabled = zoom >= MAX_ZOOM;
      if (zoomOut.disabled !== (zoom <= 1)) zoomOut.disabled = zoom <= 1;
      const fmap = (gx, gz) => { const [a, b] = toPx(gx, gz); return [ox + a * s, oy + b * s]; };
      const ppm=s/mpp,bounds=[ex0+(vx-W/2/s)*mpp,ez0+(vy-H/2/s)*mpp,ex0+(vx+W/2/s)*mpp,ez0+(vy+H/2/s)*mpp];
      detail.update(bounds,ppm/d);
      const baseKey=[W,H,vx,vy,zoom,d,detail.revision,imagery.revision].join(':');
      if(baseKey!==mapBaseKey){
        mapBase.width=W;mapBase.height=H;mapBaseKey=baseKey;
        mapCtx.fillStyle='#141816';mapCtx.fillRect(0,0,W,H);mapCtx.save();
        if(rim){const[rx,ry,rr]=rimAt(ox,oy,s);mapCtx.beginPath();mapCtx.arc(rx,ry,rr,0,Math.PI*2);mapCtx.clip();}
        mapCtx.imageSmoothingQuality='high';drawMapImage(mapCtx,img,ox,oy,s);
        imagery.draw(mapCtx,ox,oy,s);
        detail.draw(mapCtx,{bounds,ppm,d,map:fmap});
        if(mapDetailLevel(ppm/d)<3)for(const l of LABELS){const[lx,ly]=fmap(l.x,l.z);if(lx>-120&&ly>-30&&lx<W+120&&ly<H+30)label(mapCtx,l.name,lx,ly,(zoom>25?12:15)*d);}
        mapCtx.restore();
      }
      fctx.drawImage(mapBase,0,0);
      const stats=detail.stats,level=mapDetailLevel(ppm/d),status=statusEl;
      const statusText=level===0?'County overview':stats.pending?'Loading street detail…':stats.failed||stats.manifestError?'Some detail unavailable · overview remains visible':level===1?'Neighborhood map':level===2?'Streets & buildings':'Street-level detail';
      if(status.textContent!==statusText)status.textContent=statusText;
      const target=100*d/ppm,power=10**Math.floor(Math.log10(target)),step=[1,2,5,10].find(n=>n*power>=target)||10,metres=step*power;
      const scaleWidth=(metres*ppm/d)+'px', scaleText=metres>=1000?(metres/1000)+' km':metres+' m';
      if(scaleEl.style.width!==scaleWidth)scaleEl.style.width=scaleWidth;
      if(scaleEl.textContent!==scaleText)scaleEl.textContent=scaleText;
      fctx.save();
      if (rim) { const [rx, ry, rr] = rimAt(ox, oy, s); fctx.beginPath(); fctx.arc(rx, ry, rr, 0, Math.PI * 2); fctx.clip(); }
      drawOverlay(fctx, fmap, d);
      drawDirections(fctx, fmap, d);
      drawPinLine(fctx, fmap, ox + px * s, oy + py * s, d);
      if(unpinButton.disabled!==!pin)unpinButton.disabled=!pin;
      // pulsing ring so you can spot yourself on the big map
      const t = performance.now() / 1000, r = (10 + 8 * ((t * 1.2) % 1)) * d;
      fctx.beginPath(); fctx.arc(ox + px * s, oy + py * s, r, 0, Math.PI * 2);
      fctx.strokeStyle = `rgba(255,59,48,${1 - ((t * 1.2) % 1)})`; fctx.lineWidth = 2.5 * d; fctx.stroke();
      arrow(fctx, ox + px * s, oy + py * s, heading, 11 * d);
      if (pin) drawPin(fctx, ...fmap(pin.x, pin.z), 13 * d);
      fctx.restore();
      strokeRim(fctx, ox, oy, s, d);
    }
  }

  addEventListener('keydown', e => {
    if (e.gameUI) return;
    if (e.code === 'KeyM') toggle();
    if (e.code === 'Escape' && open) toggle(false);
    if (e.code === 'KeyP' && pin && !spawnPicker) setPin(null);
    if (!open) return;
    if (e.code === 'Equal' || e.code === 'NumpadAdd') zoomCmd('in');
    if (e.code === 'Minus' || e.code === 'NumpadSubtract') zoomCmd('out');
    if (e.code === 'Digit0' || e.code === 'Numpad0') zoomCmd('fit');
  });
  return { update, toggle, get detailStats() { return detail.stats; }, get zoom() { return zoom; },
    setDirectionHandlers(begin, choose, clear) { directionBegin=begin; directionChoose=choose; directionClear=clear; },
    setDirectionsStatus(text) {
      for (const panel of [corner, full]) {
        const badge=panel.querySelector('.mm-route'); badge.hidden=!text;
        if (panel === full) statusEl.hidden=!!text;
        badge.querySelector('span').textContent=text || '';
      }
    },
    setDirections(points) { directions=points; },
    setDirectionMode(value) {
      directionMode=value;
      full.querySelector('[data-z="directions"]').setAttribute('aria-pressed', String(value));
      if (!spawnPicker) full.querySelector('.fm-hint').textContent=value ? 'Click a road to get directions · scroll to zoom · drag to move' : normalHint;
    },
    pickSpawn(callback, message = 'Where do you want to start? Click a point on the map · scroll to zoom · drag to move') {
      spawnPicker = callback;
      full.classList.toggle('spawn-picker', !!callback);
      full.querySelector('.fm-hint').textContent = callback ? message : normalHint;
      for (const command of ['close', 'unpin', 'car', 'directions']) full.querySelector(`[data-z="${command}"]`).hidden = !!callback;
      if (callback && !open) toggle(true);
    }, setOverlay: o => { overlay = o; }, get open() { return open; },
    get pin() { return pin; }, setPin, onPin: f => pinListeners.push(f) };
}
