// Tile streaming decisions (game/src/streamplan.js): look-ahead along a turn, the turn-rate tracker, the per-frame
// build budget and which built tiles are kept when they fall behind.   node tools/stream_plan_test.mjs
import assert from 'node:assert/strict';
import { lookAhead, createTurnTracker, buildBudget, planKeep, rectDist, needDist, urgentDist, AHEAD_MAX, AHEAD_S, DROP_R, KEEP_R, KEEP_MAX, FAST, FAST_MS, BASE_MS, LOAD_R, URGENT_R } from '../game/src/streamplan.js';

const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// ---- look-ahead: straight = the old point (min(AHEAD_MAX, AHEAD_S·speed) along the velocity)
{
  const [p, ...rest] = lookAhead(100, 200, 0, 50);                 // 180 km/h north→south: 250 m ahead
  assert.equal(rest.length, 0); near(p.x, 100, 1e-9, 'straight x'); near(p.z, 200 + 50 * AHEAD_S, 1e-9, 'straight z');
  const [q] = lookAhead(0, 0, 300, 0, 0.004);                      // 1080 km/h, a turn too slight to matter: still the old point
  near(q.x, AHEAD_MAX, 1e-9, 'capped x'); near(q.z, 0, 1e-9, 'capped z');
  assert.deepEqual(lookAhead(5, 5, 0, 0, 1), [], 'standing still: no look-ahead');
}
// ---- turning: the points lie on the circle being flown, at the right arc length, and close the circle when it curls
{
  const v = 1000 / 3.6, w = 120 / v, R = v / w;                    // 1000 km/h at 5 g-ish: radius ≈ 643 m
  const pts = lookAhead(0, 0, v, 0, w);                             // heading east (yaw π/2), turning to larger yaw
  assert.equal(pts.length, 2);
  // the turn centre: heading (1, 0), yaw increasing turns towards -z (forward = (sin, cos))
  const cx = 0, cz = -R;
  for (const p of pts) near(Math.hypot(p.x - cx, p.z - cz), Math.abs(R), 1e-6, 'on the circle');
  // arc length AHEAD_MAX: angle travelled = AHEAD_MAX / R
  const ang = q => Math.atan2(q.x - cx, q.z - cz);
  let d = ang(pts[1]) - ang({ x: 0, z: 0 }); d = ((d % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  near(Math.min(d, 2 * Math.PI - d), Math.min(AHEAD_MAX / R, 2 * Math.PI - AHEAD_MAX / R), 1e-6, 'arc length');
  // the old straight point would be 1200 m out; on the circle every point stays within the diameter
  for (const p of pts) assert(Math.hypot(p.x, p.z) <= 2 * R + 1e-6, 'a curled arc stays near the vehicle');
  // the first step of the arc goes the way the velocity points, and turns the right way
  const [a] = lookAhead(0, 0, v, 0, 0.1);
  assert(a.x > 0 && a.z < 0, `yaw-increasing turn from east bends south→north (−z): ${a.x}, ${a.z}`);
  const [b] = lookAhead(0, 0, v, 0, -0.1);
  assert(b.x > 0 && b.z > 0, 'the other way bends +z');
}
// ---- turn tracker: steady turn → its rate; noise from respawns / teleports ignored; slow → 0
{
  const t = createTurnTracker(), v = 278, w = 0.4;
  let now = 0, h = 1;
  for (let i = 0; i < 120; i++) { t.update(Math.sin(h) * v, Math.cos(h) * v, now); now += 1000 / 60; h += w / 60; }
  near(t.rate, w, 1e-3, 'steady turn rate');
  t.update(Math.sin(h + 2) * v, Math.cos(h + 2) * v, now);           // a sudden 2 rad jump (respawn): not a turn
  assert.equal(t.rate, 0, 'a jump resets the rate');
  for (let i = 0; i < 5; i++) { now += 16.7; t.update(Math.sin(h) * 10, Math.cos(h) * 10, now); }
  assert.equal(t.rate, 0, 'slow: no turn look-ahead');
  // heading across ±π (flying north, z decreasing) is a small change, not a 2π jump
  const u = createTurnTracker(); now = 0; h = Math.PI - 0.05;
  for (let i = 0; i < 120; i++) { u.update(Math.sin(h) * v, Math.cos(h) * v, now); now += 1000 / 60; h += 0.3 / 60; }
  near(u.rate, 0.3, 1e-3, 'rate across ±π');
}
// ---- build budget: slow = the old formula exactly; fast = FAST_MS, halved while frames are slow; urgent = the old one
{
  for (const sp of [0, 10, 30, 60, FAST - 1]) assert.equal(buildBudget(sp), BASE_MS + Math.min(4, sp / 60), `driving at ${sp} m/s: unchanged`);
  assert.equal(buildBudget(30, { extraMs: 8 }), BASE_MS + 0.5 + 8, 'respawn hold extra');
  assert.equal(buildBudget(278), FAST_MS, 'fast, nothing missing nearby');
  assert(buildBudget(600) <= 4, 'never more than 4 ms a frame when nothing is urgent');
  assert.equal(buildBudget(278, { frameMs: 30 }), FAST_MS / 2, 'frames just missing 60 Hz: less');
  assert.equal(buildBudget(278, { frameMs: 60 }), BASE_MS + 4, 'a machine below 25 fps: the old budget, so the map keeps up');
  assert.equal(buildBudget(278, { urgent: true }), BASE_MS + 4, 'ground missing near the camera: the old budget');
  assert.equal(buildBudget(278, { extraMs: 8 }), FAST_MS + 8, 'respawn hold extra at speed');
}
// ---- load order: the tile next to the plane before a look-ahead tile farther along
{
  const T = 2000, cam = { x: 0, z: 0 };
  const nextTile = needDist(1000, -1000, T, cam), farTile = needDist(3000, -1000, T, cam);
  assert(nextTile < farTile, `the tile being entered first (${nextTile} vs ${farTile})`);
  assert.equal(nextTile, 1000 - LOAD_R); assert.equal(farTile, 3000 - LOAD_R);
  assert(needDist(-1000, -1000, T, cam) <= 0, 'the tile under the camera: wanted now');
}
// ---- urgent distance: 900 m up to 360 m/s, then 2.5 s of flight
{
  assert.equal(urgentDist(0), URGENT_R); assert.equal(urgentDist(278), URGENT_R, '1000 km/h: 900 m');
  near(urgentDist(2170 / 3.6), 2170 / 3.6 * 2.5, 1e-9, 'stealth top speed: 2.5 s ahead');
}
// ---- keep / drop
{
  assert.equal(rectDist(0, 0, -1000, -1000, 2000), 0, 'inside');
  near(rectDist(3000, 0, -1000, -1000, 2000), 2000, 1e-9, 'beside');
  near(rectDist(4000, 4000, -1000, -1000, 2000), Math.hypot(3000, 3000), 1e-9, 'corner');
  const tiles = [{ k: 'a', d: 0 }, { k: 'b', d: 1500 }, { k: 'c', d: DROP_R + 1 }, { k: 'd', d: KEEP_R + 1 }, { k: 'e', d: 3000 }];
  const p = planKeep(tiles);
  assert.deepEqual([...p.show].sort(), ['a', 'b'], 'shown: within DROP_R');
  assert.deepEqual(p.drop, ['d'], 'dropped: beyond KEEP_R only');
  // over the cap: the farthest hidden ones go; shown tiles never do
  const many = Array.from({ length: KEEP_MAX + 4 }, (_, i) => ({ k: i, d: i < 6 ? i * 100 : DROP_R + i * 50 }));
  const q = planKeep(many);
  assert.equal(q.show.size, 6);
  assert.equal(q.show.size + (many.length - q.show.size - q.drop.length), KEEP_MAX, 'total kept = KEEP_MAX');
  assert.deepEqual(q.drop, many.slice(KEEP_MAX).map(t => t.k), 'the farthest hidden tiles are dropped');
  // more shown than the cap (a big view): shown ones all stay, every hidden one goes
  const big = Array.from({ length: KEEP_MAX + 2 }, (_, i) => ({ k: i, d: 10 * i })).concat([{ k: 'x', d: DROP_R + 5 }]);
  const r = planKeep(big);
  assert.equal(r.show.size, KEEP_MAX + 2); assert.deepEqual(r.drop, ['x']);
}
console.log('stream plan: ok');
