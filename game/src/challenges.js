// Timed challenges: point-to-point runs through checkpoint arches (routes planned by tools/challenge_routes.py).
// J opens the race menu (racemenu.js), as does driving slowly into a race's start ring in free roam (racemarkers.js);
// starting one puts the car on the start line, counts 3-2-1-GO, then times you through every checkpoint in order to
// the finish. Best times (and their checkpoint splits) and the best medal per race (medals.js) are saved per browser.
import * as THREE from 'three';
import { RAMP, RAMP_LEN, rampShape } from './data.js';
import { makeTrack } from './track.js';
import { makeRaceBarriers, raceBounds } from './racebarriers.js';
import { buildRaceBarrierModel } from './racebarriermodel.js';
import { gridTrack } from './mp/collide.js';
import { createGhost } from './ghost.js';
import { createRewards } from './rewards.js';
import { checkpointStart, drivingWrongWay } from './raceguidance.js';
import { fmtDist, fmtHeight } from './units.js';
import { createMedals, nextMedal, MEDALS, MEDAL_ICON, MEDAL_NAME } from './medals.js';
import { createRaceMenu } from './racemenu.js';
import { createRaceMarkers } from './racemarkers.js';
import { raceLoadPoints, raceGroundProgress, createRaceLoadState, createRaceLoadingView } from './raceloading.js';

const BEST_KEY = 'yr-best-1';
const POST_H = 7, COUNTDOWN = 3;

const CSS = `
#ch-hud { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); text-align: center; color: #fff;
  text-shadow: 0 1px 4px #000c; pointer-events: none; display: none; font-variant-numeric: tabular-nums; }
#fullmap.open ~ #ch-hud, #fullmap.open ~ #ch-split { display: none !important; }
#ch-hud .ch-name { font-size: 13px; font-weight: 700; opacity: .9; }
#ch-hud .ch-time { font-size: 40px; font-weight: 800; line-height: 1.05; }
#ch-hud .ch-sub { font-size: 13px; opacity: .92; }
#ch-split { position: fixed; top: 172px; left: 50%; transform: translateX(-50%); font: 800 26px system-ui, sans-serif;
  color: #fff; text-shadow: 0 1px 4px #000c; pointer-events: none; opacity: 0; transition: opacity .3s;
  font-variant-numeric: tabular-nums; white-space: nowrap; }
#ch-split .ahead { color: #5df07a; } #ch-split .behind { color: #ff6b5e; }
#ch-count { position: fixed; top: 34%; left: 50%; transform: translate(-50%, -50%); font: 900 120px system-ui, sans-serif;
  color: #fff; text-shadow: 0 4px 18px #000b; pointer-events: none; display: none; }
.ch-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(460px, 90vw);
  background: #142016ee; color: #fff; border-radius: 16px; box-shadow: 0 10px 40px #0008; padding: 20px 22px;
  display: none; font-size: 14px; }
.ch-panel h2 { margin: 0 0 12px; font-size: 22px; }
.ch-panel .ch-hint { opacity: .65; font-size: 12px; margin-top: 10px; }
.ch-panel .ch-big { font-size: 48px; font-weight: 900; font-variant-numeric: tabular-nums; margin: 4px 0; }
.ch-panel .ch-new { color: #ffd23f; font-weight: 800; font-size: 18px; }
#ch-done .ch-medal { display: inline-flex; align-items: center; gap: 8px; margin: 2px 0 0; padding: 6px 16px 6px 10px; border-radius: 999px;
  font-weight: 900; font-size: 17px; letter-spacing: .02em; background: #ffffff10; border: 1px solid #ffffff30; }
#ch-done .ch-medal i { font-style: normal; font-size: 30px; line-height: 1; }
#ch-done .ch-medal.gold { background: #ffd23f26; border-color: #ffd23f; color: #ffe27a; }
#ch-done .ch-medal.silver { background: #dfe8ef1f; border-color: #cfd9e0; color: #eef4f8; }
#ch-done .ch-medal.bronze { background: #e0915326; border-color: #d98c55; color: #f2b98d; }
#ch-done .ch-medal.none { font-size: 14px; color: #c3d5c8; }
#ch-done .ch-medal-new { display: block; color: #ffd23f; font-weight: 800; font-size: 12px; letter-spacing: .12em; margin-top: 6px; }
#ch-done .ch-pb, #ch-done .ch-medal-next { color: #c3d5c8; font-size: 13px; margin-top: 4px; font-variant-numeric: tabular-nums; }
#ch-done .ch-pb b { color: #fff; }
#ch-done .ch-targets { display: flex; justify-content: center; gap: 6px; margin: 12px 0 0; flex-wrap: wrap; }
#ch-done .ch-targets span { padding: 3px 9px; border-radius: 999px; background: #ffffff0d; border: 1px solid #ffffff22; font-size: 12px;
  font-weight: 700; font-variant-numeric: tabular-nums; color: #9fb4a6; }
#ch-done .ch-targets span.got { color: #fff; border-color: #eac17c99; background: #eac17c22; }
#ch-done .ch-splits { margin: 14px auto 0; max-width: 340px; max-height: 168px; overflow-y: auto; text-align: left; font-size: 12.5px;
  font-variant-numeric: tabular-nums; border-top: 1px solid #ffffff18; padding-top: 6px; }
#ch-done .ch-splits div { display: flex; gap: 10px; padding: 2px 4px; }
#ch-done .ch-splits div:nth-child(odd) { background: #ffffff06; }
#ch-done .ch-splits span { width: 86px; color: #acc5b4; } #ch-done .ch-splits b { font-weight: 700; }
#ch-done .ch-splits em { margin-left: auto; font-style: normal; } #ch-done .ch-splits .ahead { color: #5df07a; } #ch-done .ch-splits .behind { color: #ff6b5e; }
#ch-done .ch-splits .ch-fin { border-top: 1px solid #ffffff18; font-weight: 800; }
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
  if (g.y !== undefined) {                 // jet races: a ring floating in the air, facing along the course
    const ring = new THREE.Mesh(new THREE.TorusGeometry(g.r, Math.max(1.2, g.r * 0.05), 8, 40), kind === 'finish' ? MAT.ringFinish : MAT.later);
    grp.add(ring); grp.position.set(g.x, g.y, g.z); grp.rotation.y = g.yaw; grp.visible = false;
    return { grp, bar: ring, kind, placed: true, ring: true };
  }
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
// onPlace(): a race is putting the car somewhere (start, restart, checkpoint): main.js drops a waiting respawn hold
// canOpenMenu(): false while the race menu may not open (the spawn map, the Garage); onMenuOpen(): it is opening (J, ☰
// Menu → Races, a start ring): main.js closes the other panels and drops held keys, as the V picker's onOpen does;
// canAutoOpen(): false while a start ring must not pop the menu up by itself (Settings, How to play, the ☰ Menu, …)
export async function createChallenges({ scene, world, car, minimap, vehicles = null, audio = null, base ='./assets/', onPlace = () => {},
  canOpenMenu = () => true, onMenuOpen = () => {}, canAutoOpen = () => true, compileRace = () => null }) {
  const list = await fetch(base + 'challenges.json').then(r => r.json());
  const ghost = createGhost({ scene });
  const rewards = createRewards();
  // the map's fixed ramps (always there, not part of any challenge)
  const fixedList = await fetch(base + 'ramps.json').then(r => r.ok ? r.json() : []).catch(() => []);
  const fixedRamps = fixedList.map(r => ({ r, grp: null }));
  world.setFixedRamps?.(fixedList);
  MAT.finish = new THREE.MeshBasicMaterial({ map: checkerTexture() });
  MAT.ringFinish = new THREE.MeshBasicMaterial({ color: 0xffd23f });
  RAMP_MAT = new THREE.MeshLambertMaterial({ map: chevronTexture() });
  MAT.finish.map.repeat.set(4, 1); MAT.finish.map.wrapS = THREE.RepeatWrapping;

  const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
  const hud = el('div', 'ch-hud'), split = el('div', 'ch-split'), count = el('div', 'ch-count');
  const done = el('div', 'ch-done', 'ch-panel');
  function el(tag, id, cls) { const e = document.createElement(tag); e.id = id; if (cls) e.className = cls; document.body.append(e); return e; }

  let best = {};
  try { best = JSON.parse(localStorage.getItem(BEST_KEY) || '{}'); } catch {}
  if (!best || typeof best !== 'object' || Array.isArray(best)) best = {};
  rewards.importBests(list, best);
  const medals = createMedals();
  medals.importBests(list, best);
  const saveBest = () => { try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch {} };
  // the race menu, built the first time it opens; menuClosed: it closed itself (Esc, ✕, a click outside), the finish
  // panel comes back if it was up
  let raceMenu = null, loading = null;
  const loadingView = createRaceLoadingView({ fmtTime, base });
  const menuUI = () => raceMenu ||= createRaceMenu({ list, best: () => best, medals, rewards, fmtTime, base, racing: () => state !== 'idle',
    onStart: i => start(i), onInvite: i => mpHook?.pick?.(i), canInvite: () => !!mpHook?.canInvite?.(), onClose: () => menuClosed() });

  const group = new THREE.Group(); scene.add(group);
  const beam = new THREE.Mesh(BEAM, MAT.beam); beam.visible = false; beam.renderOrder = 5; beam.frustumCulled = false;
  group.add(beam);
  const markers = createRaceMarkers({ scene, world, list, car,
    isOpen: () => menuOpen || !!minimap.open || !!vehicles?.open || !canOpenMenu() || !canAutoOpen(),
    onEnter: i => openMenu(i, { filter: 'all' }) });

  // state: 'idle' | 'placing' | 'countdown' | 'running' | 'finished'
  let ch = null, arches = [], state = 'idle', t = 0, cd = 0, next = 1, splits = [], splitT = 0, sel = 0, result = null;
  let menuOpen = false, placeToken = 0, returning = false, wrongWayTime = 0;
  // multiplayer (mp/races.js): optional hook + a relay-clock start { at, now }; a late player joins that shared clock
  let mpHook = null, sync = null;
  const lastPos = new THREE.Vector2(), curPos = new THREE.Vector2();
  let lastY = 0, curY = 0;

  // ---- sound blips (the game's shared audio context, through the Master volume; silent until the first input starts it)
  function blip(freq, dur = 0.12, vol = 0.18) {
    try {
      audio?.start();
      const ac = audio?.ctx, out = audio?.mixer?.master;
      if (!ac || !out) return;
      const o = ac.createOscillator(), g = ac.createGain(), now = ac.currentTime;
      o.type = 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, now); g.gain.exponentialRampToValueAtTime(0.001, now + dur);
      o.connect(g).connect(out); o.start(now); o.stop(now + dur);
    } catch {}
  }

  let track = null, bounds = null, barrierModel = null, barrierTick = 0;
  function clearBarriers() {
    world.setRaceBarriers?.(null);
    if (barrierModel) { group.remove(barrierModel.mesh); barrierModel.dispose(); barrierModel = null; }
    bounds = null;
  }
  function clearArches() {
    for (const a of arches) group.remove(a.grp); arches = []; beam.visible = false;
    clearBarriers(); track = null;
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
      if (a.ring) a.grp.visible = i >= next || (i === 0 && state !== 'running');
    });
    const g = ch.gates[next];
    beam.visible = !!g && (state === 'running' || state === 'countdown');
    if (g) { beam.position.set(g.x, arches[next].grp.position.y, g.z); MAT.beam.color.set(next === ch.gates.length - 1 ? 0xffd23f : 0x35e0ff); }
    minimap.setOverlay?.(ch && state !== 'idle' ? { route: ch.route, gates: ch.gates, next } : null);
  }

  // place the car on the start line once the tiles there have streamed in
  // A respawn waiting for its ground (respawnhold.js) is dropped when this begins and again right before the car is put
  // down (one could start meanwhile), so the race's placement always wins.
  async function placeCar(x, z, yaw, requireLoaded = false) {
    const token = ++placeToken;
    onPlace();
    for (let k = 0; k < 80 && !(world.loadedAt(x, z) && world.pendingTiles() === 0); k++) {
      car.pos.set(x, car.pos.y, z); car.vel.set(0, 0, 0); car._lastLoaded = null;
      await new Promise(r => setTimeout(r, 150));
      if (token !== placeToken) return false;
    }
    if (token !== placeToken || (requireLoaded && !world.loadedAt(x, z))) return false;
    onPlace();
    car.reset(x, z, yaw); car.safe = []; car._lastLoaded = null;
    return true;
  }

  async function returnToCheckpoint() {
    if (returning) return;
    returning = true; wrongWayTime = 0;
    const run = ch, token = placeToken + 1, p = checkpointStart(ch, next);
    car.glide?.cancel();
    const placed = await placeCar(p.x, p.z, p.yaw, true);
    if (ch !== run || state !== 'running' || placeToken !== token) return;
    returning = false;
    if (!placed) { split.textContent = 'Checkpoint is still loading — try R again'; split.style.opacity = 1; splitT = 2.5; return; }
    track?.reset(); bounds?.reset(); lastPos.set(car.pos.x, car.pos.z); curPos.copy(lastPos); lastY = curY = car.pos.y;
  }

  async function start(i, opts = {}) {
    if (!opts.mp) mpHook?.onLocalStart?.();
    loading?.cancel(); loadingView.hide(); world.setRaceLoadPoints?.([]);
    sync = opts.sync || null;
    ghost.stop();
    ch = list[i]; sel = i; result = null; returning = false; wrongWayTime = 0;
    closeMenu(); done.style.display = 'none';
    vehicles?.switchTo(ch.vehicle || 'car', { place: false });
    car.glide?.cancel();
    // jet races: a crash (or R) puts you back in the air at the last ring you flew through
    if (vehicles) vehicles.jet.respawn = ch.vehicle === 'jet' ? () => {
      if (state !== 'running' || next < 2) return null;
      const g = ch.gates[next - 1]; return [g.x, g.y, g.z, g.yaw, 450];
    } : null;
    state = 'placing'; count.style.display = 'none';
    loadingView.show(ch);
    buildArches();
    const points = ch.vehicle !== 'jet' && ch.track
      ? (opts.mp ? gridTrack(ch.track, ch.start, opts.gridCount, ch.vehicle) : ch.track) : null;
    track = points ? makeTrack(points) : null;
    if (track) {
      const layer = makeRaceBarriers(points, world);
      world.setRaceBarriers?.(layer); bounds = raceBounds(track);
      barrierModel = buildRaceBarrierModel(layer); group.add(barrierModel.mesh); barrierTick = 0;
    }
    state = 'placing'; next = 1; t = 0; splits = [];
    hud.style.display = 'block'; renderHud();
    const startPose = opts.mp && opts.grid ? opts.grid : ch.start;
    const token = ++placeToken, run = ch;
    const samples = raceLoadPoints(run, startPose);
    world.setRaceLoadPoints?.(samples);
    const load = loading = createRaceLoadState({ sync });
    onPlace();
    car.pos.set(startPose.x, car.pos.y, startPose.z); car.vel.set(0, 0, 0); car._lastLoaded = null;
    car.savePrev?.(); car.interpolate?.(0);
    let compiled = false, compiling = false, status;
    do {
      if (token !== placeToken || loading !== load) return;
      // Placement keeps ownership if a crash/remote control requests a respawn during the wait.
      onPlace(); car.pos.x = startPose.x; car.pos.z = startPose.z; car.vel.set(0, 0, 0); car._lastLoaded = null;
      car.savePrev?.(); car.interpolate?.(0);
      barrierModel?.update();
      // Only the prepared part of the course must be placed now; distant checkpoints stream normally during play.
      for (const a of arches) if (!a.placed && world.loadedAt(a.grp.position.x, a.grp.position.z)) {
        a.grp.position.y = world.heightAt(a.grp.position.x, a.grp.position.z) - .2; a.placed = true;
      }
      const ground = world.raceLoadProgress?.() ?? raceGroundProgress(world, samples);
      const furniture = (!barrierModel || barrierModel.readyNear(samples)) && arches.every(a => a.placed ||
        !samples.some(([x, z]) => Math.hypot(a.grp.position.x - x, a.grp.position.z - z) < 150));
      if (ground === 1 && furniture && !compiling) {
        compiling = true;
        onPlace(); car.reset(startPose.x, startPose.z, startPose.yaw); car.safe = []; car._lastLoaded = null;
        styleArches(); car.syncMesh?.(0);
        // Compile the race scene (including the active vehicle, arches and new barrier material) with its real lights.
        Promise.resolve().then(() => token === placeToken && compileRace()).then(() => { compiled = true; }).catch(e => console.warn('race loading compile:', e));
      }
      status = load.update({ ground, furniture, compiled });
      loadingView.update(status);
      if (status.phase !== 'done') await new Promise(r => setTimeout(r, 50));
    } while (status.phase !== 'done');
    if (token !== placeToken || loading !== load) return;
    loading = null; loadingView.hide(); world.setRaceLoadPoints?.([]);
    onPlace(); car.reset(startPose.x, startPose.z, startPose.yaw); car.safe = []; car._lastLoaded = null;
    if (status.timedOut) { split.textContent = 'Course still loading — starting with available scenery'; split.style.opacity = 1; splitT = 6; }
    if (opts.mp && sync) car.ghostUntil = Math.max(car.ghostUntil || 0, sync.at + 3000);
    state = 'countdown'; cd = sync ? (sync.at - sync.now()) / 1000 : COUNTDOWN; styleArches();
    count.style.display = 'block'; count.textContent = String(sync ? Math.max(1, Math.ceil(cd)) : 3); blip(440, 0.15);
  }

  function quit() {
    mpHook?.onQuit?.(); sync = null;
    ghost.stop();
    loading?.cancel(); loading = null; loadingView.hide(); world.setRaceLoadPoints?.([]);
    returning = false; wrongWayTime = 0; placeToken++; state = 'idle'; ch = null; clearArches();
    if (vehicles) vehicles.jet.respawn = null;
    hud.style.display = 'none'; count.style.display = 'none'; done.style.display = 'none'; split.style.opacity = 0;
    minimap.setOverlay?.(null);
  }

  // ---- finish screen: time, medal, personal best, medal targets, splits against the previous best, actions
  function medalHtml(won, time) {
    const up = nextMedal(time, ch.medals);
    const next = up ? `<div class="ch-medal-next">${MEDAL_ICON[up.medal]} ${MEDAL_NAME[up.medal]} needs ${fmtTime(up.target)} · ${fmtDelta(up.gap)}</div>` : '';
    if (!won.medal) return ch.medals ? `<div class="ch-medal none">No medal</div>${next}` : '';
    return `<div class="ch-medal ${won.medal}"><i>${MEDAL_ICON[won.medal]}</i>${MEDAL_NAME[won.medal]}</div>` +
      (won.improved ? `<span class="ch-medal-new">${won.prev ? 'BETTER MEDAL' : 'NEW MEDAL'}</span>` : '') + next;
  }
  function targetsHtml(have) {
    if (!ch.medals) return '';
    return `<div class="ch-targets">${MEDALS.map(m => `<span class="${have && MEDALS.indexOf(m) >= MEDALS.indexOf(have) ? 'got' : ''}">${MEDAL_ICON[m]} ${fmtTime(ch.medals[m])}</span>`).join('')}</div>`;
  }
  // this run's checkpoint times, each against the previous best run's (prevSplits / prevTime: null = first run)
  function splitsHtml(prevSplits, prevTime, time) {
    if (!splits.length) return '';
    const ring = ch.vehicle === 'jet', row = (label, v, b, cls = '') =>
      `<div class="${cls}"><span>${label}</span><b>${fmtTime(v)}</b>${b != null ? `<em class="${v <= b ? 'ahead' : 'behind'}">${fmtDelta(v - b)}</em>` : '<em></em>'}</div>`;
    return `<div class="ch-splits" aria-label="Splits">${splits.map((v, i) => row(`${ring ? 'Ring' : 'Checkpoint'} ${i + 1}`, v, prevSplits?.[i])).join('')}${row('Finish', time, prevTime, 'ch-fin')}</div>`;
  }
  const ACTIONS = `<div class="ch-actions"><button data-action="retry">Race again</button><button data-action="next">Next race</button><button data-action="races">Choose race</button><button data-action="roam">Free roam</button></div>
      <div class="ch-hint">Enter race again · N next race · J races · Esc free roam</div>`;
  function wireActions() {
    done.querySelector('[data-action="retry"]').addEventListener('click', () => start(sel));
    done.querySelector('[data-action="next"]').addEventListener('click', nextRace);
    done.querySelector('[data-action="races"]').addEventListener('click', () => openMenu());
    done.querySelector('[data-action="roam"]').addEventListener('click', quit);
  }
  const nextRace = () => start(raceMenu ? raceMenu.nextAfter(sel) : (sel + 1) % list.length);

  function finish() {
    state = 'finished'; clearBarriers();
    const prev = best[ch.id];
    const isBest = !prev || t < prev.time;
    ghost.finish(t, car, isBest);
    if (isBest) { best[ch.id] = { time: t, splits: splits.slice(), date: new Date().toLocaleDateString('en-CA') }; saveBest(); }
    const won = medals.record(ch, t);
    result = { time: t, prev: prev?.time, isBest, medal: won.medal };
    const unlocked = rewards.complete(ch, t);
    blip(880, 0.12); setTimeout(() => blip(1320, 0.3), 130);
    beam.visible = false; minimap.setOverlay?.(null); split.style.opacity = 0; splitT = 0;
    done.innerHTML = `<h2>${ch.name}</h2>
      ${medalHtml(won, t)}
      <div class="ch-big">${fmtTime(t)}</div>
      ${isBest ? `<div class="ch-new">${prev ? `New best! ${fmtDelta(t - prev.time)}` : 'First time set!'}</div>`
               : `<div>Best ${fmtTime(prev.time)} · ${fmtDelta(t - prev.time)}</div>`}
      <div class="ch-pb">Personal best <b>${fmtTime(best[ch.id].time)}</b></div>
      ${targetsHtml(medals.get(ch.id))}
      ${splitsHtml(prev?.splits, prev?.time, t)}
      ${unlocked.map(r => `<div class="ch-reward"><span>NEW LIVERY UNLOCKED</span><strong>${r.name}</strong><small>Available in your Garage</small></div>`).join('')}
      <div id="ch-mp-results"></div>
      ${ACTIONS}`;
    wireActions();
    done.style.display = 'block';
    mpHook?.onFinish?.(t);
  }

  // Barrier escape or multiplayer deadline: end the run as DNF, preserving free-roam driving control.
  function dnf(reason = null) {
    if (state !== 'placing' && state !== 'countdown' && state !== 'running') return;
    ghost.stop(); returning = false; wrongWayTime = 0; placeToken++; state = 'finished'; clearBarriers();
    result = { dnf: true, reason };
    beam.visible = false; count.style.display = 'none'; minimap.setOverlay?.(null); split.style.opacity = 0; splitT = 0;
    done.innerHTML = `<h2>${ch.name}</h2>
      <div class="ch-big">DNF</div>
      ${reason ? `<div class="ch-new">${reason}</div>` : ''}
      ${best[ch.id] ? `<div class="ch-pb">Personal best <b>${fmtTime(best[ch.id].time)}</b></div>` : ''}
      <div id="ch-mp-results"></div>
      ${ACTIONS}`;
    wireActions();
    done.style.display = 'block';
    mpHook?.onDnf?.();
  }

  // ---- checkpoint crossing: the car's path this frame crosses the arch line between the posts
  function crossed(g) {
    const cx = Math.cos(g.yaw), cz = -Math.sin(g.yaw);       // across the road (local x)
    const fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);        // along the route
    const d0 = (lastPos.x - g.x) * fx + (lastPos.y - g.z) * fz, d1 = (curPos.x - g.x) * fx + (curPos.y - g.z) * fz;
    if (d0 > 0 || d1 < 0 || d0 === d1) return false;
    const k = -d0 / (d1 - d0);
    const ix = lastPos.x + (curPos.x - lastPos.x) * k, iz = lastPos.y + (curPos.y - lastPos.y) * k;
    if (g.y !== undefined) {                 // a ring: through the hole, not just across the line
      const iy = lastY + (curY - lastY) * k;
      return Math.hypot((ix - g.x) * cx + (iz - g.z) * cz, iy - g.y) <= g.r + 1;
    }
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
    mpHook?.onGate?.(next);
    if (isFinish) finish(); else styleArches();
  }

  function renderHud() {
    if (!ch) return;
    const n = ch.gates.length - 1;
    let sub = '';
    if (state === 'placing') sub = 'Getting to the start…';
    else if (state === 'running' || state === 'countdown') {
      const g = ch.gates[next], dist = g ? Math.hypot(g.x - car.pos.x, g.z - car.pos.z) : 0;
      sub = `${next === n ? 'Finish' : `${g?.y !== undefined ? 'Ring' : 'Checkpoint'} ${next}/${n - 1}`} · ${fmtDist(dist)}`;
      if (g?.y !== undefined) { const dy = g.y - car.pos.y; sub += ` · ${Math.abs(dy) < 8 ? 'level' : (dy > 0 ? '↑ ' : '↓ ') + fmtHeight(Math.abs(dy))}`; }
      if (returning) sub = 'Returning to checkpoint…';
      else if (wrongWayTime >= 1) sub += ' · WRONG WAY · turn around';
      const b = best[ch.id]; if (b) sub += ` · best ${fmtTime(b.time)}`;
    } else if (state === 'finished') sub = result?.dnf ? (result.reason || 'DNF') : 'Finished';
    hud.innerHTML = `<div class="ch-name">${ch.name}</div><div class="ch-time">${fmtTime(t)}</div><div class="ch-sub">${sub}</div>${mpHook?.hudHtml?.() || ''}`;
  }

  // ---- menu (racemenu.js); i: a race to select (a start ring); none (J, ☰ Menu, Choose race): the card and filter you
  // last had in the menu (the first time: the race you last started). opts.filter: 'car' | 'bike' | 'jet' | 'all';
  // opts.from: the button that opened it (☰ Menu → Races): Esc / ✕ / a click outside give focus back there
  function openMenu(i = null, opts = {}) {
    if (state === 'placing') return;
    if (!menuOpen) { if (!canOpenMenu()) return; onMenuOpen(); }
    const first = !raceMenu;
    menuOpen = true; done.style.display = 'none'; menuUI().show(i ?? (first ? sel : null), opts);
  }
  function menuClosed() { menuOpen = false; if (state === 'finished') done.style.display = 'block'; }
  function closeMenu() { raceMenu?.close(); menuClosed(); }

  // capture phase: runs before the map's own Esc handler, so Esc with the full map open only closes the map
  addEventListener('keydown', e => {
    if (e.gameUI) return;
    if (state === 'placing' && e.code !== 'Escape' && e.code !== 'KeyH') { e.preventDefault(); e.stopImmediatePropagation(); return; }
    // Let the focused finish action receive its native Enter/Space click instead of
    // interpreting every Enter as retry (or Space as a driving input).
    if (state === 'finished' && /^(Enter|NumpadEnter|Space)$/.test(e.code) && e.target?.closest?.('#ch-done button')) { e.gameUI = true; return; }
    if (e.code === 'KeyR' && state === 'running' && ch.vehicle !== 'jet') {
      e.preventDefault(); e.stopImmediatePropagation();
      if (!e.repeat) returnToCheckpoint();
      return;
    }
    // the menu's keys (held arrows repeat)
    if (menuOpen && e.code !== 'KeyJ') { if (!e.repeat || e.code.startsWith('Arrow')) menuUI().keydown(e); return; }
    if (e.repeat) return;
    if (e.code === 'KeyG' && car.glide && (state === 'placing' || state === 'countdown' || state === 'running')) {
      car.glide.cancel(); car.glide.say('No glider in races', 1.8);
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (e.code === 'KeyJ') { menuOpen ? closeMenu() : openMenu(); return; }
    if (minimap.open) return;          // Esc closes the full map first
    if (state === 'finished' && e.code === 'Enter') start(sel);
    else if (state === 'finished' && e.code === 'KeyN') nextRace();
    else if (state !== 'idle' && e.code === 'Backspace') { e.preventDefault(); start(sel); }
    else if (state !== 'idle' && (e.code === 'Escape' || e.code === 'KeyH')) quit();
  }, true);

  return {
    get blocked() { return state === 'placing'; },
    list, get state() { return state; }, get vehicle() { return ch?.vehicle || 'car'; }, get time() { return t; }, get next() { return next; }, get menuOpen() { return menuOpen; },
    set mpHook(h) { mpHook = h; }, runInfo: () => ch && { id: ch.id, name: ch.name, gates: ch.gates, track: ch.track, route: ch.route, next, state, t },
    dnf, rewards, medals, get raceMenu() { return menuUI(); }, markers, best: () => best, start, quit, openMenu, closeMenu, get result() { return result; },
    // Race rules after each fixed physics step. Contacts are handled by the world collider layer.
    constrain(dt = 1 / 120) {
      if (returning || (state !== 'countdown' && state !== 'running')) return;
      // Also fold a wing opened before the race or through another control path.
      if (car.glide?.active) { car.glide.cancel(); car.glide.say('No glider in races', 1.8); }
      if (bounds?.update(car, dt)) dnf('Out of bounds — race over');
    },
    get track() { return track; },
    // hold the car on the line during the countdown (and while the menu is open)
    holdInput(input) {
      const hold = returning || state === 'placing' || state === 'countdown' || menuOpen;
      if (hold) { input.throttle = 0; input.brake = 0; input.handbrake = true; input.steer = 0; input.lean = false; }
      if (input.jet) input.jet.hold = hold;             // jet: brakes on (you can run the throttle up)   // no brake: at a standstill it means reverse
    },
    update(dt) {
      curPos.set(car.pos.x, car.pos.z); curY = car.pos.y;
      for (const q of fixedRamps) if (!q.grp) {           // fixed ramps: mesh once the road under them has loaded
        const { x, z, yaw } = q.r, ex = x + Math.sin(yaw) * RAMP_LEN, ez = z + Math.cos(yaw) * RAMP_LEN;
        if (world.loadedAt(x, z) && world.loadedAt(ex, ez)) { q.grp = makeRamp(world, q.r); group.add(q.grp); }
      }
      if (barrierModel && (barrierTick -= dt) <= 0) { barrierModel.update(); barrierTick = 0.25; }
      if (ch) {
        // drop arches onto the ground once their tile has streamed in
        for (const a of arches) if (!a.placed && world.loadedAt(a.grp.position.x, a.grp.position.z)) {
          a.grp.position.y = world.heightAt(a.grp.position.x, a.grp.position.z) - 0.2; a.placed = true;
          if (state === 'running' || state === 'countdown') styleArches();
        }
      }
      if (state === 'countdown') {
        const before = Math.ceil(cd); if (sync) cd = (sync.at - sync.now()) / 1000; else cd -= dt; const now = Math.ceil(cd);
        if (cd <= 0) { state = 'running'; t = sync ? -cd : 0; ghost.start(ch, car); count.textContent = 'GO!'; blip(880, 0.35); setTimeout(() => { if (count.textContent === 'GO!') count.style.display = 'none'; }, 700); }
        else if (now !== before) { count.textContent = String(now); blip(440, 0.15); }
      } else if (state === 'running') {
        if (sync) t = Math.max(0, (sync.now() - sync.at) / 1000); else t += dt;
        ghost.update(t, car);
        wrongWayTime = !returning && track && drivingWrongWay(car.vel, ch.track, track.index) ? wrongWayTime + dt : 0;
        // a teleport (R reset) is not a crossing: only count normal movement
        if (!returning && curPos.distanceTo(lastPos) < 40 && crossed(ch.gates[next])) passGate();
      }
      markers.update(dt, state === 'idle');
      if (splitT > 0 && (splitT -= dt) <= 0) split.style.opacity = 0;
      if (state !== 'idle') renderHud();
      lastPos.copy(curPos); lastY = curY;
      if (beam.visible) { const p = 0.22 + 0.08 * Math.sin(performance.now() / 250); MAT.beam.opacity = p; }
    },
  };
}
