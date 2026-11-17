// Bare-terrain contacts for ground vehicles. Roads, ramps, decks, roofs and placed pieces
// are excluded by the world's terrainNormalAt query, not by a painted surface class.
import * as THREE from 'three';

const FULL = Math.cos(Math.PI / 6), HOLD = Math.cos(35 * Math.PI / 180);
export const FACE_Y = Math.cos(55 * Math.PI / 180);
const n = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Quaternion();

export function terrainGrip(normalY, surface) {
  if (normalY >= FULL) return 1;
  const end = Math.cos((surface === 3 || surface === 6 ? 50 : 45) * Math.PI / 180);
  const u = Math.max(0, (normalY - end) / (FULL - end));
  return u * u;
}
export const terrainHold = normalY => normalY >= HOLD;

// Keep a contact's actual triangle normal and reject a spring ray aimed into a wall.
// A previously supported wheel may not step upwards by more than half its travel.
export function terrainWheel(W, wh, point, normal, height, travel) {
  const raw = W.terrainNormalAt?.(point.x, point.z, n, point.y);
  wh.terrainY = raw ? n.y : 1;
  const blocked = raw && (n.y < FACE_Y || (n.y < FULL && wh.contact &&
    Number.isFinite(wh.terrainHeight) && height - wh.terrainHeight > travel * 0.5));
  wh.terrainHeight = height;
  if (raw && n.y < FULL) normal.copy(n);
  return blocked;
}

// On steep ground a vertical spring must not cancel gravity and leave the vehicle hanging
// sideways. Supply the horizontal part of the supporting normal; the existing springs
// still settle pitch/roll. Below 30 degrees there is no change to the old force model.
export function terrainSlide(v, normal, normalY, dt) {
  if (normalY >= FULL) return;
  const fade = Math.min(1, (FULL - normalY) / (FULL - HOLD));
  v.vel.x += normal.x * normal.y * v.t.gravity * fade * dt;
  v.vel.z += normal.z * normal.y * v.t.gravity * fade * dt;
}

function footprint(v, reach) {
  const w = v.typePhysics?.width ?? 1, l = v.typePhysics?.length ?? 1;
  const key = `${v.kind}/${w}/${l}/${reach}`;
  if (v._terrainSweep?.key === key) return v._terrainSweep;
  const points = [], car = v.kind === 'car';
  const hx = car ? 0.8 * w : 0.25, front = car ? 1.75 * l : 0.9, back = car ? -1.95 * l : -0.9;
  // Sample the whole perimeter, including between wheels, for oblique corner impacts.
  for (let z = back; z <= front + 0.001; z += (front - back) / Math.ceil((front - back) / 0.5)) {
    points.push(new THREE.Vector3(-hx, -0.1, z), new THREE.Vector3(hx, -0.1, z));
  }
  for (let x = -hx; x <= hx + 0.001; x += 2 * hx / Math.ceil(2 * hx / 0.5)) {
    points.push(new THREE.Vector3(x, -0.1, front), new THREE.Vector3(x, -0.1, back));
  }
  for (const wh of v.wheels) {
    const mount = car ? wh.mount : new THREE.Vector3(0, 0, wh.z);
    points.push(new THREE.Vector3(mount.x, mount.y - reach + 0.1, mount.z));
  }
  return v._terrainSweep = { key, points, pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
}

// Resolve only horizontally. No wall correction raises the body or changes pitch/roll; tangential speed
// survives a glancing hit. Probes above the bank are free to jump/fly over it.
function pushOut(v, points, quat) {
  const W = v.world;
  let hit = false;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (const local of points) {
      p.copy(local).applyQuaternion(quat).add(v.pos);
      const h = W.terrainAt(p.x, p.z);
      if (h <= p.y + 0.06 || !W.terrainNormalAt(p.x, p.z, n, p.y) || n.y >= FACE_Y) continue;
      const horizontal = Math.hypot(n.x, n.z), nx = n.x / horizontal, nz = n.z / horizontal;
      const distance = Math.min(2, (h - p.y + 0.01) * n.y / horizontal);
      v.recordImpact?.(p.x, p.y, p.z, nx, 0, nz, -(v.vel.x * nx + v.vel.z * nz), 'terrain');
      v.pos.x += nx * distance; v.pos.z += nz * distance;
      const into = v.vel.x * nx + v.vel.z * nz;
      if (into < 0) {
        v.vel.x -= nx * into; v.vel.z -= nz * into;
        v.hit = Math.max(v.hit, -into * 0.5);
      }
      hit = moved = true;
    }
    if (!moved) break;
  }
  return hit;
}

export function beginTerrainStep(v, reach) {
  if (!v.world.terrainNormalAt || !v.world.terrainAt) return;
  const s = footprint(v, reach);
  pushOut(v, s.points, v.quat);
  s.pos.copy(v.pos); s.quat.copy(v.quat);
}

export function endTerrainStep(v) {
  const s = v._terrainSweep; if (!s) return false;
  const ex = v.pos.x, ey = v.pos.y, ez = v.pos.z;
  const dx = ex - s.pos.x, dy = ey - s.pos.y, dz = ez - s.pos.z;
  const steps = Math.max(1, Math.ceil((Math.hypot(dx, dz) + s.quat.angleTo(v.quat) * 3) / 0.25));
  v.pos.copy(s.pos);
  let hit = false;
  for (let i = 1; i <= steps; i++) {
    v.pos.x += dx / steps; v.pos.y += dy / steps; v.pos.z += dz / steps;
    q.slerpQuaternions(s.quat, v.quat, i / steps);
    hit = pushOut(v, s.points, q) || hit;
  }
  if (!hit) v.pos.set(ex, ey, ez); else v.pos.y = ey;
  // An inelastic face strike also stops upward scraping, including a tyre just launched
  // by the toe. A jump entirely above the face has no contact and keeps its velocity.
  if (hit && v.vel.y > 0) v.vel.y = 0;
  return hit;
}

export function terrainLift(W, point, lift, travel) {
  if (lift <= 0 || !W.terrainNormalAt?.(point.x, point.z, n, point.y) || n.y >= FULL) return lift;
  return n.y < FACE_Y ? 0 : Math.min(lift, travel * 0.5);
}
