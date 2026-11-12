// Timed challenges: point-to-point runs through checkpoint arches (routes planned by tools/challenge_routes.py).
// J opens the list; picking one puts the car on the start line, counts 3-2-1-GO, then times you through every
// checkpoint in order to the finish. Best times (and their checkpoint splits) are saved per browser.
import * as THREE from 'three';
import { RAMP, RAMP_LEN, rampShape } from './data.js';

const BEST_KEY = 'yr-best-1';
const POST_H = 7, COUNTDOWN = 3;

const CSS = `
#ch-hud { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); text-align: center; color: #fff;
  text-shadow: 0 1px 4px #000c; pointer-events: none; display: none; font-variant-numeric: tabular-nums; }
#fullmap.open ~ #ch-hud, #fullmap.open ~ #ch-split { display: none !important; }
#ch-hud .ch-name { font-size: 13px; font-weight: 700; opacity: .9; }
#ch-hud .ch-time { font-size: 40px; font-weight: 800; line-height: 1.05; }
#ch-hud .ch-sub { font-size: 13px; opacity: .92; }
#ch-split { position: fixed; top: 120px; left: 50%; transform: translateX(-50%); font: 800 26px system-ui, sans-serif;
  color: #fff; text-shadow: 0 1px 4px #000c; pointer-events: none; opacity: 0; transition: opacity .3s;
  font-variant-numeric: tabular-nums; white-space: nowrap; }
#ch-split .ahead { color: #5df07a; } #ch-split .behind { color: #ff6b5e; }
#ch-count { position: fixed; top: 34%; left: 50%; transform: translate(-50%, -50%); font: 900 120px system-ui, sans-serif;
  color: #fff; text-shadow: 0 4px 18px #000b; pointer-events: none; display: none; }
.ch-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(460px, 90vw);
  background: #142016ee; color: #fff; border-radius: 16px; box-shadow: 0 10px 40px #0008; padding: 20px 22px;
  display: none; font-size: 14px; }
.ch-panel h2 { margin: 0 0 12px; font-size: 22px; }
.ch-panel .ch-item { display: block; width: 100%; text-align: left; border: 2px solid transparent; background: #ffffff12;
  color: #fff; border-radius: 10px; padding: 10px 12px; margin: 6px 0; cursor: pointer; font: inherit; }
.ch-panel .ch-item.sel { border-color: #ffd23f; background: #ffffff22; }
.ch-panel .ch-item b { font-size: 16px; }
.ch-panel .ch-item .ch-meta { float: right; opacity: .85; font-variant-numeric: tabular-nums; }
.ch-panel .ch-item .ch-desc { display: block; opacity: .75; font-size: 12.5px; margin-top: 2px; }
.ch-panel .ch-hint { opacity: .65; font-size: 12px; margin-top: 10px; }
.ch-panel .ch-big { font-size: 48px; font-weight: 900; font-variant-numeric: tabular-nums; margin: 4px 0; }
.ch-panel .ch-new { color: #ffd23f; font-weight: 800; font-size: 18px; }
`;

export function fmtTime(t) {
  if (t == null || !isFinite(t)) return '–';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}
const fmtDelta = d => `${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`;

// ---------------------------------------------------------------- arches
function checkerTexture() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 8;
  const g = c.getContext('2d');
  for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#fff'; g.fillRect(i * 4, j * 4, 4, 4); }
  const t = new THREE.CanvasTexture(c); t.magFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace; return t;
}
const MAT = {
  next: new THREE.MeshBasicMaterial({ color: 0x35e0ff }),
  later: new THREE.MeshBasicMaterial({ color: 0xff9a2e, transparent: true, opacity: 0.55 }),
  start: new THREE.MeshBasicMaterial({ color: 0x3cdc68 }),
  post: new THREE.MeshLambertMaterial({ color: 0x2b2f36 }),
  finish: null,
  beam: new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.28, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
};
const POST = new THREE.BoxGeometry(0.9, POST_H, 0.9).translate(0, POST_H / 2, 0);
const BAR = new THREE.BoxGeometry(1, 1.4, 0.5);
const BEAM = new THREE.CylinderGeometry(2.2, 2.2, 260, 12, 1, true).translate(0, 130 + POST_H, 0);

function makeArch(g, kind) {
  const grp = new THREE.Group();
  const l = new THREE.Mesh(POST, MAT.post), r = new THREE.Mesh(POST, MAT.post);
  l.position.x = g.w / 2; r.position.x = -g.w / 2;
  const bar = new THREE.Mesh(BAR, kind === 'finish' ? MAT.finish : kind === 'start' ? MAT.start : MAT.later);
  bar.scale.x = g.w + 0.9; bar.position.y = POST_H - 0.7;
  for (const m of [l, r]) { m.castShadow = true; }
  grp.add(l, r, bar);
  grp.position.set(g.x, 0, g.z);
  grp.rotation.y = g.yaw;           // local x = across the road, local z = along the route
  grp.visible = false;
  return { grp, bar, kind, placed: false };
}

// ---------------------------------------------------------------- jump ramps
function chevronTexture() {          // yellow/black chevrons pointing up the ramp
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#ffc61a'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#1b1b1b';
  for (const y0 of [8, 40]) { g.beginPath(); g.moveTo(0, y0 + 16); g.lineTo(32, y0); g.lineTo(64, y0 + 16); g.lineTo(64, y0 + 26); g.lineTo(32, y0 + 10); g.lineTo(0, y0 + 26); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4; return t;
}
let RAMP_MAT = null;
const RAMP_SIDE = new THREE.MeshLambertMaterial({ color: 0x3a3d42 });
// one ramp as a mesh in world coordinates, laid on the road under it (groundAt = height without ramps)
function makeRamp(world, r) {
  const fx = Math.sin(r.yaw), fz = Math.cos(r.yaw), lx = fz, lz = -fx, hw = r.w / 2;
  const us = []; for (let u = 0; u <= RAMP_LEN + 1e-6; u += 1) us.push(u);
  for (const k of [RAMP.up, RAMP.up + RAMP.top]) if (!us.includes(k)) us.push(k);
  us.sort((a, b) => a - b);
  const top = [], side = [], uvs = [], ti = [], si = [];
  const P = (u, v) => [r.x + fx * u + lx * v, r.z + fz * u + lz * v];
  us.forEach((u, i) => {
    const h = rampShape(Math.min(Math.max(u, 1e-4), RAMP_LEN - 1e-4))[0] * (u === 0 || u === RAMP_LEN ? 0 : 1);
    for (const v of [-hw, hw]) {
      const [x, z] = P(u, v), g = world.groundAt(x, z);
      top.push(x, g + h + 0.03, z); uvs.push((v + hw) / 4, u / 4);
      side.push(x, g + h + 0.03, z, x, g - 0.4, z);
    }
    if (i) {
      const a = (i - 1) * 2, b = i * 2;
      ti.push(a, a + 1, b, b, a + 1, b + 1);
      for (const sd of [0, 1]) { const A = (a + sd) * 2, B = (b + sd) * 2; si.push(A, A + 1, B, B, A + 1, B + 1); }
    }
  });
  const gt = new THREE.BufferGeometry();
  gt.setAttribute('position', new THREE.Float32BufferAttribute(top, 3)); gt.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  gt.setIndex(ti); gt.computeVertexNormals();
  const gs = new THREE.BufferGeometry();
  gs.setAttribute('position', new THREE.Float32BufferAttribute(side, 3)); gs.setIndex(si); gs.computeVertexNormals();
  const grp = new THREE.Group();
  const mt = new THREE.Mesh(gt, RAMP_MAT); mt.receiveShadow = true; mt.castShadow = true;
  const ms = new THREE.Mesh(gs, RAMP_SIDE);
  RAMP_MAT.side = RAMP_SIDE.side = THREE.DoubleSide;
  grp.add(mt, ms);
  return grp;
}

// ---------------------------------------------------------------- manager
export async function createChallenges({ scene, world, car, minimap, base = './assets/' }) {
  const list = await fetch(base + 'challenges.json').then(r => r.json());
  MAT.finish = new THREE.MeshBasicMaterial({ map: checkerTexture() });
  RAMP_MAT = new THREE.MeshLambertMaterial({ map: chevronTexture() });
  MAT.finish.map.repeat.set(4, 1); MAT.finish.map.wrapS = THREE.RepeatWrapping;

  const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
  const hud = el('div', 'ch-hud'), split = el('div', 'ch-split'), count = el('div', 'ch-count');
  const menu = el('div', 'ch-menu', 'ch-panel'), done = el('div', 'ch-done', 'ch-panel');
  function el(tag, id, cls) { const e = document.createElement(tag); e.id = id; if (cls) e.className = cls; document.body.append(e); return e; }

  let best = {};
  try { best = JSON.parse(localStorage.getItem(BEST_KEY) || '{}'); } catch {}
  const saveBest = () => { try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch {} };

  const group = new THREE.Group(); scene.add(group);
  const beam = new THREE.Mesh(BEAM, MAT.beam); beam.visible = false; beam.renderOrder = 5; beam.frustumCulled = false;
  group.add(beam);

  // state: 'idle' | 'placing' | 'countdown' | 'running' | 'finished'
  let ch = null, arches = [], state = 'idle', t = 0, cd = 0, next = 1, splits = [], splitT = 0, sel = 0, result = null;
  let menuOpen = false, placeToken = 0;
  const lastPos = new THREE.Vector2(), curPos = new THREE.Vector2();

  // ---- sound blips (own tiny audio context; created on first key press)
  let ac = null;
  function blip(freq, dur = 0.12, vol = 0.18) {
    try {
      ac ??= new AudioContext();
      const o = ac.createOscillator(), g = ac.createGain(), now = ac.currentTime;
      o.type = 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, now); g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      o.connect(g).connect(ac.destination); o.start(now); o.stop(now + dur);
    } catch {}
  }

  let ramps = [];       // { r, grp|null } — meshes built once the ground under them has streamed in
  function clearArches() {
    for (const a of arches) group.remove(a.grp); arches = []; beam.visible = false;
    for (const q of ramps) if (q.grp) { group.remove(q.grp); q.grp.traverse(o => o.geometry?.dispose()); }
    ramps = []; world.setRamps?.([]);
  }

  function buildArches() {
    clearArches();
    const n = ch.gates.length;
    arches = ch.gates.map((g, i) => makeArch(g, i === 0 ? 'start' : i === n - 1 ? 'finish' : 'cp'));
    for (const a of arches) group.add(a.grp);
  }

  function styleArches() {
    arches.forEach((a, i) => {
      a.grp.visible = i === 0 ? state !== 'running' || next <= 1 : i >= next;
      if (a.kind === 'cp') a.bar.material = i === next ? MAT.next : MAT.later;
    });
    const g = ch.gates[next];
    beam.visible = !!g && (state === 'running' || state === 'countdown');
    if (g) { beam.position.set(g.x, arches[next].grp.position.y, g.z); MAT.beam.color.set(next === ch.gates.length - 1 ? 0xffd23f : 0x35e0ff); }
    minimap.setOverlay?.(ch && state !== 'idle' ? { route: ch.route, gates: ch.gates, next } : null);
  }

  // place the car on the start line once the tiles there have streamed in
  async function placeCar(x, z, yaw) {
    const token = ++placeToken;
    for (let k = 0; k < 80 && !(world.loadedAt(x, z) && world.pendingTiles() === 0); k++) {
      car.pos.set(x, car.pos.y, z); car.vel.set(0, 0, 0); car._lastLoaded = null;
      await new Promise(r => setTimeout(r, 150));
      if (token !== placeToken) return false;
    }
    car.reset(x, z, yaw); car.safe = []; car._lastLoaded = null;
    return true;
  }

  async function start(i) {
    ch = list[i]; sel = i; result = null;
    closeMenu(); done.style.display = 'none';
    buildArches();
    ramps = (ch.ramps || []).map(r => ({ r, grp: null }));
    world.setRamps?.(ch.ramps || []);
    state = 'placing'; next = 1; t = 0; splits = [];
    hud.style.display = 'block'; renderHud();
    if (!(await placeCar(ch.start.x, ch.start.z, ch.start.yaw))) return;
    state = 'countdown'; cd = COUNTDOWN; styleArches();
    count.style.display = 'block'; count.textContent = '3'; blip(440, 0.15);
  }

  function quit() {
    placeToken++; state = 'idle'; ch = null; clearArches();
    hud.style.display = 'none'; count.style.display = 'none'; done.style.display = 'none'; split.style.opacity = 0;
    minimap.setOverlay?.(null);
  }

  function finish() {
    state = 'finished';
    const prev = best[ch.id];
    const isBest = !prev || t < prev.time;
    if (isBest) { best[ch.id] = { time: t, splits: splits.slice(), date: new Date().toLocaleDateString('en-CA') }; saveBest(); }
    result = { time: t, prev: prev?.time, isBest };
    blip(880, 0.12); setTimeout(() => blip(1320, 0.3), 130);
    beam.visible = false; minimap.setOverlay?.(null); split.style.opacity = 0; splitT = 0;
    done.innerHTML = `<h2>${ch.name}</h2>
      <div class="ch-big">${fmtTime(t)}</div>
      ${isBest ? `<div class="ch-new">${prev ? `New best! ${fmtDelta(t - prev.time)}` : 'First time set!'}</div>`
               : `<div>Best ${fmtTime(prev.time)} · ${fmtDelta(t - prev.time)}</div>`}
      <div class="ch-hint">Enter retry · J challenges · Esc free roam</div>`;
    done.style.display = 'block';
  }

  // ---- checkpoint crossing: the car's path this frame crosses the arch line between the posts
  function crossed(g) {
    const cx = Math.cos(g.yaw), cz = -Math.sin(g.yaw);       // across the road (local x)
    const fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);        // along the route
    const d0 = (lastPos.x - g.x) * fx + (lastPos.y - g.z) * fz, d1 = (curPos.x - g.x) * fx + (curPos.y - g.z) * fz;
    if (d0 > 0 || d1 < 0 || d0 === d1) return false;
    const k = -d0 / (d1 - d0);
    const ix = lastPos.x + (curPos.x - lastPos.x) * k, iz = lastPos.y + (curPos.y - lastPos.y) * k;
    return Math.abs((ix - g.x) * cx + (iz - g.z) * cz) <= g.w / 2 + 1.5;
  }

  function passGate() {
    const isFinish = next === ch.gates.length - 1;
    if (!isFinish) {
      splits.push(t);
      const b = best[ch.id]?.splits?.[splits.length - 1];
      split.innerHTML = `${fmtTime(t)}${b != null ? ` <span class="${t <= b ? 'ahead' : 'behind'}">${fmtDelta(t - b)}</span>` : ''}`;
      split.style.opacity = 1; splitT = 2.5;
      blip(990, 0.09);
    }
    next++;
    if (isFinish) finish(); else styleArches();
  }

  function renderHud() {
    if (!ch) return;
    const n = ch.gates.length - 1;
    let sub = '';
    if (state === 'placing') sub = 'Getting to the start…';
    else if (state === 'running' || state === 'countdown') {
      const g = ch.gates[next], dist = g ? Math.hypot(g.x - car.pos.x, g.z - car.pos.z) : 0;
      sub = `${next === n ? 'Finish' : `Checkpoint ${next}/${n - 1}`} · ${dist < 1000 ? Math.round(dist) + ' m' : (dist / 1000).toFixed(1) + ' km'}`;
      const b = best[ch.id]; if (b) sub += ` · best ${fmtTime(b.time)}`;
    } else if (state === 'finished') sub = 'Finished';
    hud.innerHTML = `<div class="ch-name">${ch.name}</div><div class="ch-time">${fmtTime(t)}</div><div class="ch-sub">${sub}</div>`;
  }

  // ---- menu
  function renderMenu() {
    menu.innerHTML = `<h2>Challenges</h2>` + list.map((c, i) =>
      `<button class="ch-item${i === sel ? ' sel' : ''}" data-i="${i}"><b>${c.name}</b>
        <span class="ch-meta">${(c.length / 1000).toFixed(1)} km · best ${fmtTime(best[c.id]?.time)}</span>
        <span class="ch-desc">${c.desc}</span></button>`).join('') +
      `<div class="ch-hint">↑/↓ + Enter or click to start · J or Esc to close${state !== 'idle' ? ' · Backspace restarts a run' : ''}</div>`;
    menu.querySelectorAll('.ch-item').forEach(b => b.addEventListener('click', () => start(+b.dataset.i)));
  }
  function openMenu() { menuOpen = true; done.style.display = 'none'; renderMenu(); menu.style.display = 'block'; }
  function closeMenu() { menuOpen = false; menu.style.display = 'none'; if (state === 'finished') done.style.display = 'block'; }

  // capture phase: runs before the map's own Esc handler, so Esc with the full map open only closes the map
  addEventListener('keydown', e => {
    if (e.repeat) return;
    if (e.code === 'KeyJ') { menuOpen ? closeMenu() : openMenu(); return; }
    if (menuOpen) {
      if (e.code === 'ArrowDown' || e.code === 'ArrowUp') { sel = (sel + (e.code === 'ArrowDown' ? 1 : list.length - 1)) % list.length; renderMenu(); }
      else if (e.code === 'Enter') start(sel);
      else if (e.code === 'Escape') closeMenu();
      return;
    }
    if (minimap.open) return;          // Esc closes the full map first
    if (state === 'finished' && e.code === 'Enter') start(sel);
    else if (state !== 'idle' && e.code === 'Backspace') { e.preventDefault(); start(sel); }
    else if (state !== 'idle' && (e.code === 'Escape' || e.code === 'KeyH')) quit();
  }, true);

  return {
    list, get state() { return state; }, get time() { return t; }, get next() { return next; }, get menuOpen() { return menuOpen; },
    best: () => best, start, quit, openMenu, closeMenu,
    // hold the car on the line during the countdown (and while the menu is open)
    holdInput(input) {
      if (state === 'placing' || state === 'countdown' || menuOpen) { input.throttle = 0; input.brake = 0; input.handbrake = true; input.steer = 0; }   // no brake: at a standstill it means reverse
    },
    update(dt) {
      curPos.set(car.pos.x, car.pos.z);
      if (ch) {
        // drop arches onto the ground once their tile has streamed in
        for (const q of ramps) if (!q.grp) {
          const { x, z, yaw } = q.r, ex = x + Math.sin(yaw) * RAMP_LEN, ez = z + Math.cos(yaw) * RAMP_LEN;
          if (world.loadedAt(x, z) && world.loadedAt(ex, ez)) { q.grp = makeRamp(world, q.r); group.add(q.grp); }
        }
        for (const a of arches) if (!a.placed && world.loadedAt(a.grp.position.x, a.grp.position.z)) {
          a.grp.position.y = world.heightAt(a.grp.position.x, a.grp.position.z) - 0.2; a.placed = true;
          if (state === 'running' || state === 'countdown') styleArches();
        }
      }
      if (state === 'countdown') {
        const before = Math.ceil(cd); cd -= dt; const now = Math.ceil(cd);
        if (cd <= 0) { state = 'running'; t = 0; count.textContent = 'GO!'; blip(880, 0.35); setTimeout(() => { if (count.textContent === 'GO!') count.style.display = 'none'; }, 700); }
        else if (now !== before) { count.textContent = String(now); blip(440, 0.15); }
      } else if (state === 'running') {
        t += dt;
        // a teleport (R reset) is not a crossing: only count normal movement
        if (curPos.distanceTo(lastPos) < 40 && crossed(ch.gates[next])) passGate();
      }
      if (splitT > 0 && (splitT -= dt) <= 0) split.style.opacity = 0;
      if (state !== 'idle') renderHud();
      lastPos.copy(curPos);
      if (beam.visible) { const p = 0.22 + 0.08 * Math.sin(performance.now() / 250); MAT.beam.opacity = p; }
    },
  };
}
