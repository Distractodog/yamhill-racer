// Delphian School campus buildings, hand-authored from the satellite (NAIP), OSM footprints, the school's own photos and
// its illustrated tour map (delphian.org/uploaded/tour). Plain data + footprint logic, no three.js, so the headless
// tests (tools/drive.mjs) see the same walls as the game. The meshes are built by campusmodel.js.
//
// World metres: x east, z south. Heights are metres above the building's floor level (`floor`: the terrain at
// `floorAt`, plus `dy`). Each building replaces the OSM block(s) whose centroid matches `osm`.
//
// Part = one block: { pts: [[x,z]...] | rect: {c:[x,z], L, W, a (deg, direction of the L side)},
//   h: wall top, wall: [r,g,b], roof: {type: 'flat'|'gable'|'hip', color, pitch (deg), over, parapet, trim},
//   win: {rows, sh (storey height), sill, w, h, every, color, margin, below (also basement rows where the ground
//         drops away)}, doors: [{edge, t, w, h, color, frame}], porch, boxes: [...] }

// ---- palette (flat colours, lit by the scene's sun + sky)
const BRICK = [0.86, 0.58, 0.38];      // Main Building: buff / orange brick
const STONE = [0.93, 0.90, 0.82];      // cast-stone trim, tower face, entrance surround
const CREAM = [0.93, 0.89, 0.76];      // painted later wings (courtyard side)
const GLASS = [0.27, 0.33, 0.40];
const GLASS_L = [0.30, 0.37, 0.43];
const ROOF_W = [0.84, 0.85, 0.84];     // white membrane roofs (satellite)
const ROOF_G = [0.50, 0.51, 0.50];
const DOOR = [0.28, 0.20, 0.14];

// ---- Main Building (1933 Jesuit novitiate, Art Deco, tan brick, flat roofs) — OSM outline vertices
const V = [[-607.2, 382.3], [-587.0, 420.0], [-546.8, 398.5], [-543.9, 403.9], [-519.8, 391.0], [-522.7, 385.6],
  [-486.5, 366.1], [-506.7, 328.4], [-516.7, 333.8], [-506.0, 353.7], [-536.2, 369.9], [-552.9, 338.9],
  [-569.9, 348.0], [-553.2, 379.0], [-584.9, 396.0], [-595.6, 376.1]];
const U = [0.8829, -0.4695];           // along the south front (ENE)
const N = [0.4695, 0.8829];            // out of the south front (SSE)
const add = (p, ...t) => { const r = [p[0], p[1]]; for (let i = 0; i < t.length; i += 2) { r[0] += t[i][0] * t[i + 1]; r[1] += t[i][1] * t[i + 1]; } return r; };
const DEPTH = 20.2;                    // the south range is a double-loaded corridor ~20 m deep
const A0 = add(V[1], U, 13.2);         // east face of the west end wing
const frontC = [(V[3][0] + V[4][0]) / 2, (V[3][1] + V[4][1]) / 2];
export const ENTRANCE = { at: frontC, N, U };
const brickWin = (rows, extra = {}) => ({ rows, sh: 3.6, sill: 1.0, w: 1.4, h: 2.1, every: 3.3, color: GLASS, margin: 1.6, below: true, ...extra });
const ribbon = (rows, extra = {}) => ({ rows, sh: 3.4, sill: 1.0, w: 2.7, h: 1.5, every: 3.1, color: GLASS_L, margin: 1.2, below: true, ...extra });
const flat = (color = ROOF_W, parapet = 0.9, trim = STONE) => ({ type: 'flat', color, parapet, trim });

const MAIN = {
  name: 'Main Building', osm: [[-548.4, 371.4]], floorAt: [frontC[0] + N[0] * 4, frontC[1] + N[1] * 4], dy: 0.3,
  phys: [V],
  parts: [
    // west end wing (3 storeys). South face is an even pier grid; the other walls stay simple windows.
    { name: 'west wing', pts: [V[0], V[1], A0, V[15]], h: 12.2, wall: BRICK, roof: flat(), win: brickWin(3, { bays: { face: N, every: 3.3, sill: STONE } }) },
    // four-storey core, west of the tower: 2+2 bays, then an even pier rhythm out to the wing
    { name: 'front west', pts: [A0, V[2], add(V[2], N, -DEPTH), add(A0, N, -DEPTH)], h: 15.6, wall: BRICK, roof: flat(ROOF_G),
      win: brickWin(4, { bays: { face: N, groups: [2, 2], anchor: frontC, span: 18, sill: STONE } }) },
    // centre block, stepped forward 6 m: the entrance + tower
    { name: 'centre', pts: [V[3], V[4], add(V[5], N, -DEPTH), add(V[2], N, -DEPTH)], h: 16.6, wall: BRICK, roof: flat(), win: brickWin(4),
      doors: [{ edge: 0, t: 0.5, w: 1.15, h: 3.2, leaves: 2, color: [0.16, 0.17, 0.18], frame: { w: 3.6, h: 4.2, color: STONE }, sign: true }] },
    { name: 'tower', rect: { c: add(frontC, N, -2.6), L: 7.4, W: 6.4, a: -28 }, h: 26.5, wall: BRICK, roof: flat(ROOF_W, 0.6), win: null,
      boxes: [   // stone shaft, six small openings (2 by 3) near the top, then a stepped cap and coping
        { c: add(frontC, N, 0.85), L: 3.6, W: 0.5, a: -28, y0: 3.6, y1: 26.4, color: STONE },
        ...[0, 1].flatMap(col => [0, 1, 2].map(row => ({
          c: add(frontC, U, (col - 0.5) * 1.35, N, 1.15), L: 0.72, W: 0.08, a: -28,
          y0: 20.4 + row * 1.65, y1: 21.05 + row * 1.65, color: GLASS,
        }))),
        { c: add(frontC, N, -2.6), L: 6.0, W: 5.0, a: -28, y0: 26.5, y1: 27.3, color: BRICK },
        { c: add(frontC, N, -2.6), L: 7.0, W: 6.0, a: -28, y0: 27.3, y1: 28.1, color: BRICK },
        { c: add(frontC, N, -2.6), L: 7.4, W: 6.4, a: -28, y0: 28.1, y1: 28.4, color: STONE },
      ] },
    { name: 'penthouse', rect: { c: add(frontC, N, -12), L: 7, W: 6, a: -28 }, h: 19.4, wall: BRICK, roof: flat(ROOF_W, 0.4), win: null },
    // south front range, east half
    { name: 'front east', pts: [V[5], V[6], add(V[6], N, -DEPTH), add(V[5], N, -DEPTH)], h: 15.6, wall: BRICK, roof: flat(),
      win: brickWin(4, { bays: { face: N, groups: [2, 2], anchor: frontC, span: 18, setback: true, sill: STONE } }) },
    // east wing: the painted wing with ribbon windows and the steel fire stair seen from the courtyard
    { name: 'east wing', pts: [V[7], V[8], V[9], add(V[7], V[9], 1, V[8], -1)], h: 14.2, wall: CREAM, roof: flat(ROOF_G, 0.6, CREAM),
      win: ribbon(4, { bays: { face: N, every: 3.2, sill: STONE, w: 1.3, h: 1.7 } }),
      boxes: [{ c: add(V[8], U, -1.3, N, 6), L: 2.4, W: 3.6, a: -28, y0: 0, y1: 13.6, color: [0.25, 0.25, 0.26], frame: true }] },
    // chapel (now chapel / performing-arts space): tall walls, steep dark gable roof behind the tower
    { name: 'chapel', pts: [V[12], V[11], V[10], V[13]], h: 9.5, wall: BRICK, roof: { type: 'gable', color: [0.33, 0.32, 0.33], pitch: 34, over: 0.4 },
      win: { rows: 1, sh: 9, sill: 2.4, w: 1.6, h: 5.2, every: 4.2, color: GLASS, margin: 2.5, below: true } },

  ],
};

// ---- the rest of campus (OSM footprints, checked against the satellite)
const R = (c, L, W, a) => ({ c, L, W, a });
const SIDING = [[0.93, 0.86, 0.68], [0.82, 0.84, 0.82], [0.80, 0.72, 0.55], [0.66, 0.74, 0.62], [0.95, 0.92, 0.84]];
const house = (name, osmC, rect, roofCol, wallCol, extra = {}) => ({
  name, osm: [osmC], floorAt: rect.c, dy: 0.25,
  parts: [{ rect, h: 3.0, wall: wallCol, roof: { type: 'gable', color: roofCol, pitch: 24, over: 0.5 },
    win: { rows: 1, sh: 3, sill: 0.9, w: 1.3, h: 1.3, every: 3.6, color: GLASS, margin: 1.4 },
    doors: [{ edge: 0, t: 0.35, w: 1.0, h: 2.1, color: DOOR }], ...extra }],
});
const hipHouse = (name, osmC, parts) => ({
  name, osm: [osmC], floorAt: parts[0].rect ? parts[0].rect.c : parts[0].pts[0], dy: 0.25,
  parts: parts.map(p => ({ h: 3.0, roof: { type: p.gable ? 'gable' : 'hip', color: p.roofCol, pitch: 23, over: 0.5 },
    win: { rows: 1, sh: 3, sill: 0.9, w: 1.3, h: 1.3, every: 3.6, color: GLASS, margin: 1.4 }, ...p })),
});

const step = (name, c, L, W, h, color) => ({ name, rect: { c, L, W, a: -28 }, h, wall: color, roof: { type: 'flat', color, parapet: 0 }, win: null });
const CONCRETE = [0.78, 0.78, 0.75];
export const CAMPUS = [
  MAIN,
  // Upper flight and cheeks are solid. The lower tread is the same low wall. The plaza itself is not a wall.
  { name: 'Entrance steps', osm: [], floorAt: add(frontC, N, 2.0), dy: 0.02,
    parts: [
      step('upper', add(frontC, N, 1.5), 6.4, 2.2, 0.72, STONE),
      step('lower', add(frontC, N, 3.3), 7.2, 1.6, 0.34, CONCRETE),
      step('cheek west', add(frontC, U, -3.6, N, 2.3), 0.4, 4.0, 0.55, STONE),
      step('cheek east', add(frontC, U, 3.6, N, 2.3), 0.4, 4.0, 0.55, STONE),
    ] },
  { name: 'Entrance flags', osm: [], floorAt: add(frontC, N, 9, U, -5), dy: 0,
    parts: [
      { ...step('flag west', add(frontC, N, 9.2, U, -5.2), 0.22, 0.22, 7.2, [0.72, 0.73, 0.75]),
        boxes: [{ c: add(frontC, N, 9.2, U, -4.5), L: 1.5, W: 0.05, a: -28, y0: 5.6, y1: 6.7, color: [0.70, 0.16, 0.18] }] },
      { ...step('flag east', add(frontC, N, 9.2, U, 5.2), 0.22, 0.22, 7.2, [0.72, 0.73, 0.75]),
        boxes: [{ c: add(frontC, N, 9.2, U, 4.5), L: 1.5, W: 0.05, a: -28, y0: 5.6, y1: 6.7, color: [0.15, 0.28, 0.62] }] },
    ] },
  // Kitchen: one storey from the uphill courtyard; the downhill ground exposes the lower floor.
  // Its own floor/physics height avoids inheriting the main building's much higher floor and tower roof.
  { name: 'Back kitchen', osm: [], floorAt: add(V[12], U, 24, N, 1), dy: 0.2,
    parts: [{ name: 'kitchen', pts: [add(V[12], U, 0), add(V[12], U, 48), add(V[12], U, 48, N, -11), add(V[12], U, 0, N, -11)],
      h: 3.6, wall: CREAM, roof: flat(ROOF_W, 0.6, CREAM), win: { ...ribbon(1), sh: 3.0, sill: 0.7, basementRows: 1 } }] },
  { name: 'Gym', osm: [[-510.5, 177.8]], floorAt: [-510.5, 205], dy: 0.2,
    parts: [{ rect: R([-510.5, 177.8], 48.5, 28.7, 90), h: 10.5, wall: [0.85, 0.80, 0.67], roof: flat([0.90, 0.90, 0.89], 0.6, [0.62, 0.55, 0.45]),
      win: { rows: 1, sh: 10, sill: 7.0, w: 3.2, h: 1.6, every: 6.0, color: GLASS_L, margin: 3 },
      doors: [{ edge: 1, t: 0.5, w: 4.0, h: 3.0, color: [0.35, 0.40, 0.38], frame: { w: 8, h: 4.2, color: [0.62, 0.55, 0.45] } }],
      boxes: [[-516, 166], [-505, 166], [-516, 189], [-505, 189]].map(c => ({ c, L: 2.6, W: 2.0, a: 0, y0: 10.5, y1: 11.9, color: [0.70, 0.71, 0.70] })) }] },
  { name: 'Heron Print Shop', osm: [[-607.9, 229.4]], floorAt: [-607.9, 229.4], dy: 0.2,
    parts: [{ rect: R([-607.9, 229.4], 23.3, 13.1, 38.9), h: 6.6, wall: [0.47, 0.54, 0.47], wallTop: { y: 3.3, color: [0.90, 0.87, 0.74] },
      roof: { type: 'hip', color: [0.70, 0.74, 0.73], pitch: 20, over: 0.6 },
      win: { rows: 2, sh: 3.3, sill: 0.9, w: 1.5, h: 1.5, every: 3.4, color: GLASS, margin: 1.6 },
      doors: [{ edge: 0, t: 0.5, w: 1.8, h: 2.2, color: [0.85, 0.86, 0.84] }],
      porch: { y: 3.3, depth: 2.4, drop: 0.5, color: [0.72, 0.75, 0.74], post: [0.88, 0.88, 0.84], every: 4 } }] },
  { name: 'West building by the parking', osm: [[-638.3, 329.9]], floorAt: [-638.3, 329.9], dy: 0.2,
    parts: [{ rect: R([-638.3, 329.9], 33.9, 19.8, 106.9), h: 7.0, wall: [0.86, 0.80, 0.66], roof: { type: 'hip', color: [0.52, 0.53, 0.49], pitch: 14, over: 0.5 },
      win: { rows: 2, sh: 3.3, sill: 0.9, w: 1.6, h: 1.4, every: 3.6, color: GLASS, margin: 1.6 } }] },
  { name: 'Larson Hall + Heron Books HQ', osm: [[-459.7, 439.0]], floorAt: [-459.7, 439.0], dy: 0.2,
    parts: [{ rect: R([-459.7, 439.0], 31.8, 16.4, 74.6), h: 7.2, wall: [0.90, 0.88, 0.81], roof: { type: 'hip', color: [0.62, 0.63, 0.59], pitch: 18, over: 0.7 },
      win: { rows: 2, sh: 3.5, sill: 0.7, w: 2.2, h: 2.0, every: 3.4, color: GLASS_L, margin: 1.6 },
      doors: [{ edge: 2, t: 0.5, w: 2.4, h: 2.4, color: GLASS }] }] },
  { name: 'Dragon Hall + Student Lounge', osm: [[-589.1, 496.9]], floorAt: [-589.1, 496.9], dy: 0.2,
    parts: [{ rect: R([-589.1, 496.9], 27.0, 13.8, 176), h: 6.6, wall: [0.83, 0.84, 0.83], roof: { type: 'gable', color: [0.50, 0.52, 0.52], pitch: 18, over: 0.6 },
      win: { rows: 2, sh: 3.2, sill: 0.9, w: 1.8, h: 1.5, every: 3.4, color: GLASS, margin: 1.4 },
      doors: [{ edge: 0, t: 0.5, w: 1.8, h: 2.2, color: [0.42, 0.50, 0.58] }] }] },
  // West Staff Housing (single-storey houses and duplexes)
  house('Staff house 36', [-790.7, 595.2], R([-790.7, 595.2], 29.3, 11.2, 160.7), [0.58, 0.59, 0.55], SIDING[0]),
  house('Staff house 37', [-833.5, 608.1], R([-833.5, 608.1], 29.3, 11.2, 160.7), [0.57, 0.58, 0.54], SIDING[1]),
  house('Staff house 39', [-814.3, 515.7], R([-814.3, 515.7], 31.3, 11.8, 79.9), [0.44, 0.45, 0.41], SIDING[2]),
  house('Staff house 40', [-807.8, 468.7], R([-807.8, 468.7], 31.3, 11.8, 117.0), [0.52, 0.53, 0.48], SIDING[3]),
  house('Staff house 41', [-757.4, 472.6], R([-757.4, 472.6], 31.3, 11.8, 173.0), [0.52, 0.53, 0.46], SIDING[4]),
  hipHouse('Staff house 38', [-832.0, 568.8], [
    { pts: [[-850.5, 576.1], [-839.0, 553.5], [-828.0, 558.9], [-839.5, 581.7]], roofCol: [0.80, 0.81, 0.79], wall: SIDING[4], gable: true },
    { pts: [[-829.3, 558.3], [-816.4, 560.0], [-817.3, 569.2], [-832.5, 567.7]], roofCol: [0.36, 0.37, 0.40], wall: SIDING[4] }]),
  hipHouse('Staff house 42', [-696.1, 522.2], [{ rect: R([-696.1, 522.2], 19.2, 17.4, 154.0), roofCol: [0.44, 0.44, 0.40], wall: SIDING[2] }]),
  hipHouse('Staff house 43', [-725.6, 557.2], [{ rect: R([-725.6, 557.2], 19.2, 17.4, 154.0), roofCol: [0.43, 0.44, 0.40], wall: SIDING[0] }]),
  hipHouse('Staff house 44', [-754.1, 573.5], [{ rect: R([-754.1, 573.5], 19.2, 17.4, 154.0), roofCol: [0.48, 0.50, 0.45], wall: SIDING[3] }]),
  hipHouse('Staff house 45', [-663.2, 506.9], [
    { pts: [[-669.1, 523.8], [-646.0, 511.8], [-652.2, 499.9], [-675.3, 511.9]], roofCol: [0.43, 0.49, 0.47], wall: SIDING[1] },
    { pts: [[-665.7, 494.4], [-657.3, 490.0], [-652.2, 499.9], [-660.6, 504.2]], roofCol: [0.43, 0.49, 0.47], wall: SIDING[1] }]),
  // barns east of campus (equestrian): two red-roofed, one grey metal
  ...[[[112.0, 614.8], 22.2, 16.7, 135.0, [0.66, 0.28, 0.25]], [[94.0, 604.8], 20.2, 10.5, 136.4, [0.62, 0.27, 0.25]],
      [[122.5, 577.7], 20.6, 15.8, 150.9, [0.72, 0.76, 0.77]]].map(([c, L, W, a, rc], i) => ({
    name: 'Barn ' + (i + 1), osm: [c], floorAt: c, dy: 0.2,
    parts: [{ rect: R(c, L, W, a), h: 4.6, wall: i < 2 ? [0.62, 0.30, 0.24] : [0.86, 0.85, 0.80], roof: { type: 'gable', color: rc, pitch: 22, over: 0.5 },
      win: { rows: 1, sh: 4, sill: 1.6, w: 1.2, h: 0.9, every: 4.5, color: GLASS, margin: 2.5 },
      doors: [{ edge: 1, t: 0.5, w: 3.4, h: 3.4, color: i < 2 ? [0.88, 0.86, 0.80] : [0.45, 0.46, 0.45] }] }],
  })),
];

// ---- footprints for physics + rendering hooks
export function rectPts({ c, L, W, a }) {
  const r = a * Math.PI / 180, ux = Math.cos(r), uz = Math.sin(r), vx = -uz, vz = ux;
  return [[c[0] - ux * L / 2 - vx * W / 2, c[1] - uz * L / 2 - vz * W / 2], [c[0] + ux * L / 2 - vx * W / 2, c[1] + uz * L / 2 - vz * W / 2],
          [c[0] + ux * L / 2 + vx * W / 2, c[1] + uz * L / 2 + vz * W / 2], [c[0] - ux * L / 2 + vx * W / 2, c[1] - uz * L / 2 + vz * W / 2]];
}
export const partPts = p => p.pts || rectPts(p.rect);

// highest point of a part above the floor (roof ridge / boxes on top)
export function partTop(p) {
  let t = p.h + (p.roof && p.roof.parapet || 0);
  if (p.roof && (p.roof.type === 'gable' || p.roof.type === 'hip')) {
    const pts = partPts(p), w = Math.min(Math.hypot(pts[1][0] - pts[2][0], pts[1][1] - pts[2][1]), Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]));
    t = p.h + w / 2 * Math.tan(p.roof.pitch * Math.PI / 180);
  }
  for (const b of p.boxes || []) t = Math.max(t, b.y1);
  return t;
}

export function inPoly(pts, x, z) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [x1, z1] = pts[j], [x2, z2] = pts[i];
    if ((z2 > z) !== (z1 > z) && x < (x1 - x2) * (z - z2) / (z1 - z2) + x2) c = !c;
  }
  return c;
}
const centroid = pts => { let x = 0, z = 0; for (const p of pts) { x += p[0]; z += p[1]; } return [x / pts.length, z / pts.length]; };

// Swap this tile's OSM blocks for the campus buildings that stand in it (by floor point). Each physics footprint
// gets {pts, h, top, campus}; `campus` is the building (world.js draws it once, from its first footprint).
export function applyCampus(td) {
  const inTile = ([x, z]) => x >= td.x0 && x < td.x0 + 2000 && z >= td.z0 && z < td.z0 + 2000;
  const mine = CAMPUS.filter(b => inTile(b.floorAt));
  if (!mine.length || globalThis.process?.env?.NO_CAMPUS) return td.buildings;
  // an OSM block is replaced when its centre (or the `osm` point listed for it) falls inside a campus footprint
  const foot = mine.flatMap(b => b.phys || b.parts.map(partPts));
  const out = td.buildings.filter(b => {
    const c = centroid(b.pts);
    return !foot.some(p => inPoly(p, c[0], c[1])) && !mine.some(m => m.osm.some(([x, z]) => inPoly(b.pts, x, z)));
  });
  for (const b of mine) {
    b.floor = td.terrainAt(b.floorAt[0], b.floorAt[1]) + (b.dy || 0);
    const top = b.floor + Math.max(...b.parts.map(partTop));
    const polys = b.phys || b.parts.map(partPts);
    polys.forEach((pts, i) => out.push({ pts, h: top - b.floor, top, campus: i === 0 ? b : null, campusPart: true }));
  }
  return out;
}
