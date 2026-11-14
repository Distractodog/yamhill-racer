// Best-run ghosts: bounded local recording, interpolation, and a single non-colliding silhouette.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
export const GHOST_KEY = 'yr-ghost-1';
export const GHOST_LIMITS = { samples: 12001, seconds: 600, races: 8, bytes: 1500000 };
const kinds = new Set(['car', 'bike', 'jet']);
export function ghostCourse(ch) {
  const text = JSON.stringify([ch.id, ch.vehicle || 'car', ch.start, ch.gates, ch.route, ch.track, ch.ramps]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${ch.vehicle || 'car'}:${text.length}:${hash >>> 0}`;
}
const pose = (time, vehicle) => [time, ...vehicle.pos.toArray(), ...vehicle.quat.toArray()];
export function validGhost(run, course) {
  if (!run || run.course !== course || !kinds.has(run.kind) || !Number.isFinite(run.time) || run.time <= 0 || run.time > GHOST_LIMITS.seconds ||
      !Array.isArray(run.samples) || run.samples.length < 2 || run.samples.length > GHOST_LIMITS.samples) return false;
  let last = -1;
  for (const s of run.samples) {
    if (!Array.isArray(s) || s.length !== 8 || !s.every(Number.isFinite) || s[0] <= last || s[0] < 0 || s[0] > run.time ||
        s.slice(1, 4).some(v => Math.abs(v) > 1e6) || Math.abs(Math.hypot(...s.slice(4)) - 1) > .01) return false;
    last = s[0];
  }
  return run.samples[0][0] === 0 && last === run.time;
}
function readStore(storage) {
  try {
    const raw = storage?.getItem(GHOST_KEY);
    if (!raw || raw.length > GHOST_LIMITS.bytes) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, GHOST_LIMITS.races).filter(r => validGhost(r, r?.course)) : [];
  } catch { return []; }
}
export function loadGhost(storage, course, kind) { return readStore(storage).find(r => r.course === course && r.kind === kind) || null; }
export function saveGhost(storage, run) {
  if (!validGhost(run, run?.course)) return false;
  const old = readStore(storage), existing = old.find(r => r.course === run.course && r.kind === run.kind);
  if (existing && existing.time <= run.time) return false;
  const runs = [run, ...old.filter(r => r.course !== run.course)].slice(0, GHOST_LIMITS.races);
  let text = JSON.stringify(runs);
  while (text.length > GHOST_LIMITS.bytes && runs.length > 1) { runs.pop(); text = JSON.stringify(runs); }
  if (text.length > GHOST_LIMITS.bytes) return false;
  try { storage?.setItem(GHOST_KEY, text); return !!storage; } catch { return false; }
}
export function createGhostRecorder(course, kind, vehicle) {
  const samples = [pose(0, vehicle)]; let invalid = false;
  return {
    sample(t, v, force = false) {
      if (invalid || !Number.isFinite(t) || t < samples.at(-1)[0]) { invalid = true; return; }
      if (t > GHOST_LIMITS.seconds) { invalid = true; return; }
      const last = samples.at(-1);
      if (t === last[0]) return;
      if (force || t - last[0] >= .05 - 1e-9) {
        if (samples.length >= GHOST_LIMITS.samples) { invalid = true; return; }
        samples.push(pose(t, v));
      }
    },
    finish(time, v) {
      this.sample(time, v, true);
      const run = { course, kind, time, samples };
      return !invalid && validGhost(run, course) ? run : null;
    },
  };
}
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
export function ghostPoseAt(run, time, position, quaternion) {
  if (!run || time < 0 || time > run.time) return false;
  const samples = run.samples; let lo = 0, hi = samples.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (samples[mid][0] <= time) lo = mid; else hi = mid; }
  const a = samples[lo], b = samples[hi], gap = b[0] - a[0], f = Math.max(0, Math.min(1, (time - a[0]) / gap));
  // Resets and missing frames should not draw a ghost sweeping through scenery.
  if (f > 0 && f < 1 && (gap > .25 || Math.hypot(b[1] - a[1], b[2] - a[2], b[3] - a[3]) > Math.max(40, gap * 600))) return false;
  position.set(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f);
  qa.fromArray(a, 4); qb.fromArray(b, 4); quaternion.slerpQuaternions(qa, qb, f); return true;
}
function silhouette(kind) {
  const pieces = [], box = (x, y, z, dx, dy, dz) => pieces.push(new THREE.BoxGeometry(dx, dy, dz).translate(x, y, z));
  if (kind === 'jet') { box(0, 0, 0, 1.1, 1, 12); box(0, 0, -1, 10, .18, 2.2); box(0, .9, -4.5, .18, 2, 2); }
  else if (kind === 'bike') { box(0, 0, 0, .5, .6, 1.8); box(0, .75, -.1, .5, 1, .5); for (const z of [-.9, .9]) box(0, -.4, z, .25, .7, .7); }
  else { box(0, 0, 0, 1.25, .55, 3.2); box(0, .45, -.2, .7, .6, 1.1); for (const x of [-1, 1]) for (const z of [-1.3, 1.3]) box(x, -.1, z, .35, .7, .7); }
  const geometry = mergeGeometries(pieces); pieces.forEach(g => g.dispose());
  const material = new THREE.MeshBasicMaterial({ color: 0x8ce8ff, transparent: true, opacity: .24, depthWrite: false });
  const mesh = new THREE.Mesh(geometry, material); mesh.name = 'race-ghost'; mesh.visible = false;
  return mesh;
}
export function createGhost({ scene, storage } = {}) {
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  let recorder = null, replay = null, mesh = null, kind = null;
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  return {
    start(ch, vehicle) {
      this.stop(); kind = ch.vehicle || 'car'; const course = ghostCourse(ch);
      if (!kinds.has(kind) || vehicle.kind !== kind) return;
      recorder = createGhostRecorder(course, kind, vehicle); replay = loadGhost(storage, course, kind);
      if (replay && scene) { mesh = silhouette(kind); scene.add(mesh); }
    },
    update(time, vehicle) {
      if (vehicle.kind !== kind) { this.stop(); return; }
      recorder?.sample(time, vehicle);
      if (mesh) {
        mesh.visible = ghostPoseAt(replay, time, position, quaternion) && position.distanceToSquared(vehicle.pos) < 300 * 300;
        if (mesh.visible) { mesh.position.copy(position); mesh.quaternion.copy(quaternion); }
      }
    },
    finish(time, vehicle, isBest) {
      const run = recorder?.finish(time, vehicle); if (isBest && run) saveGhost(storage, run); this.stop();
    },
    stop() {
      recorder = replay = null; kind = null;
      if (mesh) { mesh.removeFromParent(); mesh.geometry.dispose(); mesh.material.dispose(); mesh = null; }
    },
  };
}
