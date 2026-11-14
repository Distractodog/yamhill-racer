// Optional circular map wall. Pure data/physics; deliberately absent on the current map.
// Enable with world.json rim: { cx: 9000, cz: -5000, r: 17200 } after the full map is ready.
export function makeRim(config) {
  if (config == null) return null;
  const { cx, cz, r } = config;
  if (![cx, cz, r].every(Number.isFinite) || r <= 0) {
    throw new RangeError('Invalid rim: expected finite cx/cz and positive r');
  }
  const contains = (x, z) => Number.isFinite(x) && Number.isFinite(z) && (x - cx) ** 2 + (z - cz) ** 2 <= r * r;
  function clampPoint(point, limit, array = false) {
    if (!point) return;
    const x = array ? point[0] : point.x, z = array ? point[1] : point.z;
    const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
    if (d2 <= limit * limit) return;
    if (!Number.isFinite(d2)) return; // Leave invalid physics visible to existing diagnostics.
    const scale = limit / Math.sqrt(d2);
    if (array) { point[0] = cx + dx * scale; point[1] = cz + dz * scale; }
    else { point.x = cx + dx * scale; point.z = cz + dz * scale; }
  }
  return {
    contains,
    constrain(vehicle) {
      const p = vehicle.pos, v = vehicle.vel, half = vehicle.half;
      const body = half ? Math.hypot(half.x, Math.max(half.front, -half.back)) : 2.2;
      const limit = Math.max(0, r - body - 1e-6);
      // Sanitize old saves, streaming recovery, and the home anchor before they can reintroduce an outside point.
      for (const saved of vehicle.safe || []) clampPoint(saved, limit, true);
      clampPoint(vehicle._lastLoaded, limit, true);
      clampPoint(vehicle.world?.spawn, Math.max(0, limit - 6), true);
      clampPoint(vehicle.prevPos, limit);
      clampPoint(vehicle.renderPos, limit);
      const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
      if (d2 <= limit * limit || !Number.isFinite(d2) || d2 === 0) return 0;
      const d = Math.sqrt(d2), nx = dx / d, nz = dz / d;
      p.x = cx + nx * limit; p.z = cz + nz * limit;
      // Remove only outward horizontal speed. Height, vertical speed, orientation and tangent speed are untouched.
      const outward = v.x * nx + v.z * nz;
      if (outward > 0) { v.x -= outward * nx; v.z -= outward * nz; }
      return Math.max(0, outward);
    },
  };
}
