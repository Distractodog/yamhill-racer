// Far trees the fog hides (game/src/fogcull.js): a far tree chunk is left out only when drawing it changes no pixel.
// Checked by brute force on a made-up hilly world of 2 km tiles (some missing, as at the map's edge): thousands of
// random cameras (driving, 150 m, 800 m, looking any way) and tree chunks; for every chunk fogHidden leaves out, rays
// from the camera through points of the chunk (its corners, its top, random points) are marched on past it, and each
// must (a) be at view depth ≥ fog far where it passes the chunk (exactly the fog colour) and (b) meet drawn ground within
// the camera's far plane (so behind the tree is fogged ground, not the sky). Also: the fog presets' distances, a camera
// below the treetops leaves nothing out, and how much is left out from the air.
//   node tools/fog_cull_test.mjs
import assert from 'node:assert/strict';
import { fogHidden, minDepth, DEPTH_MARGIN, CLEAR } from '../game/src/fogcull.js';
import { ATMOSPHERE_PRESETS } from '../game/src/atmosphere.js';

const T = 2000, CLIP = 2200;
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
// terrain: hills and valleys, 20..260 m
const ground = (x, z) => 140 + 70 * Math.sin(x / 900 + 1) * Math.cos(z / 1300) + 35 * Math.sin(x / 260 + z / 310) + 15 * Math.cos(z / 90 - x / 140);
const tileOf = (x, z) => [Math.floor((x + T / 2) / T), Math.floor((z + T / 2) / T)];
const tiles = new Map(), C = 250, GN = 8;          // per tile: the lowest ground in each 250 m square (+ 64 m around), as world.js keeps
for (let tz = -4; tz <= 4; tz++) for (let tx = -4; tx <= 4; tx++) {
  const drawn = !(tx === 2 && tz === 0) && !(tz === -3) && !(tx === -1 && tz === 2);       // a missing tile, a missing row
  const ox = tx * T - T / 2, oz = tz * T - T / 2, mins = new Float64Array(GN * GN);
  for (let ci = 0; ci < GN; ci++) for (let cj = 0; cj < GN; cj++) {
    let m = Infinity;
    for (let z = oz + ci * C - 64; z <= oz + (ci + 1) * C + 64; z += 4) for (let x = ox + cj * C - 64; x <= ox + (cj + 1) * C + 64; x += 4) m = Math.min(m, ground(x, z));
    mins[ci * GN + cj] = m - 0.5;                    // - 0.5: the analytic ground between 4 m samples
  }
  tiles.set(`${tx},${tz}`, { drawn, mins, ox, oz });
}
const groundUnder = (x0, z0, x1, z1) => {
  const [a0, b0] = tileOf(x0, z0), [a1, b1] = tileOf(x1, z1); let g = Infinity;
  for (let tz = b0; tz <= b1; tz++) for (let tx = a0; tx <= a1; tx++) {
    const t = tiles.get(`${tx},${tz}`); if (!t?.drawn) return null;
    const i0 = Math.max(0, Math.floor((z0 - t.oz) / C)), i1 = Math.min(GN - 1, Math.floor((z1 - t.oz) / C));
    const j0 = Math.max(0, Math.floor((x0 - t.ox) / C)), j1 = Math.min(GN - 1, Math.floor((x1 - t.ox) / C));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) g = Math.min(g, t.mins[i * GN + j]);
  }
  return g;
};
const drawnAt = (x, z) => { const [a, b] = tileOf(x, z); return !!tiles.get(`${a},${b}`)?.drawn; };
// a tree chunk: 250 m cell, trees 10..45 m tall standing on the ground (box as InstancedMesh.computeBoundingBox gives it)
function chunk(cx, cz) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const h = ground(cx - 125 + i * 25, cz - 125 + j * 25); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  const top = 10 + rnd() * 35, w = top * 0.4;
  return { min: { x: cx - 125 - w, y: lo - 0.3, z: cz - 125 - w }, max: { x: cx + 125 + w, y: hi + top * 1.13, z: cz + 125 + w } };
}
// march the ray from cam through p on past p: true if it meets drawn ground within the far plane
function backedByGround(cam, p) {
  const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z, L = Math.hypot(dx, dy, dz);
  for (let s = L; s <= CLIP; s += 2) {
    const x = cam.x + dx / L * s, y = cam.y + dy / L * s, z = cam.z + dz / L * s;
    if (!drawnAt(x, z)) return false;
    if (y <= ground(x, z)) return true;
  }
  return false;
}

// ---- the presets' fog
for (const p of ATMOSPHERE_PRESETS) assert(p.far > p.near && p.far + DEPTH_MARGIN < CLIP, `${p.id}: fog ends inside the far plane`);
// ---- depth, not distance: a chunk far to the side is nearer in depth than in distance (and is NOT left out)
{
  const cam = { x: 0, y: 900, z: 0 }, fwd = { x: 0, y: 0, z: -1 };
  const box = { min: { x: 1700, y: 100, z: -300 }, max: { x: 1950, y: 150, z: -50 } };
  assert(minDepth(box, cam, fwd) === 50, 'min depth from the box corners');
  assert.equal(fogHidden(box, { cam, fwd, fogFar: 1500, clip: CLIP }, groundUnder), false, '2 km away but 50 m deep: drawn');
}
// ---- random cameras
const stats = {};
let hiddenAll = 0, checked = 0;
for (const [mode, n] of [['driving', 1500], ['150 m', 1500], ['800 m', 1500]]) {
  let hid = 0, far = 0, ideal = 0;
  for (let i = 0; i < n; i++) {
    const preset = ATMOSPHERE_PRESETS[i % ATMOSPHERE_PRESETS.length];
    const x = (rnd() - 0.5) * 9000, z = (rnd() - 0.5) * 9000;
    const up = mode === 'driving' ? 2 + rnd() * 6 : mode === '150 m' ? 150 + rnd() * 20 : 800 + rnd() * 50;
    const cam = { x, y: ground(x, z) + up, z };
    const yaw = rnd() * 2 * Math.PI, pitch = mode === 'driving' ? (rnd() - 0.6) * 0.3 : -0.05 - rnd() * 0.5;
    const fwd = { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
    const view = { cam, fwd, fogFar: preset.far, clip: CLIP };
    for (let k = 0; k < 12; k++) {
      const a = rnd() * 2 * Math.PI, r = 400 + rnd() * 2200, box = chunk(x + Math.sin(a) * r, z + Math.cos(a) * r);
      if (minDepth(box, cam, fwd) < preset.far) continue;
      far++;
      // what a perfect test could leave out (approximately: the camera above it, its corners and top centre backed by ground)
      if (cam.y > box.max.y) {
        const c9 = [{ x: (box.min.x + box.max.x) / 2, y: box.max.y, z: (box.min.z + box.max.z) / 2 }];
        for (const px of [box.min.x, box.max.x]) for (const py of [box.min.y, box.max.y]) for (const pz of [box.min.z, box.max.z]) c9.push({ x: px, y: py, z: pz });
        if (c9.every(p => backedByGround(cam, p))) ideal++;
      }
      if (!fogHidden(box, view, groundUnder)) continue;
      hid++;
      assert(cam.y - box.max.y >= CLEAR, 'camera above the chunk');
      // corners, the top face's grid, random inside points
      const pts = [];
      for (const px of [box.min.x, box.max.x]) for (const py of [box.min.y, box.max.y]) for (const pz of [box.min.z, box.max.z]) pts.push({ x: px, y: py, z: pz });
      for (let u = 0; u <= 4; u++) for (let v = 0; v <= 4; v++) pts.push({ x: box.min.x + (box.max.x - box.min.x) * u / 4, y: box.max.y, z: box.min.z + (box.max.z - box.min.z) * v / 4 });
      for (let q = 0; q < 12; q++) pts.push({ x: box.min.x + (box.max.x - box.min.x) * rnd(), y: box.min.y + (box.max.y - box.min.y) * rnd(), z: box.min.z + (box.max.z - box.min.z) * rnd() });
      for (const p of pts) {
        const depth = (p.x - cam.x) * fwd.x + (p.y - cam.y) * fwd.y + (p.z - cam.z) * fwd.z;
        assert(depth >= preset.far, `${mode}: a left-out point is in front of the fog's end (${depth.toFixed(0)} < ${preset.far})`);
        assert(backedByGround(cam, p), `${mode} ${preset.id}: a left-out chunk would show against the sky (cam ${cam.x.toFixed(0)},${cam.y.toFixed(0)},${cam.z.toFixed(0)})`);
        checked++;
      }
    }
  }
  stats[mode] = `${hid}/${far} (a perfect test: ~${ideal})`;
  hiddenAll += hid;
  // driving, the camera is mostly below the treetops: only a valley seen from a hill (rays checked above)
  if (mode === 'driving') assert(hid <= 0.05 * far, `driving: almost nothing left out (${hid}/${far})`);
  else if (process.env.STRICT) assert(hid > 0.2 * far, `${mode}: a good share of the chunks past the fog is left out (${hid}/${far})`);
}
// ---- cost: world.js asks for every far tree chunk of the shown tiles every frame (~1000–1500)
{
  const cams = [], boxes = [];
  for (let i = 0; i < 64; i++) {
    const x = (rnd() - 0.5) * 6000, z = (rnd() - 0.5) * 6000, up = i % 2 ? 150 : 800, yaw = rnd() * 6.28, pitch = -0.1 - rnd() * 0.3;
    cams.push({ cam: { x, y: ground(x, z) + up, z }, fwd: { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) }, fogFar: 1300, clip: CLIP });
  }
  for (let i = 0; i < 1500; i++) { const a = rnd() * 6.28, r = 300 + rnd() * 2400; boxes.push(chunk(Math.sin(a) * r, Math.cos(a) * r)); }
  let n = 0; const t0 = performance.now();
  for (const v of cams) { const c = v.cam; for (const b of boxes) { const s = { min: { x: b.min.x + c.x, y: b.min.y, z: b.min.z + c.z }, max: { x: b.max.x + c.x, y: b.max.y, z: b.max.z + c.z } }; if (fogHidden(s, v, groundUnder)) n++; } }
  const perFrame = (performance.now() - t0) / cams.length;
  console.log(`  cost: ${perFrame.toFixed(3)} ms a frame for 1500 chunks (${n} left out of ${cams.length * boxes.length})`);
  assert(perFrame < 1.5, `fogHidden for 1500 chunks takes ${perFrame.toFixed(2)} ms`);
}
// ---- the ground behind must be drawn: over a missing tile nothing is left out
{
  const x = 4000, z = 0, cam = { x: x - 1800, y: ground(x - 1800, 0) + 800, z }, fwd = { x: 0.9, y: -0.43, z: 0 };
  const L = Math.hypot(fwd.x, fwd.y); fwd.x /= L; fwd.y /= L;
  const box = chunk(x - 300, z);                       // just before tile (2, 0), which is missing
  assert.equal(fogHidden(box, { cam, fwd, fogFar: 850, clip: CLIP }, groundUnder), false, 'rays run on over a missing tile: drawn');
}
console.log(`PASS fog cull: ${checked} ray checks on left-out chunks, all fogged and in front of drawn ground · left out / past the fog: ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ')}`);
