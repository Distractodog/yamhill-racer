// Local vehicle only: the other client applies the opposite response against its prediction of us.
// No world/mesh access and no vertical impulses. Dimensions are metres; masses only set bump ratios.
export const GHOST_MS = 3000;
export const SHAPES = {
  car: { w: 2, l: 4.6, h: 1.4, mass: 900 },
  bike: { w: 0.8, l: 2.2, h: 1.8, mass: 220 },
  jet: { w: 2, l: 14, h: 3, mass: 4500 },
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const finite = a => Array.isArray(a) && a.every(Number.isFinite);

function box(kind, p, q) {
  const shape = SHAPES[kind];
  if (!shape || !finite(p) || p.length !== 3 || !finite(q) || q.length !== 4) return null;
  let fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] ** 2 + q[1] ** 2);
  const length = Math.hypot(fx, fz); if (length < 0.01) return null;
  fx /= length; fz /= length;
  return { ...shape, x: p[0], y: p[1], z: p[2], fx, fz, rx: fz, rz: -fx };
}
const radius = (b, x, z) => Math.abs(x * b.fx + z * b.fz) * b.l / 2 + Math.abs(x * b.rx + z * b.rz) * b.w / 2;

// Swept separating-axis test. At 120 Hz it also catches narrow bikes crossing between samples.
// Normal points from remote to local; sweep uses the last local step and remote linear prediction.
function contact(a, b, dx, dz) {
  if (Math.abs(a.y - b.y) >= (a.h + b.h) / 2) return null;
  const x = a.x - b.x, z = a.z - b.z;
  let enter = 0, leave = 1, sweep = null, overlap = true, depth = Infinity, mtv = null;
  for (const [nx, nz] of [[a.fx, a.fz], [a.rx, a.rz], [b.fx, b.fz], [b.rx, b.rz]]) {
    const r = radius(a, nx, nz) + radius(b, nx, nz), end = x * nx + z * nz;
    const move = dx * nx + dz * nz, start = end - move, pen = r - Math.abs(end);
    if (pen < 0) overlap = false;
    if (pen < depth) { depth = pen; const sign = Math.sign(end) || -Math.sign(move) || 1; mtv = { nx: nx * sign, nz: nz * sign, depth: pen }; }
    if (Math.abs(move) < 1e-9) { if (Math.abs(start) > r) return null; continue; }
    const t1 = (-r - start) / move, t2 = (r - start) / move;
    const lo = Math.min(t1, t2), hi = Math.max(t1, t2);
    if (lo > enter) {
      enter = lo;
      const sign = -Math.sign(move);
      sweep = { nx: nx * sign, nz: nz * sign, depth: r - end * sign };
    }
    leave = Math.min(leave, hi);
    if (enter > leave) return null;
  }
  if (sweep && enter <= 1 && leave >= 0) return sweep;
  return overlap ? mtv : null;
}

export function resolveCollision(vehicle, remote, dt = 1 / 120, atMs = 0, tie = 1) {
  if (!vehicle.grounded || vehicle.glide?.active || (vehicle.kind === 'jet' && vehicle.mode !== 'ground') ||
      vehicle.ghostUntil > atMs || !remote || !remote.grounded || remote.glide || remote.ghostUntil > atMs ||
      (remote.v === 'jet' && remote.mode !== 'ground') || !finite(remote.vel) || remote.vel.length !== 3) return false;
  const p = vehicle.pos, q = vehicle.quat, v = vehicle.vel;
  const a = box(vehicle.kind, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]), b = box(remote.v, remote.p, remote.q);
  if (!a || !b) return false;
  const prev = vehicle.prevPos || p;
  const dx = p.x - prev.x - remote.vel[0] * dt, dz = p.z - prev.z - remote.vel[2] * dt;
  if (Math.hypot(a.x - b.x, a.z - b.z) > a.l + b.l + Math.hypot(dx, dz)) return false;
  const hit = contact(a, b, dx, dz); if (!hit) return false;
  // Exact coincident spawns still separate consistently on both computers.
  if (Math.hypot(a.x - b.x, a.z - b.z) < 1e-8 && Math.hypot(dx, dz) < 1e-8) { hit.nx *= tie; hit.nz *= tie; }
  const { nx, nz } = hit, share = b.mass / (a.mass + b.mass);
  const correction = Math.max(0, hit.depth + 0.002) * share;
  // Contact on the local box's support face, with tangential placement from the overlap.
  // Only cosmetic metadata: retain the existing correction, impulse and yaw response below.
  if (vehicle.recordImpact) {
    const forward = nx * a.fx + nz * a.fz, right = nx * a.rx + nz * a.rz;
    const overlapMiddle = (x, z, half) => {
      const centre = (b.x - a.x) * x + (b.z - a.z) * z, extent = radius(b, x, z);
      return clamp((Math.max(-half, centre - extent) + Math.min(half, centre + extent)) / 2, -half, half);
    };
    const f = Math.abs(forward) > 1e-6 ? -Math.sign(forward) * a.l / 2
      : overlapMiddle(a.fx, a.fz, a.l / 2);
    const r = Math.abs(right) > 1e-6 ? -Math.sign(right) * a.w / 2
      : overlapMiddle(a.rx, a.rz, a.w / 2);
    vehicle.recordImpact(a.x + a.fx * f + a.rx * r, a.y, a.z + a.fz * f + a.rz * r, nx, 0, nz,
      -((v.x - remote.vel[0]) * nx + (v.z - remote.vel[2]) * nz), 'vehicle');
  }
  p.x += nx * correction; p.z += nz * correction;
  const closing = -((v.x - remote.vel[0]) * nx + (v.z - remote.vel[2]) * nz);
  if (closing <= 0) return true;
  // Equal masses each take half of the relative impulse; unequal masses conserve momentum by symmetry.
  const dv = closing * (1 + (closing > 2 ? 0.25 : 0.05)) * share;
  v.x += nx * dv; v.z += nz * dv;
  const armX = clamp((b.x - a.x) / 2, -a.l / 2, a.l / 2), armZ = clamp((b.z - a.z) / 2, -a.l / 2, a.l / 2);
  const kick = closing > 2 ? clamp((armZ * nx - armX * nz) * dv * 0.025, -0.65, 0.65) : 0;
  vehicle.ang.y = clamp(vehicle.ang.y + kick, -1.2, 1.2);
  if (vehicle.kind === 'bike') vehicle.yawRate = clamp(vehicle.yawRate + kick, -1.2, 1.2);
  if (vehicle.kind === 'jet') {
    // Taxi physics stores signed forward speed separately from vel; don't let old speed reappear next step.
    vehicle.v = v.x * Math.sin(vehicle.yaw) + v.z * Math.cos(vehicle.yaw);
    vehicle.yaw += kick * dt;
  }
  vehicle.hit = Math.max(vehicle.hit || 0, closing * 0.5);
  return true;
}

export function createCollisions({ mp, player, vehicles = [], predictedState, enabled = () => true }) {
  const hooks = [];
  const ghost = v => { if (mp.inGame) v.ghostUntil = Math.max(v.ghostUntil || 0, mp.now() + GHOST_MS); };
  // Cover R, checkpoint resets, home, garage switches and automatic jet crash respawns without physics edits.
  for (const v of vehicles) for (const key of ['reset', 'resetToSafe', 'placeInAir', 'flipUpright']) {
    if (typeof v[key] !== 'function') continue;
    const original = v[key];
    const wrapped = function (...args) { ghost(this); return original.apply(this, args); };
    v[key] = wrapped; hooks.push(() => { if (v[key] === wrapped) v[key] = original; });
  }
  const joined = () => ghost(player());
  mp.on('connected', joined);
  const stats = { hits: 0 };
  return {
    stats,
    step(dt) {
      if (!mp.inGame || !enabled()) return;
      const v = player(), now = mp.now();
      if (!v.grounded || v.glide?.active || v.ghostUntil > now) return;
      for (const id of mp.players.keys()) if (id !== mp.me.id) {
        if (resolveCollision(v, predictedState(id, now), dt, now, mp.me.id < id ? 1 : -1)) stats.hits++;
      }
    },
    dispose() { mp.off('connected', joined); hooks.forEach(fn => fn()); },
  };
}

// Inviter occupies slot zero, then guests in acceptance order. Jet fuselages need longer rows.
export function gridPosition(start, index, kind = 'car') {
  const back = 8 + Math.floor(index / 2) * (kind === 'jet' ? 16 : 8), side = index % 2 ? 4 : -4;
  return { x: start.x - Math.sin(start.yaw) * back + Math.cos(start.yaw) * side,
    z: start.z - Math.cos(start.yaw) * back - Math.sin(start.yaw) * side, yaw: start.yaw };
}

// Extend the race corridor behind the grid: the ordinary rounded start cap would squash rows together.
export function gridTrack(points, start, count, kind) {
  if (!points?.length || !Number.isFinite(count) || count < 1) return points;
  const back = 16 + Math.ceil(count / 2) * (kind === 'jet' ? 16 : 8);
  const width = Math.max(kind === 'jet' ? 10 : 6, points[0][2]);
  return [[start.x - Math.sin(start.yaw) * back, start.z - Math.cos(start.yaw) * back, width],
    [points[0][0], points[0][1], width], ...points.slice(1)];
}
