// Aircraft respawns (jet.js and its types, heli.js). Owner's bug: "sometimes when I respawn the plane it spawns a
// little in the air, comes down on its nose and crashes, and it loops over and over". Causes found
// (tools/air_respawn_loop_test.mjs):
//   * reset() posed the gear through the vehicle's world queries while the vehicle still stood where it was (the wreck,
//     or a low pass): roofs near *that* spot at *that* height counted as ground, so beside a building a wheel was set
//     on the roof, 3–4 m up; the first step dropped it, it fell nose-first into the building, and the wreck lay right
//     there for the next respawn. Also, with no height to go by, a bridge deck above a spot counted as its ground.
//   * a race's air respawn at its last ring, hands off, flew into the rising ground ahead within ~5 s, then respawned
//     at the same ring.
// Now an aircraft respawn: moves the vehicle to the new spot first (roof queries are local, from ground level), poses
// the gear by the height the spot was recorded at (a deck above it doesn't count), and looks around the spot (up to
// ~45 m) for a stretch where the aircraft stands on its gear, level, dry, clear of buildings and trees, body above the
// ground, and where the next physics step finds the same ground; then no speed, no spin. An air respawn is raised
// so ~8 s of flight straight ahead clears the ground by 60 m. For GRACE s after either, a crash can't happen: the
// aircraft is put back on its gear where it is (or back in the air), so a respawn can never chain into a loop.
import * as THREE from 'three';

export const GRACE = 3;                    // s after a respawn in which a crash only resets it where it is
const RINGS = [6, 12, 20, 30, 45];
const _u = new THREE.Vector3(), _p = new THREE.Vector3();

// distance from (x, z) to the nearest building wall (0 inside one)
function buildingDistance(world, x, z) {
  let best = Infinity;
  for (const b of world.buildingsNear?.(x, z) || []) {
    const pts = b.pts; if (!pts?.length) continue;
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x1, z1] = pts[j], [x2, z2] = pts[i];
      if (((z2 > z) !== (z1 > z)) && (x < (x1 - x2) * (z - z2) / (z1 - z2) + x2)) inside = !inside;
      const ex = x2 - x1, ez = z2 - z1, L = ex * ex + ez * ez || 1, u = Math.max(0, Math.min(1, ((x - x1) * ex + (z - z1) * ez) / L));
      best = Math.min(best, Math.hypot(x - x1 - ex * u, z - z1 - ez * u));
    }
    if (inside) return 0;
  }
  return best;
}

// Find where to put an aircraft down near (x, z) facing yaw. pose(x, z, yaw, y) poses v (quat) on its gear with
// ground looked up at reference height y and returns the centre height; body: points in vehicle space that must clear
// the ground; reach: half span (m) kept clear of buildings and trunks. Returns { x, z, y (ref for reset) }.
// Leaves v standing at the chosen spot at ground level, so reset() poses it from there, below any roof.
export function findGround(v, x, z, yaw, opts) {
  const g = search(v, x, z, yaw, opts);
  v.pos.set(g.x, v.world.terrainAt?.(g.x, g.z) ?? 0, g.z); v.vel.set(0, 0, 0);
  return g;
}
function search(v, x, z, yaw, { yRef, pose, body = [], reach = 5 }) {
  const W = v.world, s = Math.sin(yaw), c = Math.cos(yaw);
  const tries = [[x, z]];
  // rings around the spot: straight ahead and behind first, then the diagonals, then sideways
  for (const d of RINGS) for (const k of [0, 4, 1, 7, 3, 5, 2, 6]) {
    const o = k * Math.PI / 4;
    tries.push([x + (s * Math.cos(o) + c * Math.sin(o)) * d, z + (c * Math.cos(o) - s * Math.sin(o)) * d]);
  }
  let fallback = null, fallbackUp = -Infinity;
  for (const [cx, cz] of tries) {
    if (!W.loadedAt(cx, cz) || (W.mapContains && !W.mapContains(cx, cz, 12))) continue;
    v.pos.set(cx, W.terrainAt(cx, cz), cz); v.vel.set(0, 0, 0);     // queries from the new spot, below any roof
    const y1 = pose(cx, cz, yaw, yRef);
    if (!Number.isFinite(y1)) continue;
    v.pos.y = y1;
    const y2 = pose(cx, cz, yaw, y1);                                    // what the first physics step will find
    _u.set(0, 1, 0).applyQuaternion(v.quat);
    const wet = W.waterLevelAt(cx, cz) > W.heightAt(cx, cz, y2) - 0.2;
    if (!wet && Math.abs(y1 - y2) < 0.25 && _u.y > fallbackUp) { fallback = { x: cx, z: cz, y: yRef }; fallbackUp = _u.y; }
    if (wet || Math.abs(y1 - y2) > 0.25 || _u.y < 0.93) continue;
    let clear = true;
    for (const [bx, by, bz] of body) {
      _p.set(bx, by, bz).applyQuaternion(v.quat); _p.x += cx; _p.y += y2; _p.z += cz;
      if (_p.y - W.heightAt(_p.x, _p.z, _p.y) < 0.15) { clear = false; break; }
    }
    if (!clear || buildingDistance(W, cx, cz) < reach + 2) continue;
    let trunk = false;
    W.treesNear?.(cx, cz, reach + 2, (tx, tz, tr) => { if (Math.hypot(tx - cx, tz - cz) < reach + tr + 0.5) trunk = true; });
    if (trunk) continue;
    return { x: cx, z: cz, y: yRef };
  }
  return fallback || { x, z, y: yRef };
}

// height for an air respawn at (x, z) heading yaw at kmh: at least y, 40 m over the ground here, and 60 m over the
// ground (tall firs reach ~50 m) for the next ~8 s straight ahead
export function airHeight(world, x, z, yaw, kmh, y) {
  let h = Math.max(Number.isFinite(y) ? y : -Infinity, world.heightAt(x, z) + 40);
  const reach = Math.max(300, kmh / 3.6 * 8), sx = Math.sin(yaw), sz = Math.cos(yaw);
  for (let d = 25; d <= reach; d += 25) h = Math.max(h, world.heightAt(x + sx * d, z + sz * d) + 60);
  return h;
}
