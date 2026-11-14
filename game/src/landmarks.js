// Hand-made landmarks. Footprints are the OSM outlines already in the tiles, so the
// collision plan does not move. The Sheridan grain elevator is not here: it was
// demolished, and the research says not to put it back as present-day scenery.
// Hotel Oregon is four storeys (eaves height was not published; 3.2 m a storey).
// The Aviation Building roof is the contractor's 39.62 m peak. The Space Museum
// height was not published; 22 m keeps it a hall and shorter than that peak.
import { partPts, partTop } from './campus.js';

const GLASS = [0.55, 0.66, 0.74];
export const LANDMARKS = [
{ name: 'Hotel Oregon', osm: [[19386.4, -11054.47]], floorAt: [19386.4, -11054.47], dy: 0.2,
    parts: [{ pts: [[19387.31, -11064.78], [19396.58, -11064.78], [19396.79, -11039.06], [19375.61, -11038.96], [19375.71, -11064.78]], h: 12.8, wall: [0.62, 0.58, 0.52], wallTop: { y: 3.2, color: [0.62, 0.32, 0.26] },
      roof: { type: 'flat', color: [0.38, 0.30, 0.28], parapet: 0.7 },
      win: { rows: 4, sh: 3.0, sill: 0.9, w: 1.3, h: 1.7, every: 3.2, color: GLASS, margin: 1.4 },
      porch: { y: 3.1, depth: 1.3, drop: 0.15, color: [0.62, 0.28, 0.22], post: [0.55, 0.50, 0.46], every: 8 } }] },
{ name: 'Third Street', osm: [[19246.6, -11061.74]], floorAt: [19246.6, -11061.74], dy: 0.15,
    parts: [{ pts: [[19231.11, -11038.98], [19231.14, -11070.9], [19231.15, -11078.51], [19252.0, -11078.48], [19251.99, -11074.02], [19252.07, -11061.8], [19256.28, -11061.8], [19256.49, -11057.06], [19251.86, -11056.95], [19251.95, -11038.95]], h: 7.5, wall: [0.62, 0.34, 0.28],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 2, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 } }] },
{ name: 'Third Street', osm: [[19259.36, -11076.3]], floorAt: [19259.36, -11076.3], dy: 0.15,
    parts: [{ pts: [[19252.0, -11078.48], [19266.72, -11078.66], [19266.72, -11074.02], [19251.99, -11074.02]], h: 5.5, wall: [0.55, 0.32, 0.3],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.25, 0.36, 0.3], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19297.58, -11057.95]], floorAt: [19297.58, -11057.95], dy: 0.15,
    parts: [{ pts: [[19283.59, -11070.44], [19283.57, -11038.91], [19310.4, -11038.89], [19310.43, -11064.51], [19298.75, -11064.52], [19298.75, -11070.42]], h: 5.5, wall: [0.68, 0.42, 0.32],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 } }] },
{ name: 'Third Street', osm: [[19314.56, -11056.8]], floorAt: [19314.56, -11056.8], dy: 0.15,
    parts: [{ pts: [[19310.4, -11038.89], [19310.43, -11064.51], [19310.51, -11070.81], [19320.84, -11070.81], [19320.63, -11038.99]], h: 5.5, wall: [0.48, 0.3, 0.28],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.32, 0.28, 0.38], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19327.24, -11054.93]], floorAt: [19327.24, -11054.93], dy: 0.15,
    parts: [{ pts: [[19320.84, -11070.81], [19320.63, -11038.99], [19333.69, -11039.1], [19333.8, -11070.81]], h: 5.5, wall: [0.72, 0.48, 0.36],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.7, 0.32, 0.24], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19340.49, -11054.98]], floorAt: [19340.49, -11054.98], dy: 0.15,
    parts: [{ pts: [[19333.69, -11039.1], [19333.8, -11070.81], [19347.18, -11070.91], [19347.28, -11039.1]], h: 5.5, wall: [0.62, 0.34, 0.28],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.25, 0.36, 0.3], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19352.39, -11054.98]], floorAt: [19352.39, -11054.98], dy: 0.15,
    parts: [{ pts: [[19347.18, -11070.91], [19347.28, -11039.1], [19357.71, -11039.1], [19357.4, -11070.81]], h: 5.5, wall: [0.55, 0.32, 0.3],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.55, 0.42, 0.28], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19387.98, -11069.31]], floorAt: [19387.98, -11069.31], dy: 0.15,
    parts: [{ pts: [[19375.71, -11076.27], [19396.64, -11076.15], [19396.68, -11067.84], [19396.58, -11064.78], [19387.31, -11064.78], [19387.2, -11067.62], [19375.71, -11067.72]], h: 5.5, wall: [0.68, 0.42, 0.32],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 } }] },
{ name: 'Third Street', osm: [[19402.86, -11055.72]], floorAt: [19402.86, -11055.72], dy: 0.15,
    parts: [{ pts: [[19412.28, -11067.72], [19396.68, -11067.84], [19396.58, -11064.78], [19396.79, -11039.06], [19411.96, -11039.18]], h: 5.5, wall: [0.48, 0.3, 0.28],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.7, 0.32, 0.24], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19420.69, -11059.5]], floorAt: [19420.69, -11059.5], dy: 0.15,
    parts: [{ pts: [[19412.27, -11070.47], [19412.28, -11067.72], [19411.96, -11039.18], [19429.45, -11039.18], [19429.35, -11064.78], [19424.71, -11064.78], [19424.81, -11070.37]], h: 5.5, wall: [0.72, 0.48, 0.36],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 } }] },
{ name: 'Third Street', osm: [[19437.06, -11055.7]], floorAt: [19437.06, -11055.7], dy: 0.15,
    parts: [{ pts: [[19429.45, -11039.18], [19429.35, -11064.78], [19429.35, -11067.62], [19448.52, -11067.84], [19448.63, -11039.06]], h: 5.5, wall: [0.62, 0.34, 0.28],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.55, 0.42, 0.28], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19475.62, -11055.51]], floorAt: [19475.62, -11055.51], dy: 0.15,
    parts: [{ pts: [[19484.66, -11071.2], [19484.45, -11039.91], [19466.75, -11039.81], [19466.64, -11071.1]], h: 5.5, wall: [0.55, 0.32, 0.3],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.32, 0.28, 0.38], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19492.33, -11058.75]], floorAt: [19492.33, -11058.75], dy: 0.15,
    parts: [{ pts: [[19484.66, -11071.2], [19485.61, -11071.2], [19503.42, -11071.2], [19503.52, -11040.22], [19484.45, -11039.91]], h: 5.5, wall: [0.68, 0.42, 0.32],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.7, 0.32, 0.24], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Third Street', osm: [[19515.09, -11069.06]], floorAt: [19515.09, -11069.06], dy: 0.15,
    parts: [{ pts: [[19503.52, -11101.76], [19503.42, -11071.2], [19503.52, -11040.22], [19521.96, -11040.02], [19521.96, -11043.61], [19522.06, -11070.78], [19522.11, -11083.21], [19522.17, -11101.66]], h: 7.5, wall: [0.48, 0.3, 0.28],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 2, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 } }] },
{ name: 'Third Street', osm: [[19531.23, -11057.24]], floorAt: [19531.23, -11057.24], dy: 0.15,
    parts: [{ pts: [[19540.5, -11070.99], [19522.06, -11070.78], [19521.96, -11043.61], [19540.4, -11043.56]], h: 5.5, wall: [0.72, 0.48, 0.36],
      roof: { type: 'flat', color: [0.40, 0.36, 0.34], parapet: 0.45 },
      win: { rows: 1, sh: 3.0, sill: 0.9, w: 1.4, h: 1.6, every: 3.6, color: GLASS, margin: 1.2 },
      porch: { y: 2.7, depth: 1.2, drop: 0.12, color: [0.55, 0.42, 0.28], post: [0.45, 0.40, 0.36], every: 7 } }] },
{ name: 'Aviation Building', osm: [[23234.3, -10388.63]], floorAt: [23234.3, -10388.63], dy: 0.3,
    parts: [{ pts: [[23143.16, -10407.07], [23168.43, -10406.99], [23168.55, -10443.92], [23282.91, -10443.56], [23282.8, -10406.73], [23296.77, -10406.68], [23307.1, -10406.65], [23307.04, -10386.52], [23306.97, -10365.93], [23297.16, -10365.96], [23282.67, -10366.01], [23282.61, -10346.49], [23168.24, -10346.86], [23168.3, -10365.63], [23143.03, -10365.71], [23143.1, -10387.36]], h: 39.62, wall: [0.76, 0.74, 0.70],
      roof: { type: 'flat', color: [0.62, 0.64, 0.66], parapet: 0.8 },
      win: { rows: 3, sh: 11, sill: 4.0, w: 7, h: 6, every: 18, color: GLASS, margin: 8 } }] },
{ name: 'Space Museum', osm: [[23543.36, -10388.31]], floorAt: [23543.36, -10388.31], dy: 0.3,
    parts: [{ pts: [[23501.63, -10406.49], [23501.7, -10443.21], [23616.33, -10443.0], [23616.26, -10406.38], [23640.46, -10406.34], [23640.39, -10365.37], [23616.19, -10365.42], [23616.15, -10345.85], [23501.52, -10346.06], [23501.56, -10365.61], [23484.69, -10365.63], [23476.34, -10365.65], [23476.38, -10386.5], [23476.41, -10406.55], [23484.43, -10406.53]], h: 22, wall: [0.78, 0.78, 0.76],
      roof: { type: 'flat', color: [0.58, 0.60, 0.62], parapet: 0.6 },
      win: { rows: 2, sh: 8, sill: 3.5, w: 6, h: 4.5, every: 16, color: GLASS, margin: 6 } }] },
{ name: 'Sheridan City Hall', osm: [[3551.42, 1591.87]], floorAt: [3551.42, 1591.87], dy: 0.2,
    parts: [{ pts: [[3540.59, 1583.39], [3562.5, 1583.86], [3562.44, 1586.6], [3565.6, 1586.67], [3565.44, 1594.04], [3562.28, 1593.98], [3562.22, 1596.8], [3553.44, 1596.62], [3553.37, 1600.1], [3548.31, 1599.99], [3548.41, 1595.78], [3527.27, 1595.32], [3527.46, 1586.35], [3540.52, 1586.63]], h: 3.6, wall: [0.78, 0.78, 0.75],
      roof: { type: 'flat', color: [0.42, 0.16, 0.20], parapet: 0.45, trim: [0.38, 0.14, 0.18] },
      win: { rows: 1, sh: 3.2, sill: 1.0, w: 1.2, h: 1.5, every: 3.4, color: GLASS, margin: 1.4 } }] },
];

const centroid = pts => { let x = 0, z = 0; for (const p of pts) { x += p[0]; z += p[1]; } return [x / pts.length, z / pts.length]; };

// Replace the OSM block under each landmark, the way applyCampus does, matched by centre.
export function applyLandmarks(td) {
  const inTile = ([x, z]) => x >= td.x0 && x < td.x0 + 2000 && z >= td.z0 && z < td.z0 + 2000;
  const mine = LANDMARKS.filter(b => inTile(b.floorAt));
  if (!mine.length) return td.buildings;
  const out = td.buildings.filter(b => {
    if (!b.pts || b.pts.length < 3) return true;
    const c = centroid(b.pts);
    return !mine.some(m => Math.hypot(c[0] - m.osm[0][0], c[1] - m.osm[0][1]) < 1.5);
  });
  for (const b of mine) {
    b.floor = td.terrainAt(b.floorAt[0], b.floorAt[1]) + (b.dy || 0);
    const top = b.floor + Math.max(...b.parts.map(partTop));
    const polys = b.parts.map(partPts);
    polys.forEach((pts, i) => out.push({ pts, h: top - b.floor, top, roofBuilding: b, landmark: i === 0 ? b : null, landmarkPart: true }));
  }
  return out;
}
