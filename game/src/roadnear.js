// Road blocks' near level (markings, every strip sample: roads.js) built only when the camera comes near. A tile is
// built with each block's far level; the near one is drawn while the camera is within `show` m of the block's LOD
// position (three.js LOD: straight-line distance to (cx, 0, cz)), and is built ahead of that:
//   · within show + LEAD m of where the camera will be in the next LEAD_S seconds at its present velocity (the
//     closest approach along that line: soonDist) → built with the tile (as before), or, for a tile built earlier,
//     listed (want) and built in slices from the next frame's budget, nearest to showing first: those due to show
//     within ~DUE_S seconds before the tile builds, the rest from what the tile builds leave. Going by the velocity
//     (not just the speed) lets a fast jet high up skip the blocks below it, which stay ~altitude away, and a fast car
//     skip the blocks off to the side; LEAD covers turning and pitching. LEAD_S covers the streaming's reach
//     (streamplan.js LOAD_R + AHEAD_MAX ≈ 2.5 km, 9 s at 1000 km/h): the blocks along the way are built with their
//     tile as before, not later in a hurry while the next tiles build;
//   · within show + GUARD and still missing (a teleport, a respawn, a hidden tile shown again, a budget too small) →
//     built at once, in this frame, before it is drawn: the near level is never late, a forced build only costs time.
// Level flight ~900 m up never needs any (the far level's show distance is ≤ ~650 m). Pure (no three.js): tools/road_near_test.mjs.
export const LEAD = 250, LEAD_S = 10, GUARD = 30, DUE = 150, DUE_S = 1.5;
// a listed block this close to showing (m beyond its show distance) is due: built before the tile builds
export const dueSlack = speed => Math.max(DUE, speed * DUE_S);
// the distance three.js LOD.update measures: camera to the LOD's position, which sits at height 0
export const lodDist = (cam, x, z) => Math.hypot(cam.x - x, cam.y, cam.z - z);
// the least lodDist over the next LEAD_S seconds, flying on at vel (m/s; null: standing)
export function soonDist(cam, vel, x, z) {
  const dx = x - cam.x, dy = -cam.y, dz = z - cam.z;
  const vx = (vel?.x || 0) * LEAD_S, vy = (vel?.y || 0) * LEAD_S, vz = (vel?.z || 0) * LEAD_S, vv = vx * vx + vy * vy + vz * vz;
  const t = vv > 0 ? Math.max(0, Math.min(1, (dx * vx + dy * vy + dz * vz) / vv)) : 0;
  return Math.hypot(dx - vx * t, dy - vy * t, dz - vz * t);
}
// is a block at (x, z) with this show distance wanted now (at tile build time, and for want)? No camera yet: yes
export const nearNow = (cam, vel, x, z, show) => !cam || soonDist(cam, vel, x, z) < show + LEAD;

// entry: { lod, x, z, show, steps: () => generator (adds the level when it returns), gen, done, owner: { dead } }
export function createRoadNear({ now = () => performance.now() } = {}) {
  const want = [];
  let stepCost = 1;
  const stats = { forced: 0, built: 0, ms: 0, waiting: 0 };
  function finishNow(e) {
    e.gen ||= e.steps();
    while (!e.gen.next().done);
    e.done = true; stats.built++;
  }
  return {
    stats,
    // one tile's entries, every frame it is shown (world.js updateLOD). Removes finished ones from the list.
    check(list, cam, vel, owner) {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (!e.done) {
          const slack = lodDist(cam, e.x, e.z) - e.show;
          if (slack < GUARD) { finishNow(e); stats.forced++; }
          else if (nearNow(cam, vel, e.x, e.z, e.show)) { want.push({ e, slack, owner }); continue; }
          else continue;
        }
        list[i] = list[list.length - 1]; list.pop();
      }
    },
    // build what check listed (last frame) with slack < due, nearest to showing first, within budget ms (the first
    // step always runs, unless budget ≤ 0: none). keep: leave the list for another call this frame. Returns the ms.
    build(budget, { due = Infinity, keep = false } = {}) {
      if (!keep) stats.waiting = want.length;
      if (!want.length || !(budget > 0)) { if (!keep) want.length = 0; return 0; }
      want.sort((a, b) => a.slack - b.slack);
      const t0 = now();
      let first = true;
      out: for (const { e, owner, slack } of want) {
        if (slack >= due) break;
        if (e.done || owner?.dead) continue;
        for (;;) {
          const t = now();
          if (!first && t - t0 + stepCost > budget) break out;
          first = false;
          e.gen ||= e.steps();
          const r = e.gen.next(), ms = now() - t;
          stepCost = Math.max(ms, stepCost * 0.9 + ms * 0.1);
          if (r.done) { e.done = true; stats.built++; break; }
        }
      }
      if (!keep) want.length = 0;
      return now() - t0;
    },
  };
}
