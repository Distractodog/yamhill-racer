// Road moisture is independent of vehicle finishes. Seconds here are real simulation time,
// not the accelerated day clock: a fully soaked road dries in 75 seconds.
export function roadWetness(current, rain, dt) {
  const target = Math.max(0, Math.min(1, rain));
  return target > current ? Math.min(target, current + dt / 8) : Math.max(target, current - dt / 75);
}

const paved = surface => surface === 3 || surface === 6 || surface === 7;
const amount = world => Math.max(0, Math.min(1, Number(world.wetness) || 0));
// Asphalt includes campus roads, junctions and bridge decks; ramps inherit the road below.
// Water keeps its own buoyancy / planing rules. Loose surfaces lose only 8% lateral grip.
export const wetGrip = (world, surface) => 1 - amount(world) * (surface === 5 ? 0 : paved(surface) ? .23 : .08);
// 1 / 1.15 braking force gives approximately 15% more stopping distance (plus existing drag).
export const wetBraking = (world, surface) => 1 - amount(world) * (surface === 5 ? 0 : paved(surface) ? 1 - 1 / 1.15 : .06);
