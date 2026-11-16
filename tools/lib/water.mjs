// Water test sites on the real map, shared by tools/water_test.mjs and the water section of tools/drive.mjs.
//   import { RIVER, deepestPond, approach } from './lib/water.mjs';
export const RIVER = [3694, 1350];            // South Yamhill, west of Sheridan (~1.8 m deep)

// the deepest real-pond vertex (pondLevel only, not river pools) on loaded tiles within `r` m of (x, z)
export function deepestPond(W, x, z, r = 2500) {
  let best = null;
  for (const t of W.tiles.values()) {
    if (Math.hypot(t.x0 + 1000 - x, t.z0 + 1000 - z) > r + 1500) continue;
    for (let i = 0; i < t.NN; i++) for (let j = 0; j < t.NN; j++) {
      const k = t.pondId[i * t.NN + j]; if (!k || t.pondLevel[k] === undefined) continue;
      const px = t.gx0 + j * W.W.hstep, pz = t.gz0 + i * W.W.hstep;
      if (!W.loadedAt(px, pz) || Math.hypot(px - x, pz - z) > r) continue;
      const d = W.waterLevelAt(px, pz) - W.heightAt(px, pz);
      if (d > 0 && (!best || d > best.d)) best = { x: px, z: pz, d, id: k };
    }
  }
  return best;
}

// a run-up into the water at (cx, cz): a straight line from dry land with no trunks and no steep ground for 30+ m,
// short water run to the target (straight in, not along the bank), gentle bank. {x, z, yaw, run} or null.
export function approach(W, [cx, cz], back = 90) {
  const wl = (x, z) => W.waterLevelAt(x, z), wet = (x, z) => wl(x, z) > -Infinity;
  let best = null;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 36) {
    const sx = Math.sin(a), sz = Math.cos(a);
    let edge = null, clear = 0;
    for (let r = 0; r <= back; r += 1) { if (!wet(cx + sx * r, cz + sz * r)) { edge = r; break; } }
    if (edge === null || edge > 60) continue;
    for (let r = edge; r <= edge + 70; r += 2) {
      let hit = 0; W.treesNear(cx + sx * r, cz + sz * r, 3, () => hit++);
      if (hit || wet(cx + sx * r, cz + sz * r) || W.normalAt(cx + sx * r, cz + sz * r).y < 0.9) break; clear = r - edge;
    }
    const drop = W.heightAt(cx + sx * (edge + clear), cz + sz * (edge + clear)) - wl(cx, cz);
    const score = clear - edge * 2 - Math.abs(drop) * 3;
    if (clear >= 30 && (!best || score > best.score)) best = { score, edge, clear, a };
  }
  if (!best) return null;
  const r0 = best.edge + Math.min(best.clear, 60);
  return { x: cx + Math.sin(best.a) * r0, z: cz + Math.cos(best.a) * r0, yaw: best.a + Math.PI, run: r0 - best.edge };
}
