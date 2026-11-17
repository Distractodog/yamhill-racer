// The drawn walls, contacts and bounds all use this same open finish run-off.
export const FINISH_RUNOFF = 20;
export function raceTrack(points, finish) {
  const result = points.map(p => p.slice());
  const end = result.at(-1), fx = Math.sin(finish.yaw), fz = Math.cos(finish.yaw);
  // Join the baked route to the arch, then continue along its crossing direction.
  const append = (x, z) => {
    const a = result.at(-1), steps = Math.ceil(Math.hypot(x - a[0], z - a[1]) / 4);
    for (let i = 1; i <= steps; i++) result.push([a[0] + (x - a[0]) * i / steps, a[1] + (z - a[1]) * i / steps, end[2]]);
  };
  append(finish.x, finish.z);
  append(finish.x + fx * FINISH_RUNOFF, finish.z + fz * FINISH_RUNOFF);
  return result;
}

// Forward crossing of a gate plane. Finish arches use the corridor's full width;
// rings still require flying through the hole. Teleports are never crossings.
export function crossedRaceGate(g, from, to, finishTrack = null) {
  if (Math.hypot(to.x - from.x, to.z - from.z) >= 40) return false;
  const fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);
  const d0 = (from.x - g.x) * fx + (from.z - g.z) * fz;
  const d1 = (to.x - g.x) * fx + (to.z - g.z) * fz;
  if (d0 > 0 || d1 < 0 || d0 === d1) return false;
  const u = -d0 / (d1 - d0), x = from.x + (to.x - from.x) * u, z = from.z + (to.z - from.z) * u;
  const across = (x - g.x) * fz - (z - g.z) * fx;
  if (g.y !== undefined) return Math.hypot(across, from.y + (to.y - from.y) * u - g.y) <= g.r + 1;
  // Another part of a looping course can cross this infinite plane too. Only
  // the opening at the finish counts, using its corridor width rather than posts.
  return finishTrack ? Math.abs(across) <= finishTrack.endWidth && finishTrack.contains(x, z)
    : Math.abs(across) <= g.w / 2 + 1.5;
}
