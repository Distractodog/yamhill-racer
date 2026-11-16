// Roofs as solid, drawn surfaces for the vehicles. No three.js, no DOM (the Node tests use it).
//
// A building is a set of solid columns ("blocks") rising from the ground to the roof the game DRAWS there:
//   * campus and landmark buildings: their parts (campus.js / landmarks.js) on the building's floor;
//   * town buildings: the parts townbuild.js plans for the mesh (same plan, same floor as townmodel.js);
//   * flat roofs are flat, gable / hip roofs slope with their pitch (and overhang their walls by `over`),
//     a flat roof's parapet is a thin rim at the edge, boxes standing on a roof (rooftop units, tower caps,
//     chimneys) are columns of their own, and a campus porch roof is a canopy (support from above, no walls).
// A roof supports a vehicle only when the vehicle comes at it from above; below a roof its walls block. Walls
// between a building's blocks (a tower over a lower roof, a house over its garage) block a vehicle on the roof.
// Terrain queries elsewhere (streaming, spawning, scenery) stay unchanged.
import { inPoly, partPts, rectPts } from './campus.js';
import { floorOf, planBuilding, roadContext } from './townbuild.js';

const D2R = Math.PI / 180;
const RIM = 0.3;          // width of a parapet's top (it is drawn as a thin wall on the roof's edge)
const NUDGE = 0.05;       // a wall's height is read this far inside it
const ABOVE = 0.05;       // a vehicle's centre this far above a surface is on it, not in it
const SOFT = 0.06;        // m per step (+ its fall): easing a vehicle off a wall it is coming down beside
const RECENT = 150;       // position updates (~1 s) after leaving a roof while its building's walls ease, not bounce

const bounds = new WeakMap(), solids = new WeakMap(), owners = new WeakMap(), seen = new WeakSet(), roadsOf = new WeakMap();

// footprint bounding box [x0, z0, x1, z1]
function boxOf(b) {
  let bb = bounds.get(b);
  if (!bb) {
    bb = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, z] of b.pts) { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], z); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], z); }
    bounds.set(b, bb);
  }
  return bb;
}

// the loaded tile a town footprint came from (its roads and ground plan the building the way world.js does)
function tileOf(b, world) {
  if (!owners.has(b) && world.tiles) {
    for (const td of world.tiles.values()) if (!seen.has(td)) { seen.add(td); for (const x of td.buildings || []) owners.set(x, td); }
  }
  return owners.get(b);
}

function bbOf(pts, pad) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return { x0: x0 - pad, z0: z0 - pad, x1: x1 + pad, z1: z1 + pad };
}

// a roof triangle (three [x, y, z] corners) as a plane over its outline: y = gx·x + gz·z + c inside it
function tri(a, b, c) {
  const ux = b[0] - a[0], uz = b[2] - a[2], vx = c[0] - a[0], vz = c[2] - a[2], det = ux * vz - uz * vx;
  if (Math.abs(det) < 1e-9) return null;
  const uy = b[1] - a[1], vy = c[1] - a[1];
  const gx = (uy * vz - vy * uz) / det, gz = (vy * ux - uy * vx) / det;
  return { ax: a[0], az: a[2], ux, uz, vx, vz, det, gx, gz, c: a[1] - gx * a[0] - gz * a[2] };
}
// the outline grown by d on every side, corner by corner (campusmodel.js grow())
function grow(pts, d) {
  const n = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length], L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    let ox = (q[1] - p[1]) / L, oz = -(q[0] - p[0]) / L;
    if (inPoly(pts, (p[0] + q[0]) / 2 + ox * 0.05, (p[1] + q[1]) / 2 + oz * 0.05)) { ox = -ox; oz = -oz; }
    return [ox, oz];
  });
  return pts.map((p, i) => { const a = n[(i + pts.length - 1) % pts.length], b = n[i]; return [p[0] + (a[0] + b[0]) * d, p[1] + (a[1] + b[1]) * d]; });
}
// the drawn faces of a gable / hip roof (campusmodel.js roof(): long side first, eaves `over` out and down)
function pitchedTris(pts, R, yTop) {
  const r4 = Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]) >= Math.hypot(pts[2][0] - pts[1][0], pts[2][1] - pts[1][1]) ? pts : [pts[1], pts[2], pts[3], pts[0]];
  const tan = Math.tan((R.pitch || 0) * D2R), over = R.over || 0;
  const W = Math.hypot(r4[2][0] - r4[1][0], r4[2][1] - r4[1][1]), L = Math.hypot(r4[1][0] - r4[0][0], r4[1][1] - r4[0][1]);
  const [A, B, C, D] = grow(r4, over), yE = yTop - over * tan, yR = yTop + W / 2 * tan;
  const v = (p, y) => [p[0], y, p[1]], mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const faces = [];
  const quad = (a, b, c, d) => faces.push(tri(a, b, c), tri(a, c, d));
  if (R.type === 'gable') {
    const rDA = mid(D, A), rBC = mid(B, C);
    quad(v(A, yE), v(B, yE), v(rBC, yR), v(rDA, yR)); quad(v(C, yE), v(D, yE), v(rDA, yR), v(rBC, yR));
  } else {
    const c = mid(mid(A, B), mid(C, D)), ux = (r4[1][0] - r4[0][0]) / L, uz = (r4[1][1] - r4[0][1]) / L, k = Math.max(0, L - W) / 2;
    const R1 = [c[0] - ux * k, c[1] - uz * k], R2 = [c[0] + ux * k, c[1] + uz * k];
    quad(v(A, yE), v(B, yE), v(R2, yR), v(R1, yR)); quad(v(C, yE), v(D, yE), v(R1, yR), v(R2, yR));
    faces.push(tri(v(B, yE), v(C, yE), v(R2, yR)), tri(v(D, yE), v(A, yE), v(R1, yR)));
  }
  return { tris: faces.filter(Boolean), outline: [A, B, C, D], rise: W / 2 * tan };
}

// one part → its solid block (+ the boxes standing on its roof, + a porch canopy)
function partBlocks(p, floor, out) {
  const pts = partPts(p), R = p.roof || { type: 'flat' }, base = floor + p.h;
  if (pts.length < 3) return;
  let k;
  if (R.type === 'flat' || pts.length !== 4) k = { pts, base, parapet: R.type === 'flat' ? R.parapet || 0 : 0, rise: 0, ...bbOf(pts, 0) };
  else {
    const roof = pitchedTris(pts, R, base);
    k = { pts, base, parapet: 0, tris: roof.tris, rise: roof.rise, ...bbOf(roof.outline, 0) };
  }
  out.push(k);
  const rise = k.rise || k.parapet;
  for (const box of p.boxes || []) {
    if (box.y1 <= p.h || box.y0 > p.h + rise + 1 || !inPoly(pts, box.c[0], box.c[1])) continue;   // facade trim, flags
    const bp = rectPts(box);
    out.push({ pts: bp, base: floor + box.y1, parapet: 0, ...bbOf(bp, 0) });
  }
  if (p.porch) {             // porch roof on posts all round: from the wall top P.y down by P.drop over P.depth
    const P = p.porch;
    out.push({ pts, canopy: true, top: floor + P.y, drop: P.drop, depth: P.depth, base: floor + P.y, parapet: 0, ...bbOf(pts, P.depth) });
  }
}

// a footprint's blocks; with no plan (a bare footprint in a test world, say) one flat block at its top
function solidOf(b, world) {
  let s = solids.get(b);
  if (s) return s;
  const blocks = [];
  if (b.roofBuilding) {
    for (const p of b.roofBuilding.parts) partBlocks(p, b.roofBuilding.floor + (p.dy || 0), blocks);
  } else {
    const td = tileOf(b, world);
    if (td && b.pts.length >= 3) {
      let roads = roadsOf.get(td);
      if (!roads) roadsOf.set(td, roads = roadContext(td.renderRoads));
      const plan = planBuilding(b, { roads });
      if (plan.parts[0]?.pts.length >= 3) {
        const floor = floorOf(plan.parts[0].pts, td.terrainAt);
        for (const p of plan.parts) partBlocks({ ...p, porch: null }, floor, blocks);
      }
    }
  }
  if (!blocks.length) {
    const top = b.top ?? (world.groundAt || world.terrainAt || world.heightAt)(b.pts[0][0], b.pts[0][1]) + (b.h || 6);
    blocks.push({ pts: b.pts, base: top, parapet: 0, ...bbOf(b.pts, 0) });
  }
  const solid = blocks.filter(k => !k.canopy);
  // where no block covers a footprint that isn't one of the parts (a planned town footprint, the campus `phys`
  // outline): the lowest roof
  s = { blocks, low: b.roofBuilding && !b.roofBuilding.phys ? -Infinity : Math.min(...solid.map(k => k.base)),
    high: Math.max(...solid.map(k => k.base + (k.rise || k.parapet))), walls: solid.length > 1 };
  solids.set(b, s);
  return s;
}

// distance from (x, z) to the nearest edge of a polygon
function edgeDist(pts, x, z) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x1, z1] = pts[j], [x2, z2] = pts[i], ex = x2 - x1, ez = z2 - z1, L = ex * ex + ez * ez || 1;
    const u = Math.max(0, Math.min(1, ((x - x1) * ex + (z - z1) * ez) / L));
    best = Math.min(best, Math.hypot(x - x1 - ex * u, z - z1 - ez * u));
  }
  return best;
}

// the top of block k at (x, z), or -Infinity outside it; its uphill slope goes to grad
const grad = { x: 0, z: 0 };
function blockTop(k, x, z) {
  if (x < k.x0 || x > k.x1 || z < k.z0 || z > k.z1) return -Infinity;
  grad.x = 0; grad.z = 0;
  if (k.canopy) {
    if (inPoly(k.pts, x, z)) return -Infinity;
    // outside the walls, within the porch depth: the farther out, the lower
    let out = 0;
    for (let i = 0, j = k.pts.length - 1; i < k.pts.length; j = i++) {
      const [x1, z1] = k.pts[j], [x2, z2] = k.pts[i], L = Math.hypot(x2 - x1, z2 - z1) || 1;
      let nx = (z2 - z1) / L, nz = -(x2 - x1) / L;
      const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
      if (inPoly(k.pts, mx + nx * 0.05, mz + nz * 0.05)) { nx = -nx; nz = -nz; }
      const d = (x - mx) * nx + (z - mz) * nz;
      if (d > out) { out = d; grad.x = -nx * k.drop / k.depth; grad.z = -nz * k.drop / k.depth; }
    }
    if (out > k.depth) return -Infinity;
    return k.top - k.drop * out / k.depth;
  }
  if (!k.tris) return inPoly(k.pts, x, z) ? k.base : -Infinity;
  // pitched: the highest drawn face over the point
  let best = -Infinity;
  for (const f of k.tris) {
    const px = x - f.ax, pz = z - f.az, s = (px * f.vz - pz * f.vx) / f.det, t = (f.ux * pz - f.uz * px) / f.det;
    if (s < -1e-6 || t < -1e-6 || s + t > 1 + 1e-6) continue;
    const y = f.gx * x + f.gz * z + f.c;
    if (y > best) { best = y; grad.x = f.gx; grad.z = f.gz; }
  }
  return best;
}

// The highest drawn surface of footprint b at (x, z) that is no higher than cap (Infinity: the top of the column);
// -Infinity if there is none. Its uphill slope (rise per metre in x and z) is left in roofGrad. rims = false leaves
// out the parapets' tops.
export const roofGrad = { x: 0, z: 0 };
export function roofSurfaceAt(b, x, z, world, cap = Infinity, rims = true) {
  const bb = boxOf(b);
  if (x < bb[0] - 3 || x > bb[2] + 3 || z < bb[1] - 3 || z > bb[3] + 3) return -Infinity;
  const s = solidOf(b, world);
  let best = -Infinity, covered = false;
  for (const k of s.blocks) {
    const t = blockTop(k, x, z);
    if (t === -Infinity) continue;
    if (!k.canopy) covered = true;
    if (rims && k.parapet && t + k.parapet <= cap && t + k.parapet > best && edgeDist(k.pts, x, z) < RIM) { best = t + k.parapet; roofGrad.x = 0; roofGrad.z = 0; }
    if (t <= cap && t > best) { best = t; roofGrad.x = grad.x; roofGrad.z = grad.z; }
  }
  if (!covered && s.low <= cap && s.low > best && inPoly(b.pts, x, z)) { best = s.low; roofGrad.x = 0; roofGrad.z = 0; }
  return best;
}
// the top of the column (the roof seen from above), kept for older callers
export const buildingRoofAt = (b, x, z, world) => roofSurfaceAt(b, x, z, world);

// push v out of polygon pts (the shared wall response); top(inside, x, z, y) = the wall's height at a point just
// inside it. Returns the speed it hit the wall at (0 when it only eased off), -1 = not touching, -2 = above it.
function wallPush(v, pts, R, top, ease) {
  const p = v.pos;
  let inside = false, bestD = Infinity, bx = 0, bz = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x1, z1] = pts[j], [x2, z2] = pts[i];
    if (((z2 > p.z) !== (z1 > p.z)) && (p.x < (x1 - x2) * (p.z - z2) / (z1 - z2) + x2)) inside = !inside;
    const ex = x2 - x1, ez = z2 - z1, L = ex * ex + ez * ez || 1;
    const u = Math.max(0, Math.min(1, ((p.x - x1) * ex + (p.z - z1) * ez) / L));
    const cx = x1 + ex * u, cz = z1 + ez * u, d = Math.hypot(p.x - cx, p.z - cz);
    if (d < bestD) { bestD = d; bx = cx; bz = cz; }
  }
  if (!inside && bestD >= R) return -1;
  let nx = p.x - bx, nz = p.z - bz; const d = Math.hypot(nx, nz) || 1; nx /= d; nz /= d;
  if (inside) { nx = -nx; nz = -nz; }
  // above the drawn surface here (on the roof, or over the wall's top): this wall is below the vehicle
  const wallTop = top(inside, bx - nx * NUDGE, bz - nz * NUDGE, p.y);
  if (wallTop < p.y - ABOVE) return -2;
  let pen = inside ? R + bestD : R - bestD;
  const vn = v.vel.x * nx + v.vel.z * nz;
  // coming down beside a wall (off a roof, tipping over its edge), not driving into it: ease it clear, no snap
  if (ease && vn > -1 && (!inside || wallTop - p.y < 0.6)) {
    pen = Math.min(pen, SOFT + Math.max(0, -v.vel.y) / 120);      // keeps pace with the fall
    p.x += nx * pen; p.z += nz * pen; return 0;
  }
  p.x += nx * pen; p.z += nz * pen;
  if (vn < 0) { v.vel.x -= nx * vn * 1.3; v.vel.z -= nz * vn * 1.3; v.vel.multiplyScalar(0.85); v.hit = Math.max(v.hit, -vn); return -vn; }
  return 0;
}

// Walls of footprint b for vehicle v (horizontal radius R): the outer walls up to the drawn roof, then (on the roof)
// the walls of its higher blocks. Returns the speed of the hardest hit (0 = none).
export function collideBuilding(v, b, R) {
  if (!b.pts) return 0;
  const p = v.pos, bb = boxOf(b), W = v.world;
  if (p.x < bb[0] - R - 1 || p.x > bb[2] + R + 1 || p.z < bb[1] - R - 1 || p.z > bb[3] + R + 1) return 0;
  // up at roof level (or just off this roof), a wall it comes down beside eases it clear; on the ground, walls bounce
  const ease = W.recentRoof?.(b) || p.y - W.terrainAt(p.x, p.z) > 2.5;
  const outer = wallPush(v, b.pts, R, (inside, x, z, y) => {
    // inside: above some roof of it here, or how deep under its roof (a parapet's top doesn't count)
    if (inside && roofSurfaceAt(b, p.x, p.z, W, y - ABOVE) > -Infinity) return -Infinity;
    const t = inside ? roofSurfaceAt(b, p.x, p.z, W, Infinity, false) : roofSurfaceAt(b, x, z, W);
    return t > -Infinity ? t : solidOf(b, W).high;      // a reflex corner: the building's top
  }, ease);
  if (outer !== -2 || !solidOf(b, W).walls) return Math.max(0, outer);
  // on (or over) this building: its blocks' own walls, each up to its drawn top
  let worst = 0;
  for (const k of solidOf(b, W).blocks) {
    if (k.canopy || p.x < k.x0 - R || p.x > k.x1 + R || p.z < k.z0 - R || p.z > k.z1 + R) continue;
    const top = (inside, x, z) => {
      if (inside) return blockTop(k, p.x, p.z);
      const t = blockTop(k, x, z);
      return t > -Infinity && k.parapet ? t + k.parapet : t;
    };
    worst = Math.max(worst, wallPush(v, k.pts, R, top, ease));
  }
  return worst;
}

export function createVehicleWorld(world, vehicle) {
  let px = NaN, pz = NaN, loaded = false, tileCount = -1, near = [];
  function candidates() {
    const ready = world.loadedAt?.(vehicle.pos.x, vehicle.pos.z), count = world.tiles?.size;
    // Reuse the broad phase within an 8 m neighbourhood; 32 m padding covers the vehicle and wheel probes.
    if (!Number.isFinite(px) || Math.hypot(px - vehicle.pos.x, pz - vehicle.pos.z) > 8 || ready !== loaded || count !== tileCount) {
      loaded = ready; tileCount = count;
      px = vehicle.pos.x; pz = vehicle.pos.z;
      near = (world.buildingsNear?.(px, pz, 40) || []).filter(b => {
        if (!b.pts?.length) return false;
        const bb = boxOf(b); return px >= bb[0] - 32 && px <= bb[2] + 32 && pz >= bb[1] - 32 && pz <= bb[3] + 32;
      });
    }
    return near;
  }
  // What the vehicle stands on, once per position: the roof under its centre (if it is on one) and that roof's
  // slope. A roof counts when it is below the vehicle's centre (plus one step of descent, so a fast touchdown
  // can't tunnel through); on a sloped roof the uphill wheels may reach above the centre along that slope.
  const st = { x: NaN, y: NaN, z: NaN, roof: -Infinity, gx: 0, gz: 0, on: null, last: null, age: Infinity };
  function frame() {
    const P = vehicle.pos;
    if (P.x === st.x && P.y === st.y && P.z === st.z) return st;
    st.x = P.x; st.y = P.y; st.z = P.z; st.age++;
    st.ceiling = P.y + Math.max(0, -vehicle.vel.y) / 120 + 0.1;
    st.roof = -Infinity; st.gx = 0; st.gz = 0; st.on = null;
    for (const b of candidates()) {
      const h = roofSurfaceAt(b, P.x, P.z, world, st.ceiling);
      if (h > st.roof) { st.roof = h; st.on = b; st.gx = roofGrad.x; st.gz = roofGrad.z; }
    }
    // on it: close above it and above the ground there; else roofs further out only count below the centre
    if (st.on && P.y - st.roof < 4 && st.roof > world.heightAt(P.x, P.z, P.y)) { st.last = st.on; st.age = 0; }
    else { st.on = null; st.gx = 0; st.gz = 0; }
    return st;
  }
  let gx = 0, gz = 0;
  function roofAt(x, z) {
    const f = frame(), up = f.gx * (x - f.x) + f.gz * (z - f.z), ceiling = f.ceiling + (up > 0 ? up : 0);
    let height = -Infinity;
    for (const b of candidates()) {
      const h = roofSurfaceAt(b, x, z, world, ceiling);
      if (h > height) { height = h; gx = roofGrad.x; gz = roofGrad.z; }
    }
    return height;
  }
  const queries = {
    roofAt,
    onRoof: () => !!frame().on,
    // that building held the vehicle up within the last ~second (its walls ease it off rather than bounce it). Reads
    // the last support state only: the wall loop iterates world.buildingsNear's shared list, which a broad-phase
    // refresh here would overwrite.
    recentRoof: b => st.last === b && st.age < RECENT,
    // highest roof at (x, z) at or below y, from any building near there (camera clamp); -Infinity if none
    roofUnder(x, z, y) {
      let height = -Infinity;
      for (const b of world.buildingsNear?.(x, z, 8) || []) if (b.pts?.length) height = Math.max(height, roofSurfaceAt(b, x, z, world, y));
      return height;
    },
    heightAt: (x, z, y) => Math.max(world.heightAt(x, z, y), roofAt(x, z)),
    surfaceAt: (x, z, y) => roofAt(x, z) > world.heightAt(x, z, y) ? 6 : world.surfaceAt(x, z, y),
    normalAt: (x, z, out, y) => {
      const h = roofAt(x, z);
      if (h <= world.heightAt(x, z, y)) return world.normalAt(x, z, out, y);
      return out.set(-gx, 1, -gz).normalize();
    },
  };
  // Inherit live world state and override only support queries; no Proxy in the physics hot path.
  return Object.assign(Object.create(world), queries);
}
