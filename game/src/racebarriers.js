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
    // Vehicle-sized swept queries below find these wall cells, including fast crossings.
    for (let x = Math.floor((Math.min(ax, bx) - BARRIER_WIDTH / 2) / CELL); x <= Math.floor((Math.max(ax, bx) + BARRIER_WIDTH / 2) / CELL); x++)
      for (let z = Math.floor((Math.min(az, bz) - BARRIER_WIDTH / 2) / CELL); z <= Math.floor((Math.max(az, bz) + BARRIER_WIDTH / 2) / CELL); z++) {
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
    const yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = fz, rz = -fx;
    // The default race car's rear tyres extend to 1.2 m; the old .8 m discs missed them and the box corners.
    const h = car.half || { x: 1.2, front: 1.95, back: -1.95 };
    const middle = (h.front + h.back) / 2, halfLength = (h.front - h.back) / 2;
    const oldX = p.x - v.x * dt, oldZ = p.z - v.z * dt;
    const radius = Math.hypot(h.x, Math.max(h.front, -h.back)) + BARRIER_WIDTH / 2;
    const near = new Set();
    for (let x = Math.floor((Math.min(p.x, oldX) - radius) / CELL); x <= Math.floor((Math.max(p.x, oldX) + radius) / CELL); x++)
      for (let z = Math.floor((Math.min(p.z, oldZ) - radius) / CELL); z <= Math.floor((Math.max(p.z, oldZ) + radius) / CELL); z++)
        for (const s of grid.get(`${x},${z}`) || []) near.add(s);
    const reach = car.wheelReach?.() ?? 0.7;
    // Pitch/roll can leave a low wheel at the wall even when the centre is above its top.
    const rightY = 2 * (q.x * q.y + q.w * q.z), forwardY = 2 * (q.y * q.z - q.w * q.x);
    const bottom = Math.min(p.y, p.y - v.y * dt) - reach - Math.abs(rightY) * h.x
      + Math.min(forwardY * h.back, forwardY * h.front);
    let hit = 0;
    for (const s of near) {
      if (!prepare(s)) continue;
      const cx = p.x + fx * middle, cz = p.z + fz * middle;
      const t = clamp(((cx - s.ax) * s.dx + (cz - s.az) * s.dz) / (s.len * s.len), 0, 1);
      const y = s.ay + (s.by - s.ay) * t;
      if ((!car.grounded && bottom > y + BARRIER_HEIGHT) || p.y + 0.4 < y) continue;
      const dx = cx - (s.ax + s.bx) / 2, dz = cz - (s.az + s.bz) / 2;
      const mx = p.x - oldX, mz = p.z - oldZ, tx = s.dx / s.len, tz = s.dz / s.len;
      // Swept separating axes for the entire oriented rectangle and the finite wall rectangle.
      // Segment ends only limit overlap: always push along the wall normal, never around a joint like a wheel/ramp.
      let enter = 0, exit = 1;
      for (const [ax, az] of [[s.nx, s.nz], [tx, tz], [rx, rz], [fx, fz]]) {
        const extent = h.x * Math.abs(rx * ax + rz * az) + halfLength * Math.abs(fx * ax + fz * az)
          + s.len / 2 * Math.abs(tx * ax + tz * az) + BARRIER_WIDTH / 2 * Math.abs(s.nx * ax + s.nz * az);
        const start = (dx - mx) * ax + (dz - mz) * az, movement = mx * ax + mz * az;
        if (Math.abs(movement) < 1e-9) {
          if (Math.abs(start) > extent) { exit = -1; break; }
        } else {
          const a = (-extent - start) / movement, b = (extent - start) / movement;
          enter = Math.max(enter, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
        }
      }
      if (enter > exit) continue;
      const signed = dx * s.nx + dz * s.nz;
      const side = Math.sign(signed - mx * s.nx - mz * s.nz) || Math.sign(signed) || 1;
      const support = h.x * Math.abs(rx * s.nx + rz * s.nz) + halfLength * Math.abs(fx * s.nx + fz * s.nz);
      const depth = support + BARRIER_WIDTH / 2 - side * signed;
      if (depth <= 0) continue;
      const nx = s.nx * side, nz = s.nz * side;
      if (car.recordImpact) {
        // The contacting support corner (or face centre when parallel), projected onto the
        // finite wall. Using the vehicle centre here would put oblique nose hits in a door.
        const right = rx * nx + rz * nz, forward = fx * nx + fz * nz;
        const sx = Math.abs(right) < 1e-6 ? 0 : -Math.sign(right) * h.x;
        const sz = Math.abs(forward) < 1e-6 ? 0 : -Math.sign(forward) * halfLength;
        const px = cx + rx * sx + fx * sz, pz = cz + rz * sx + fz * sz;
        const u = clamp(((px - s.ax) * s.dx + (pz - s.az) * s.dz) / (s.len * s.len), 0, 1);
        car.recordImpact(s.ax + s.dx * u + nx * BARRIER_WIDTH / 2,
          Math.min(p.y, s.ay + (s.by - s.ay) * u + BARRIER_HEIGHT),
          s.az + s.dz * u + nz * BARRIER_WIDTH / 2, nx, 0, nz, -(v.x * nx + v.z * nz), 'barrier');
      }
      p.x += nx * depth; p.z += nz * depth;
      const vn = v.x * nx + v.z * nz;
      if (vn < 0) {
        hit = Math.max(hit, -vn);
        v.x -= nx * vn * 1.15; v.z -= nz * vn * 1.15;
        // Lose a little tangential speed while scraping; no vertical or angular impulse.
        v.x *= 0.985; v.z *= 0.985;
      }
    }
    car.hit = Math.max(car.hit || 0, hit * 0.5);
    return hit;
  }
  const canLoad = s => !world.mapContains || (world.mapContains(s.ax, s.az, 0) && world.mapContains(s.bx, s.bz, 0));
  return { segments, prepare, collide, canLoad };
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
