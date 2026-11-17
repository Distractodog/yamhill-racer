import { applySatelliteGround, athleticsRoadSnapshot } from './campussatground.js';
// The outdoor running track north of the gym: shape and ground only (no three.js, so the headless tests share it).
// Measured on the NAIP satellite of tile 0_0: a 6-lane 400 m oval (lane 1 = 400 m) with a soccer infield, its long
// axis turned 12.3° from north-south (heading south it runs east), and a red jumps runway + pad on its west side.
// applyTrack levels the ground under it (so it is flat and drivable, with nothing poking through) and writes the
// surface classes; campustrackmodel.js draws it.

export const TRACK = {
  c: [-558.2, 44.7],                  // centre (world x, z)
  ax: [0.2133, 0.9770],               // unit vector of the long axis, pointing south
  R: 35.0,                            // inner edge radius of the bends
  S: 44.55,                           // half the straight length (straights are 89.1 m)
  lanes: 6, lane: 1.22,
  field: { L: 96, W: 60 },            // soccer pitch inside (a goal shows on the satellite 48 m from the centre)
  // jumps runway and pad on the west side (world x, z corners, convex)
  runway: [[[-623, 19], [-615, 19], [-611, 47], [-623, 47]], [[-635, 48], [-610, 47], [-610, 74], [-632, 75]]],
  flat: 5, blend: 15,                 // level ground out to 5 m past the outer edge, then ease back over 15 m
};
TRACK.RO = TRACK.R + TRACK.lanes * TRACK.lane;      // outer edge

// track frame: u along the long axis (south +), p across it (east +)
export function trackUV(x, z) {
  const { c, ax } = TRACK, dx = x - c[0], dz = z - c[1];
  return [dx * ax[0] + dz * ax[1], dx * ax[1] - dz * ax[0]];
}
export function trackXZ(u, p) {
  const { c, ax } = TRACK;
  return [c[0] + u * ax[0] + p * ax[1], c[1] + u * ax[1] - p * ax[0]];
}
// distance from the centre segment of the oval: < R infield, R..RO the running lanes
export function trackRadius(x, z) {
  const [u, p] = trackUV(x, z), e = Math.max(0, Math.abs(u) - TRACK.S);
  return Math.hypot(e, p);
}
function inConvex(q, x, z) {
  let s = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q[(i + 1) % q.length], c = (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (c !== 0) { if (s && Math.sign(c) !== s) return false; s = Math.sign(c); }
  }
  return true;
}
export const onRunway = (x, z) => TRACK.runway.some(q => inConvex(q, x, z));

// Level the height grid under the track and set its surface classes. Runs once per tile, before the campus.
export function applyTrack(td) {
  const { RO, R, flat, blend } = TRACK, reach = RO + flat + blend, [cx, cz] = TRACK.c, ext = TRACK.S + reach;
  if (cx + ext < td.x0 || cx - ext > td.x0 + 2000 || cz + ext < td.z0 || cz - ext > td.z0 + 2000) return;
  const restoreRoads = athleticsRoadSnapshot(td);
  const { H, NN, gx0, gz0 } = td, HS = td.hs;
  // ground level: median terrain over the oval
  const hs = [];
  for (let u = -TRACK.S - RO; u <= TRACK.S + RO; u += 4) for (let p = -RO; p <= RO; p += 4) {
    const [x, z] = trackXZ(u, p); if (trackRadius(x, z) <= RO) hs.push(td.terrainAt(x, z));
  }
  hs.sort((a, b) => a - b);
  const level = hs[hs.length >> 1];
  TRACK.level = level;
  const j0 = Math.max(0, Math.floor((cx - ext - gx0) / HS)), j1 = Math.min(NN - 1, Math.ceil((cx + ext - gx0) / HS));
  const i0 = Math.max(0, Math.floor((cz - ext - gz0) / HS)), i1 = Math.min(NN - 1, Math.ceil((cz + ext - gz0) / HS));
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const d = trackRadius(gx0 + j * HS, gz0 + i * HS) - RO;
    if (d >= flat + blend) continue;
    let t = Math.max(0, (d - flat) / blend); t = t * t * (3 - 2 * t);
    const k = i * NN + j; H[k] = level + (H[k] - level) * t;
  }
  applySatelliteGround(td, level, TRACK.runway);
  restoreRoads();
  // surface: lanes = running track (7), infield = grass (0); the old painted oval elsewhere goes back to grass.
  // A trail strip that runs under the oval (below the level ground) must not make it report dirt.
  const surf = td.surf, base = td.surfaceAt;
  td.surfaceAt = (x, z, y) => { const r = trackRadius(x, z); return r <= RO ? (r > R ? 7 : 0) : onRunway(x,z) ? 7 : base(x, z, y); };
  if (!surf) return;
  for (let v = 0; v < 2000; v++) {
    const z = td.z0 + v + 0.5; if (Math.abs(z - cz) > ext) continue;
    for (let uu = 0; uu < 2000; uu++) {
      const x = td.x0 + uu + 0.5; if (Math.abs(x - cx) > ext) continue;
      const k = v * 2000 + uu, r = trackRadius(x, z), was = surf[k];
      if (r <= RO) surf[k] = r > R ? 7 : 0;
      else if (onRunway(x, z)) surf[k] = 7;
      else if (was === 7) surf[k] = 0;
    }
  }
}
