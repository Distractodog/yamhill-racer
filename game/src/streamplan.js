// Tile streaming decisions for world.js, kept pure (no three.js, no DOM) so tools/stream_plan_test.mjs can check them.
// Measured with tools/fly_lag_sim.mjs (the game's streaming in Node, flying the jet's paths) before this file existed:
// flying fast and turning, the look-ahead point (5 s / 1.2 km straight ahead) swept sideways round the turn and asked
// for 2-4x the tiles straight flight needs; tiles dropped at 2.6 km were built again when a circle swung back; and the
// builder used its whole 9 ms budget in 10-24% of frames. So:
//   · the look-ahead follows the turn (velocity + turn rate): points along the arc the vehicle is flying, not a
//     tangent that sweeps round the circle;
//   · tiles beyond the drop distance are hidden and kept (up to KEEP_MAX, nearest kept) instead of thrown away, so
//     turning back does not build them again;
//   · at speed the builder gets ~4 ms a frame (2 while frames just miss 60 Hz) unless a tile near the camera is
//     still missing; then it gets the old, larger budget so the ground is never missing;
//   · world.js also leaves each terrain chunk's full-detail level out of the tile build, and builds it when the
//     camera comes within 700 m (true distance: from high up, never).
//   · tiles are fetched and built nearest the camera first (needDist), and a missing one within urgentDist may start
//     even with 3 already in flight, so the tile a fast plane is about to reach never waits behind look-ahead tiles.
// Below FAST (≈250 km/h: ground vehicles in normal driving) the build budget is what it was; driving straight, the
// look-ahead point is too (the arc only differs while turning above 108 km/h).
export const LOAD_R = 1300, DROP_R = 2600, BASE_MS = 5;
export const AHEAD_S = 5, AHEAD_MAX = 1200;     // look-ahead at speed (AHEAD_MAX + LOAD_R stays inside DROP_R)
export const KEEP_R = 4600, KEEP_MAX = 12;      // built tiles kept (hidden) beyond DROP_R: within KEEP_R, at most KEEP_MAX in all
export const FAST = 70, FAST_MS = 4, SLOW_FRAME_MS = 22, VERY_SLOW_MS = 40, URGENT_R = 900, URGENT_S = 2.5;
// a missing tile this close to the camera (m) is urgent: the old budget until it is built. Grows with speed (2.5 s
// away), so a stealth at 2170 km/h gets the build time before it is over the hole, not after
export const urgentDist = speed => Math.max(URGENT_R, speed * URGENT_S);
const MAX_TURN = 1.5;                           // rad/s: anything faster is a respawn / teleport, not a turn

// Turn rate (rad/s, + = heading angle atan2(vx, vz) increasing) from successive velocities, smoothed over ~0.25 s.
export function createTurnTracker(tau = 0.25) {
  let last = null, lastT = 0, w = 0;
  return {
    get rate() { return w; },
    update(vx, vz, now) {
      const sp = Math.hypot(vx, vz);
      if (sp < 30) { last = null; w = 0; return w; }
      const h = Math.atan2(vx, vz), dt = last === null ? 0 : (now - lastT) / 1000;
      if (dt > 0 && dt < 0.25) {
        let d = h - last; d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
        const r = d / dt;
        if (Math.abs(r) > MAX_TURN) w = 0; else w += (r - w) * Math.min(1, dt / tau);
      } else if (dt >= 0.25) w = 0;
      last = h; lastT = now;
      return w;
    },
  };
}

// Where to load ahead: the look-ahead distance (min(AHEAD_MAX, AHEAD_S·speed)) followed along the arc the vehicle is
// turning on. Straight (or slow turn): one point, exactly the old straight-ahead point. Turning: the end of the arc and
// its middle (a tight arc curls back towards the vehicle, the middle covers the bulge). [] when not moving.
export function lookAhead(x, z, vx, vz, w = 0) {
  const sp = Math.hypot(vx, vz);
  if (!sp) return [];
  const L = Math.min(AHEAD_MAX, sp * AHEAD_S), tau = L / sp, turn = w * tau;
  if (Math.abs(turn) < 0.05) return [{ x: x + vx / sp * L, z: z + vz / sp * L }];
  const h0 = Math.atan2(vx, vz), R = sp / w;
  const at = f => { const h = h0 + turn * f; return { x: x + R * (Math.cos(h0) - Math.cos(h)), z: z + R * (Math.sin(h) - Math.sin(h0)) }; };
  return [at(0.5), at(1)];
}

// Load / build order: how far the camera is from a tile's square (x0, z0, side T), less LOAD_R (≤ 0: wanted now).
// Smallest first, so the tile the plane is about to enter never waits behind look-ahead tiles farther along (the old
// order, by distance to a point half-way to the look-ahead point, let it, and the plane ran onto missing ground).
export function needDist(x0, z0, T, cam) {
  return rectDist(cam.x, cam.z, x0, z0, T) - LOAD_R;
}

// Build time for this frame (ms). speed: m/s. urgent: a wanted tile near the camera isn't built yet. frameMs: recent
// frame time (smoothed). extraMs: a paused respawn hold builds faster (respawnhold.js).
// Frames a little slow (SLOW_FRAME_MS..VERY_SLOW_MS: just missing 60 Hz): half, which may bring them back under it.
// Very slow (below ~25 fps, the GPU or the machine): the old budget, or the map would fall behind at the same speed.
export function buildBudget(speed, { urgent = false, frameMs = 16.7, extraMs = 0 } = {}) {
  const old = BASE_MS + Math.min(4, speed / 60);
  if (speed < FAST || urgent || frameMs > VERY_SLOW_MS) return old + extraMs;
  return (frameMs > SLOW_FRAME_MS ? FAST_MS / 2 : FAST_MS) + extraMs;
}

// distance (m) from a point to a tile's square (x0, z0, side T); 0 inside
export function rectDist(x, z, x0, z0, T) {
  return Math.hypot(Math.max(x0 - x, 0, x - (x0 + T)), Math.max(z0 - z, 0, z - (z0 + T)));
}

// Which built tiles to show, keep hidden or drop. tiles: [{ k, d }] (d = rectDist from the camera). Shown: d ≤ DROP_R.
// Kept hidden: DROP_R < d ≤ KEEP_R, while the total stays ≤ KEEP_MAX (the farthest go first). Returns
// { show: Set(k), drop: [k] }; everything else is hidden.
export function planKeep(tiles, { dropR = DROP_R, keepR = KEEP_R, keepMax = KEEP_MAX } = {}) {
  const show = new Set(), drop = [], spare = [];
  for (const t of tiles) {
    if (t.d <= dropR) show.add(t.k);
    else if (t.d > keepR) drop.push(t.k);
    else spare.push(t);
  }
  spare.sort((a, b) => a.d - b.d);
  const room = Math.max(0, keepMax - show.size);
  for (const t of spare.slice(room)) drop.push(t.k);
  return { show, drop };
}
