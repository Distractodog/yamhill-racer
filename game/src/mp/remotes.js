// Other players in a multiplayer game: their vehicle in their own skin, their glider, a name tag, and a named dot on
// the corner and full maps. Drawing and collision prediction; physics responses live in collide.js.
// Everything comes through `mp` (net.js): roster / joined / left keep the list, 'state' (~15 Hz) moves them, 'skin'
// repaints them.
// Smoothing: states are kept in a short buffer on the relay clock and drawn DELAY ms in the past, between two states;
// when the next one is late the vehicle carries on along its last velocity for up to MAX_EXTRAP ms, then holds. A late
// state that lands somewhere else is blended in over a few frames (a jump of more than SNAP m just snaps).
// Speed: every vehicle model is baked once into one vertex-coloured mesh (one draw call; decals and the jet flame stay
// separate), cached per vehicle kind and only rebuilt when that player's colours change; far away a plain block
// stands in for it.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { paintedModel, sanitizeCosmetics } from '../cosmetics.js';
import { buildGliderModel, BIKE_GLIDER } from '../glider.js';
import { setGliderColors } from '../glidercolors.js';

export const DELAY = 120;            // ms behind the newest states we draw
export const MAX_EXTRAP = 300;       // ms we carry on past the newest state
export const SNAP = 50;              // m: a correction bigger than this snaps instead of blending
export const STALE = 3000;           // ms without a state → hidden
export const TAG_FADE = 300, TAG_HIDE = 400;     // m: name tag fades out, then hides
const FAR = { car: 220, bike: 180, jet: 650 };   // m: past this a low-poly block stands in
const TAG_Y = { car: 1.5, bike: 2.0, jet: 3.6 }, GLIDER_TAG_Y = 1.1;
const KINDS = ['car', 'bike', 'jet'];
const fin = v => typeof v === 'number' && Number.isFinite(v);
const finArr = (a, n) => Array.isArray(a) && a.length === n && a.every(fin);

// ---------------------------------------------------------------- smoothing maths (pure, tested in Node)
// A buffered state: { t (relay ms), v, p:[x,y,z], q:Quaternion, vel:[x,y,z], glide }. Returns null for a bad message.
export function parseState(msg, t) {
  if (!msg || !finArr(msg.p, 3) || !finArr(msg.q, 4) || !fin(t)) return null;
  const q = new THREE.Quaternion(...msg.q); if (q.lengthSq() < 1e-6) return null;
  return { t, v: KINDS.includes(msg.v) ? msg.v : 'car', p: msg.p.slice(), q: q.normalize(),
    vel: finArr(msg.vel, 3) ? msg.vel.slice() : [0, 0, 0], glide: !!msg.glide, grounded: msg.grounded === true, mode: msg.mode,
    ghostUntil: fin(msg.ghostUntil) ? msg.ghostUntil : 0 };
}

// Add a state in time order (a repeat of the newest time replaces it) and drop what's too old to be drawn again.
export function pushState(buf, s, renderT = -Infinity) {
  const last = buf[buf.length - 1];
  if (last && s.t < last.t) return false;            // out of order: older than what we have
  if (last && s.t === last.t) buf[buf.length - 1] = s; else buf.push(s);
  while (buf.length > 2 && (buf[1].t < renderT - 500 || buf.length > 30)) buf.shift();
  return true;
}

// Pose at relay time t from the buffer (oldest first) into outP (Vector3), outQ (Quaternion), outV (Vector3, optional).
// Returns 'none' (empty), 'early' (before the oldest), 'interp', 'extrap' (past the newest, ≤ MAX_EXTRAP) or 'hold'.
export function poseAt(buf, t, outP, outQ, outV) {
  const n = buf.length; if (!n) return 'none';
  const put = (s, dt = 0) => {
    outP.set(s.p[0] + s.vel[0] * dt, s.p[1] + s.vel[1] * dt, s.p[2] + s.vel[2] * dt); outQ.copy(s.q);
    outV?.set(...s.vel);
  };
  if (t <= buf[0].t) { put(buf[0]); return 'early'; }
  const b = buf[n - 1];
  if (t >= b.t) {
    const late = t - b.t; put(b, Math.min(late, MAX_EXTRAP) / 1000);
    return late <= MAX_EXTRAP ? 'extrap' : 'hold';
  }
  let i = n - 1; while (i > 0 && buf[i - 1].t > t) i--;
  const A = buf[i - 1], B = buf[i], u = (t - A.t) / (B.t - A.t);
  // a teleport (reset, respawn): don't slide across the map, jump when the newer state's time comes
  const gap = Math.hypot(B.p[0] - A.p[0], B.p[1] - A.p[1], B.p[2] - A.p[2]);
  const fast = Math.max(Math.hypot(...A.vel), Math.hypot(...B.vel)) * (B.t - A.t) / 1000;
  if (gap > SNAP + 1.5 * fast) { put(A); return 'interp'; }
  outP.set(A.p[0] + (B.p[0] - A.p[0]) * u, A.p[1] + (B.p[1] - A.p[1]) * u, A.p[2] + (B.p[2] - A.p[2]) * u);
  outQ.slerpQuaternions(A.q, B.q, u);
  outV?.set(A.vel[0] + (B.vel[0] - A.vel[0]) * u, A.vel[1] + (B.vel[1] - A.vel[1]) * u, A.vel[2] + (B.vel[2] - A.vel[2]) * u);
  return 'interp';
}

// A smoothed player: the buffer plus a correction offset that absorbs jumps when a state arrives after we already
// extrapolated past it. receive() and pose() are all the per-player maths; meshes are built elsewhere.
export class Track {
  constructor() {
    this.buf = []; this.off = new THREE.Vector3(); this.qOff = new THREE.Quaternion(); this.lastRecv = -Infinity;
    this._p = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._p2 = new THREE.Vector3(); this._q2 = new THREE.Quaternion();
  }
  receive(s, now) {
    const renderT = now - DELAY, had = this.buf.length > 0;
    if (had) poseAt(this.buf, renderT, this._p, this._q);
    if (!pushState(this.buf, s, renderT)) return false;
    this.lastRecv = now;
    if (!had) return true;
    poseAt(this.buf, renderT, this._p2, this._q2);
    // keep what is drawn where it was: off = (old pose + old offset) − new pose
    this.off.add(this._p).sub(this._p2);
    this.qOff.multiply(this._q2.invert().premultiply(this._q)).normalize();   // qOff ← qOff · qOld · qNew⁻¹
    if (this.off.length() > SNAP) { this.off.set(0, 0, 0); this.qOff.identity(); }
    return true;
  }
  // pose at local frame time `now` (relay clock); dt eases the correction away. Returns poseAt's mode.
  pose(now, dt, outP, outQ, outV) {
    const mode = poseAt(this.buf, now - DELAY, outP, outQ, outV);
    const k = Math.exp(-dt * 6);
    this.off.multiplyScalar(k); if (this.off.lengthSq() < 1e-6) this.off.set(0, 0, 0);
    this.qOff.slerp(_qI, 1 - Math.exp(-dt * 8));
    outP.add(this.off); outQ.premultiply(this.qOff);
    return mode;
  }
  stale(now) { return !this.buf.length || now - this.lastRecv > STALE; }
  get latest() { return this.buf[this.buf.length - 1]; }
}
const _qI = new THREE.Quaternion();

// ---------------------------------------------------------------- meshes
const BODY_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const SAIL_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _c = new THREE.Color();

// Bake the visible meshes under `start` into one vertex-coloured geometry in `root`'s frame. Plain Lambert parts are
// merged (vertex colour = material colour × any vertex colour); textured / see-through parts (decals, the jet flame)
// come back as separate meshes in `extras` (Map original → copy) sharing their geometry and material.
export function bake(root, { start = root, skip = new Set(), material = BODY_MAT } = {}) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const parts = [], extras = new Map(), used = new Set();
  const walk = o => {
    if (!o.visible || skip.has(o)) return;
    if (o.isMesh && o.geometry) {
      const mat = o.material;
      _m.multiplyMatrices(_inv, o.matrixWorld);
      if (mat?.isMeshLambertMaterial && !mat.transparent && !mat.map) {
        const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
        for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(name)) g.deleteAttribute(name);
        if (!g.attributes.normal) g.computeVertexNormals();
        const n = g.attributes.position.count, col = new Float32Array(n * 3), src = mat.vertexColors ? g.attributes.color : null;
        _c.copy(mat.color);
        for (let i = 0; i < n; i++) {
          col[i * 3] = _c.r * (src ? src.getX(i) : 1); col[i * 3 + 1] = _c.g * (src ? src.getY(i) : 1); col[i * 3 + 2] = _c.b * (src ? src.getZ(i) : 1);
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.clearGroups(); g.applyMatrix4(_m); parts.push(g);
        used.add(o.geometry); used.add(mat);
      } else {
        const copy = new THREE.Mesh(o.geometry, mat);
        copy.matrixAutoUpdate = false; copy.matrix.copy(_m); copy.renderOrder = o.renderOrder; copy.castShadow = false;
        extras.set(o, copy);
      }
    }
    for (const c of o.children) walk(c);
  };
  walk(start);
  const geo = parts.length ? mergeGeometries(parts) : new THREE.BufferGeometry();
  parts.forEach(g => g.dispose());
  const mesh = new THREE.Mesh(geo, material); mesh.castShadow = true;
  for (const e of extras.values()) mesh.add(e);
  return { mesh, extras, used };
}
// free what the source model owned but the baked copy doesn't use
function disposeSource(model, keep) {
  model.traverse(o => {
    if (o.geometry && !keep.has(o.geometry)) o.geometry.dispose();
    if (o.material && !keep.has(o.material)) { o.material.map?.dispose(); o.material.dispose(); }
  });
}
function disposeBaked(b) {
  b.mesh.geometry.dispose();
  for (const e of b.extras.values()) { e.geometry.dispose(); e.material.map?.dispose(); e.material.dispose(); }
}

// One player's vehicle of one kind, painted and baked. Pivot sits on the ground line so the bike can lean over its tyres.
function buildBody(kind, colors) {
  const model = paintedModel(kind, colors), ud = model.userData;
  let gear = null, flame = null, skip = new Set();
  if (kind === 'jet') { ud.setGear(1); skip = new Set([ud.wheels[0].leg.parent]); }
  const body = bake(model, { skip });
  const keep = new Set([...body.extras.values()].flatMap(e => [e.geometry, e.material]));
  if (kind === 'jet') {
    gear = bake(model, { start: ud.wheels[0].leg.parent }).mesh; gear.castShadow = true;
    flame = body.extras.get(ud.flame) || null;
    if (flame) {      // animated: back to position / rotation / scale so a scale change reaches its matrix
      flame.material = flame.material.clone(); keep.add(flame.material);
      flame.matrix.decompose(flame.position, flame.quaternion, flame.scale); flame.matrixAutoUpdate = true;
      flame.userData.baseZ = flame.scale.z;
    }
  }
  disposeSource(model, keep);
  const pivot = new THREE.Group(), lift = kind === 'bike' ? 0.54 : 0;
  pivot.position.y = -lift; body.mesh.position.y = lift; pivot.add(body.mesh);
  if (gear) { gear.position.y = lift; pivot.add(gear); }
  return { kind, pivot, baked: body, gear, flame };
}
function disposeBody(b) { disposeBaked(b.baked); b.gear?.geometry.dispose(); b.pivot.removeFromParent(); }

function buildGlider(kind, palette) {
  const model = buildGliderModel(kind === 'bike' ? BIKE_GLIDER.model : undefined);
  setGliderColors(model, palette);
  const b = bake(model, { material: SAIL_MAT });
  disposeSource(model, new Set());
  return b.mesh;
}
// skin.glider may be one palette ({wing, stripe, accent}) or one per vehicle ({car:{…}, bike:{…}})
const gliderPalette = (glider, kind) => glider && typeof glider === 'object' ? (glider.wing ? glider : glider[kind] || {}) : {};

// far stand-ins: one shared block per kind, coloured per player
let standGeo = null;
function standGeometry(kind) {
  if (!standGeo) {
    const box = (w, h, d, x = 0, y = 0, z = 0) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    standGeo = {
      car: mergeGeometries([box(1.9, 0.45, 4.3, 0, -0.05, 0), box(0.6, 0.45, 1.2, 0, 0.35, -0.3), box(1.6, 0.1, 0.5, 0, 0.8, -2.0)]),
      bike: mergeGeometries([box(0.35, 0.9, 1.9, 0, -0.1, 0), box(0.4, 0.8, 0.4, 0, 0.75, -0.15)]),
      jet: mergeGeometries([box(1.4, 1.4, 14, 0, 0, 0.3), box(9.6, 0.15, 2.8, 0, 0, -1.2), box(4.8, 0.12, 1.4, 0, 0.1, -5.3), box(0.15, 2.4, 1.6, 0, 1.6, -4.9)]),
    };
  }
  return standGeo[kind];
}

function tagTexture(name, color, host) {
  if (typeof document === 'undefined') return { map: null, aspect: 4 };
  const c = document.createElement('canvas'), ctx = c.getContext('2d'), px = 44, font = `700 ${px}px system-ui, sans-serif`;
  ctx.font = font;
  const label = (host ? '★ ' : '') + name, w = Math.ceil(Math.min(ctx.measureText(label).width, 560)) + 60, h = 64;
  c.width = w; c.height = h;
  ctx.fillStyle = 'rgba(12,20,16,.78)'; ctx.beginPath(); ctx.roundRect(2, 2, w - 4, h - 4, 14); ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(10, 14, 12, h - 28, 5); ctx.fill();
  ctx.font = font; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(label, 34, h / 2 + 2, w - 44);
  const map = new THREE.CanvasTexture(c); map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4;
  return { map, aspect: w / h };
}

// ---------------------------------------------------------------- the remotes
// Async because it loads net.js itself (so main.js needs no second import of it); tests pass a stub `mp`.
export async function createRemotes(opts = {}) {
  let mp = opts.mp;
  if (!mp) try { ({ mp } = await import('./net.js')); } catch (e) { console.warn('Multiplayer remotes: net.js not loaded', e); }
  return makeRemotes({ ...opts, mp });
}

export function makeRemotes({ scene, camera, minimap, mp = null }) {
  const group = new THREE.Group(); group.name = 'mp-remotes'; scene?.add(group);
  const players = new Map();             // id → remote
  predictionPlayers = players;
  const now = () => (mp?.now ? mp.now() : performance.now());
  const myId = () => mp?.me?.id;
  // ms = smoothed per-frame cost without one-off model builds (buildMs = total time spent building models)
  const stats = { count: 0, visible: 0, near: 0, ms: 0, buildMs: 0 };
  let building = 0;
  const timed = fn => { const a = performance.now(), v = fn(); building += performance.now() - a; return v; };
  const P = new THREE.Vector3(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), F = new THREE.Vector3();

  function colorsFor(r, kind) { return r.colors[kind] || null; }
  function bodyColor(r, kind) { return sanitizeCosmetics(colorsFor(r, kind), kind).body; }
  function applySkin(r, skin) {
    if (!skin || typeof skin !== 'object') return;
    const kind = KINDS.includes(skin.vehicle) ? skin.vehicle : null;
    const sig = JSON.stringify([skin.colors, skin.glider]);
    if (kind && sig !== r.skinSig[kind]) {
      r.skinSig[kind] = sig; r.colors[kind] = skin.colors || null; r.glider[kind] = gliderPalette(skin.glider, kind);
      if (r.bodies[kind]) { disposeBody(r.bodies[kind]); r.bodies[kind] = null; }
      if (r.gliders[kind]) { r.gliders[kind].geometry.dispose(); r.gliders[kind].removeFromParent(); r.gliders[kind] = null; }
      if (kind === r.kind) r.standMat.color.set(bodyColor(r, kind));
      r.tagSig = '';
    }
  }
  function add(id, info = {}) {
    let r = players.get(id);
    if (!r) {
      const root = new THREE.Group(); root.name = 'mp-remote'; root.visible = false;
      const stand = new THREE.Mesh(standGeometry('car'), new THREE.MeshLambertMaterial({ color: 0xe8402f, flatShading: true }));
      stand.visible = false; root.add(stand);
      const tag = new THREE.Sprite(new THREE.SpriteMaterial({ depthTest: false, depthWrite: false, transparent: true, fog: false, sizeAttenuation: false }));
      tag.renderOrder = 20; tag.visible = false; tag.center.set(0.5, 0);
      group.add(root, tag);
      r = { id, name: 'Racer', host: false, track: new Track(), root, stand, standMat: stand.material, tag, tagSig: '', tagAspect: 4,
        kind: null, bodies: { car: null, bike: null, jet: null }, gliders: { car: null, bike: null }, colors: {}, glider: {}, skinSig: {},
        far: false, open: 0, lean: 0, heading: null, yawRate: 0, dist: Infinity, shown: false, x: 0, z: 0 };
      players.set(id, r);
    }
    if (typeof info.name === 'string' && info.name) r.name = info.name.slice(0, 24);
    if ('host' in info) r.host = !!info.host;
    applySkin(r, info.skin);
    return r;
  }
  function remove(id) {
    const r = players.get(id); if (!r) return;
    for (const k of KINDS) if (r.bodies[k]) disposeBody(r.bodies[k]);
    for (const g of Object.values(r.gliders)) g?.geometry.dispose();
    r.standMat.dispose(); r.tag.material.map?.dispose(); r.tag.material.dispose();
    r.root.removeFromParent(); r.tag.removeFromParent();
    players.delete(id);
  }
  const clear = () => { for (const id of [...players.keys()]) remove(id); };
  function roster(list) {
    const seen = new Set();
    for (const p of list || []) { if (!p?.id || p.id === myId()) continue; seen.add(p.id); add(p.id, p); }
    for (const id of [...players.keys()]) if (!seen.has(id)) remove(id);
  }
  const rosterList = msg => Array.isArray(msg?.players) ? msg.players : mp?.players ? [...mp.players.values()] : [];

  // every relay message we care about; also the test / debug entry point
  function receive(msg) {
    if (!msg || typeof msg !== 'object') return;
    const t = msg.t;
    if (t === 'roster') roster(rosterList(msg));
    else if (t === 'joined') { if (msg.player?.id && msg.player.id !== myId()) add(msg.player.id, msg.player); }
    else if (t === 'left') remove(msg.id);
    else if (t === 'skin') { if (msg.from && msg.from !== myId()) add(msg.from, { skin: msg.skin }); }
    else if (t === 'state') {
      if (!msg.from || msg.from === myId()) return;
      const n = now();
      // the relay's clock when it forwarded this; if our clock isn't synced yet, use when it arrived
      const st = fin(msg.srvT) && Math.abs(msg.srvT - n) < 2000 ? msg.srvT : n;
      const s = parseState(msg, st); if (!s) return;
      const r = players.get(msg.from) || add(msg.from, mp?.players?.get?.(msg.from) || {});
      r.track.receive(s, n);
    } else if (t === 'disconnected' || t === 'closed' || t === 'kicked') clear();
  }
  const TYPES = ['roster', 'joined', 'left', 'skin', 'state', 'disconnected', 'closed', 'kicked'];
  const handlers = TYPES.map(type => [type, msg => receive(type === 'roster' ? { t: 'roster', players: rosterList(msg) } : { ...msg, t: type })]);
  if (mp?.on) for (const [type, fn] of handlers) mp.on(type, fn);
  if (mp?.players?.size) roster([...mp.players.values()]);

  function switchKind(r, kind) {
    for (const k of KINDS) if (r.bodies[k]) r.bodies[k].pivot.visible = false;
    for (const g of Object.values(r.gliders)) if (g) g.visible = false;
    r.stand.geometry = standGeometry(kind); r.standMat.color.set(bodyColor(r, kind));
    r.kind = kind; r.tagSig = ''; r.lean = 0; r.heading = null; r.open = 0;
  }
  // the full model is built the first time this player comes near in this vehicle, then kept
  function ensureBody(r, kind) {
    if (!r.bodies[kind]) { r.bodies[kind] = timed(() => buildBody(kind, colorsFor(r, kind))); r.root.add(r.bodies[kind].pivot); }
    return r.bodies[kind];
  }
  function ensureGlider(r, kind) {
    if (!r.gliders[kind]) { r.gliders[kind] = timed(() => buildGlider(kind, r.glider[kind] || {})); r.gliders[kind].visible = false; r.root.add(r.gliders[kind]); }
    return r.gliders[kind];
  }

  function update(dt) {
    if (!players.size) { stats.count = stats.visible = stats.near = 0; return; }
    const t0 = performance.now(), n = now(), cam = camera?.position; building = 0;
    if (mp && mp.inGame === false) { clear(); return; }
    let visible = 0, near = 0;
    for (const r of players.values()) {
      if (r.track.stale(n)) { r.root.visible = r.tag.visible = r.shown = false; continue; }
      const mode = r.track.pose(n, dt, P, Q, V), s = r.track.latest, kind = s.v;
      if (r.kind !== kind) switchKind(r, kind);
      r.root.position.copy(P); r.root.quaternion.copy(Q);
      r.root.visible = r.shown = true; r.x = P.x; r.z = P.z; visible++;
      const dist = cam ? cam.distanceTo(P) : 0; r.dist = dist;
      // level of detail with a little hysteresis
      const farAt = FAR[kind]; r.far = r.far ? dist > farAt * 0.9 : dist > farAt;
      const body = r.far ? r.bodies[kind] : ensureBody(r, kind);
      if (body) body.pivot.visible = !r.far;
      r.stand.visible = r.far;
      if (!r.far) near++;
      const speed = V.length();
      // the bike's lean isn't in its rotation: estimate it from the turn (lean = atan(v·ω / g))
      F.set(0, 0, 1).applyQuaternion(Q);
      const h = Math.atan2(F.x, F.z);
      if (r.heading !== null && dt > 0) {
        let dh = h - r.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        r.yawRate += (dh / dt - r.yawRate) * Math.min(1, dt * 8);
      }
      r.heading = h;
      if (kind === 'bike' && body) {
        const want = s.glide || mode === 'hold' ? 0 : THREE.MathUtils.clamp(-Math.atan(speed * r.yawRate / 17), -1, 1);
        r.lean += (want - r.lean) * Math.min(1, dt * 8); body.pivot.rotation.z = r.lean;
      }
      if (kind === 'jet' && body) {
        if (body.gear) body.gear.visible = speed < 85 && !r.far;
        if (body.flame) { body.flame.visible = speed > 3; body.flame.scale.z = body.flame.userData.baseZ * (0.5 + Math.min(1, speed / 250)); }
      }
      // glider: unfolds / folds like the player's own (glider.js update)
      if (kind !== 'jet') {
        const target = s.glide ? 1 : 0;
        r.open += THREE.MathUtils.clamp(target - r.open, -dt * 4, dt * 3);
        if ((r.open > 0.01 && !r.far) || r.gliders[kind]?.visible) {
          const g = ensureGlider(r, kind), e = 1 - (1 - r.open) ** 3;
          g.visible = r.open > 0.01 && !r.far;
          g.scale.set(Math.max(0.05, e), 0.4 + 0.6 * e, 0.5 + 0.5 * e); g.position.y = -0.9 * (1 - e);
        }
      }
      // name tag: same size on screen, a little smaller further off, fades out from TAG_FADE to TAG_HIDE m
      const tag = r.tag;
      if (dist < TAG_HIDE) {
        const sig = `${r.name}|${r.host}|${kind}|${bodyColor(r, kind)}`;
        if (sig !== r.tagSig) {
          r.tagSig = sig; tag.material.map?.dispose();
          const tex = tagTexture(r.name, bodyColor(r, kind), r.host);
          tag.material.map = tex.map; tag.material.needsUpdate = true; r.tagAspect = tex.aspect;
        }
        const k = 0.048 * (1 - 0.25 * THREE.MathUtils.clamp((dist - 20) / 130, 0, 1));   // ≈ 26 px tall at 20 m, 20 px from 150 m
        tag.scale.set(k * r.tagAspect, k, 1);
        tag.material.opacity = THREE.MathUtils.clamp((TAG_HIDE - dist) / (TAG_HIDE - TAG_FADE), 0, 1);
        tag.position.set(P.x, P.y + TAG_Y[kind] + (r.open > 0.5 ? GLIDER_TAG_Y : 0), P.z);
        tag.visible = true;
      } else tag.visible = false;
    }
    stats.count = players.size; stats.visible = visible; stats.near = near;
    stats.ms += (performance.now() - t0 - building - stats.ms) * 0.05; stats.buildMs += building;
  }

  // named dots on the maps: minimap.js calls this with its canvas, world → canvas mapping and pixel ratio
  function drawMarkers(ctx, map, d, view) {
    if (!players.size) return;
    const W = ctx.canvas.width, H = ctx.canvas.height, m = 9 * d;
    ctx.save(); ctx.lineJoin = 'round'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.font = `700 ${(view === 'full' ? 13 : 11) * d}px system-ui, sans-serif`;
    for (const r of players.values()) {
      if (!r.shown) continue;
      let [a, b] = map(r.x, r.z); const inside = a > m && a < W - m && b > m && b < H - m;
      if (!inside) {
        if (view === 'full') continue;
        const dx = a - W / 2, dy = b - H / 2, k = Math.min((W / 2 - m) / Math.abs(dx || 1e-9), (H / 2 - m) / Math.abs(dy || 1e-9));
        a = W / 2 + dx * k; b = H / 2 + dy * k;
      }
      ctx.beginPath(); ctx.arc(a, b, (inside ? 5.5 : 4) * d, 0, Math.PI * 2);
      ctx.fillStyle = bodyColor(r, r.kind || 'car'); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8 * d; ctx.stroke();
      if (!inside) continue;
      ctx.lineWidth = 3 * d; ctx.strokeStyle = '#000b'; ctx.strokeText(r.name, a, b - 7 * d);
      ctx.fillStyle = '#fff'; ctx.fillText(r.name, a, b - 7 * d);
    }
    ctx.restore();
  }
  minimap?.setExtraMarkers?.(drawMarkers);

  function dispose() {
    clear(); group.removeFromParent();
    if (mp?.off) for (const [type, fn] of handlers) mp.off(type, fn);
    minimap?.setExtraMarkers?.(null);
  }
  const list = () => [...players.values()].map(r => ({ id: r.id, name: r.name, host: r.host, kind: r.kind, visible: r.shown,
    far: r.far, glide: !!r.track.latest?.glide, x: r.root.position.x, y: r.root.position.y, z: r.root.position.z, dist: r.dist,
    tag: r.tag.visible, body: r.kind ? bodyColor(r, r.kind) : null }));
  return { group, update, receive, drawMarkers, dispose, list, stats,
    predictedState: (id, atMs) => predictedState(id, atMs, players), get count() { return players.size; } };
}

// Collision prediction uses the same buffer/extrapolation, at NOW (no render delay or visual correction).
// Kept separate from rendering for MP-4 integration. Unknown/stale peers cannot become invisible obstacles.
let predictionPlayers = new Map();
export function predictedState(id, atMs, players = predictionPlayers) {
  const track = players.get(id)?.track;
  if (!track || track.stale(atMs) || !Number.isFinite(atMs)) return null;
  const s = track.latest;
  if (atMs - s.t > MAX_EXTRAP) return null;
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), vel = new THREE.Vector3();
  poseAt(track.buf, atMs, p, q, vel);
  return { v: s.v, p: p.toArray(), q: q.toArray(), vel: vel.toArray(), glide: s.glide,
    grounded: s.grounded, mode: s.mode, ghostUntil: s.ghostUntil };
}
