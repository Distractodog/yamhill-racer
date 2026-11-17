// Race-only solid low walls. No heightfield changes: contact is horizontal, so a scrape cannot launch a vehicle.
// The renderer uses these same edge segments and sampled ground heights. Both ends of the course stay open.
import { raceEdges } from './raceedges.js';

export const BARRIER_HEIGHT = 0.65;
export const BARRIER_WIDTH = 0.32;
const CELL = 16;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function makeRaceBarriers(points, world) {
  const segments = [], grid = new Map();
  for (const edge of raceEdges(points)) {
    const { ax, az, bx, bz, index } = edge, dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz); if (len < 0.01) continue;
    const s = { ax, az, bx, bz, dx, dz, len, nx: dz / len, nz: -dx / len, index, ready: false };
    segments.push(s);
    // Include the body footprint and one physics step of movement in the broad phase.
    for (let x = Math.floor((Math.min(ax, bx) - 4) / CELL); x <= Math.floor((Math.max(ax, bx) + 4) / CELL); x++)
      for (let z = Math.floor((Math.min(az, bz) - 4) / CELL); z <= Math.floor((Math.max(az, bz) + 4) / CELL); z++) {
        const key = `${x},${z}`; if (!grid.has(key)) grid.set(key, []); grid.get(key).push(s);
      }
  }
  function prepare(s) {
    if (s.ready) return true;
    if (world.loadedAt && (!world.loadedAt(s.ax, s.az) || !world.loadedAt(s.bx, s.bz))) return false;
    s.ay = world.groundAt(s.ax, s.az); s.by = world.groundAt(s.bx, s.bz); s.ready = true;
    return true;
  }
  function collide(car, dt) {
    const p = car.pos, v = car.vel, q = car.quat;
    const near = grid.get(`${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`);
    if (!near) return 0;
    const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const h = car.half || { x: 0.8, front: 1.75, back: -1.95 };
    const radius = h.x + BARRIER_WIDTH / 2;
    const reach = car.wheelReach?.() ?? 0.7;
    let hit = 0;
    // Three overlapping discs cover the body without angular impulses or wheel-catching corners.
    for (const offset of [h.back + h.x, (h.front + h.back) / 2, h.front - h.x]) {
      for (const s of near) {
        if (!prepare(s)) continue;
        const x = p.x + fx * offset, z = p.z + fz * offset;
        const t = clamp(((x - s.ax) * s.dx + (z - s.az) * s.dz) / (s.len * s.len), 0, 1);
        const y = s.ay + (s.by - s.ay) * t;
        if (p.y - reach > y + BARRIER_HEIGHT || p.y + 0.4 < y) continue;
        const px = s.ax + s.dx * t, pz = s.az + s.dz * t;
        const dx = x - px, dz = z - pz, d = Math.hypot(dx, dz);
        const signed = dx * s.nx + dz * s.nz;
        const oldSigned = signed - (v.x * s.nx + v.z * s.nz) * dt;
        // Swept crossing prevents tunnelling even if a step traverses the full wall thickness.
        const swept = signed * oldSigned < 0 && t > 0 && t < 1;
        if (d >= radius && !swept) continue;
        const side = Math.sign(oldSigned) || Math.sign(signed) || 1;
        const nx = swept ? s.nx * side : d > 1e-6 ? dx / d : s.nx * side;
        const nz = swept ? s.nz * side : d > 1e-6 ? dz / d : s.nz * side;
        const depth = swept ? radius + Math.abs(signed) : radius - d;
        p.x += nx * depth; p.z += nz * depth;
        const vn = v.x * nx + v.z * nz;
        if (vn < 0) {
          hit = Math.max(hit, -vn);
          v.x -= nx * vn * 1.15; v.z -= nz * vn * 1.15;
          // Lose a little tangential speed while scraping; no vertical or angular impulse.
          v.x *= 0.985; v.z *= 0.985;
        }
      }
    }
    car.hit = Math.max(car.hit || 0, hit * 0.5);
    return hit;
  }
  return { segments, prepare, collide };
}

// Entire footprint must leave the corridor. A landing is final; otherwise allow a second to recover in the air.
export function raceBounds(track) {
  let outsideTime = 0;
  return {
    reset() { outsideTime = 0; },
    update(car, dt) {
      track.update(car.pos.x, car.pos.z);
      if (!track.outside(car)) { outsideTime = 0; return false; }
      outsideTime += dt;
      return !!car.grounded || outsideTime > 1;
    },
  };
}
