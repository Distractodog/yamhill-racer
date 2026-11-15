// Water for the car and the dirt bike: one smooth model, the same in ponds and rivers (any waterLevelAt > ground).
//   * The tyres always ride on the bed (heightAt). The water never turns into "ground" for the springs, so nothing
//     flips between "the water holds you up" and "you sink" per wheel.
//   * A tyre in the water gets planing lift: a spring on how deep it is in, stiffer with speed² (critically damped).
//     At skimSpeed it holds its share of the weight about half a tyre deep, so faster skims, slower sinks in;
//     a tyre that is really planing (holding most of its share) also drives and steers, on water grip.
//   * Wading drag on every wet tyre grows with how deep it is in (shallow water: drivable, but slow).
//   * The body floats on a few columns (buoyancy + damping at each, so it settles level without bouncing). It slowly
//     floods, nose first: floats briefly, tips nose-down, sinks. ~3 s fully under (or stuck in water deeper than the
//     body with no grip) → back on the nearest bank (nearestBank).
// Pure physics: only world queries (heightAt / waterLevelAt / normalAt / treesNear / buildingsNear / loadedAt).
import * as THREE from 'three';

export const SKIM_DEPTH = 0.35;   // m a tyre sits in the water at exactly skimSpeed (deeper when slower)
export const PLANE_MAX = 4;       // planing stiffness stops growing at 2× skimSpeed (keeps it stable at 1000 km/h)
export const UNDER_SECS = 3;      // fully under this long → back to the bank
export const BOG_SECS = 4;        // wheels on the bed, body deep in the water, not moving → back to the bank

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// fraction of a tyre's share of the weight the water holds up statically, `depth` m in at `hSpeed` m/s
export function planeHold(depth, hSpeed, skimV) {
  return depth <= 0 ? 0 : Math.min(PLANE_MAX, (hSpeed / skimV) ** 2) * depth / SKIM_DEPTH;
}
// how much a planing tyre drives / steers (0..1): none until it holds a third of its share, full at all of it
export function planeGrip(hold) { return clamp(hold * 1.5 - 0.5, 0, 1); }
// critical damping rate (1/s) of that planing spring for one tyre's share
export function planeDamp(hSpeed, skimV, g) {
  return 2 * Math.sqrt(Math.min(PLANE_MAX, (hSpeed / skimV) ** 2) * g / SKIM_DEPTH);
}
// wading drag left at `hSpeed`: all of it below 0.9× skimSpeed, a quarter from 1.1× (a skimming tyre barely drags),
// so 0.3 m of water holds the car to ~50 km/h (the bike ~25), but a fast entry keeps skimming
export function skimRelief(hSpeed, skimV) {
  const s = clamp((hSpeed / skimV - 0.9) / 0.2, 0, 1);
  return 1 - 0.75 * s * s * (3 - 2 * s);
}
// how fast the body fills (+) or drains (-) at `sub` (0..1 under water): smooth through zero at a quarter under
export function floodRate(sub, rate) { return sub > 0.25 ? rate * Math.min(1, (sub - 0.25) / 0.25) : -0.5 * (1 - sub / 0.25); }
// grip left for tyres on the bed while the body is `sub` (0..1) in the water: all of it until a quarter, none at 2/3
export function bedGrip(sub) { return clamp(1 - (sub - 0.25) / 0.4, 0, 1); }

// nearest dry, flat, open spot to (x, z): rings outward, first spot with dry ground 4 m around it, nearly flat (a
// parked car mustn't roll back in), no trunk or building within reach, on a loaded tile inside the map.
// Faces away from the water. [x, z, yaw] or null. Only runs on a respawn (<1 ms in Node at the test sites).
export function nearestBank(world, x, z, maxR = 300) {
  const W = world, wet = (px, pz) => W.waterLevelAt(px, pz) > -Infinity, n = new THREE.Vector3();
  const near = (W.buildingsNear?.(x, z, maxR + 20) || []).filter(b => b.pts?.length && b.pts.some(([bx, bz]) => Math.hypot(bx - x, bz - z) < maxR + 60));
  const open = (px, pz) => {
    if (!W.loadedAt(px, pz) || (W.mapContains && !W.mapContains(px, pz, 6))) return false;
    for (let a = 0; a < 8; a++) if (wet(px + Math.sin(a * 0.785) * 4, pz + Math.cos(a * 0.785) * 4)) return false;
    if (wet(px, pz) || W.normalAt(px, pz, n).y < 0.97) return false;
    const h = W.heightAt(px, pz);
    for (let a = 0; a < 8; a++) if (Math.abs(W.heightAt(px + Math.sin(a * 0.785) * 4, pz + Math.cos(a * 0.785) * 4) - h) > 0.6) return false;
    let tree = false; W.treesNear(px, pz, 4, (tx, tz, tr) => { if (Math.hypot(tx - px, tz - pz) < tr + 3) tree = true; });
    if (tree) return false;
    for (const b of near) if (inOrNear(b.pts, px, pz, 4)) return false;
    return true;
  };
  for (let r = 4; r <= maxR; r += 3) {
    const steps = Math.max(16, Math.round(2 * Math.PI * r / 3));
    for (let k = 0; k < steps; k++) {
      const a = k / steps * 2 * Math.PI, px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      if (!open(px, pz)) continue;
      // a few metres further up the bank if that is open too, so the respawn isn't right at the water's edge
      const qx = px + Math.sin(a) * 4, qz = pz + Math.cos(a) * 4;
      return open(qx, qz) ? [qx, qz, a] : [px, pz, a];
    }
  }
  return null;
}

function inOrNear(pts, x, z, R) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x1, z1] = pts[j], [x2, z2] = pts[i];
    if (((z2 > z) !== (z1 > z)) && (x < (x1 - x2) * (z - z2) / (z1 - z2) + x2)) inside = !inside;
    const ex = x2 - x1, ez = z2 - z1, L = ex * ex + ez * ez || 1;
    const u = clamp(((x - x1) * ex + (z - z1) * ez) / L, 0, 1);
    if (Math.hypot(x - x1 - ex * u, z - z1 - ez * u) < R) return true;
  }
  return inside;
}
