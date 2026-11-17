// Layered flat panels share the shell's triangles. Only the thin end-panel bands are
// split: no new skin tessellation, global vertex inflation or extra draw calls.
import * as THREE from 'three';
const EPS = 1e-7;
export const PANEL_SKIN_DEPTH = .024; // metres: authored 4 mm layers + the lit lens lift

export function panelTriangle(point, panels, weights) {
  for (const panel of panels || []) {
    const d = (point.z - panel.z) * panel.dir;
    if (d < -EPS || d > PANEL_SKIN_DEPTH) continue;
    for (const tri of panel.triangles) {
      const [a, b, c] = tri, ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - a[0], vy = c[1] - a[1];
      const det = ux * vy - uy * vx;
      if (Math.abs(det) < EPS) continue;
      const x = point.x - a[0], y = point.y - a[1], v = (x * vy - y * vx) / det, w = (ux * y - uy * x) / det;
      if (v >= -EPS && w >= -EPS && v + w <= 1 + EPS) { weights.set(1 - v - w, v, w); return tri; }
    }
  }
  return null;
}

// Split an existing triangle soup along projected shell edges. Keep uncovered fragments
// too (e.g. a lamp corner overhanging the cap). Attributes interpolate on the ORIGINAL
// triangle, preserving UVs and fixed/paint colours. Matrix maps mesh to body coordinates.
export function splitPanelGeometry(geometry, panels, matrix = new THREE.Matrix4()) {
  if (!panels?.length) return geometry;
  const names = Object.keys(geometry.attributes), sizes = names.map(n => geometry.attributes[n].itemSize);
  const output = names.map(() => []), pos = geometry.attributes.position, index = geometry.index;
  const p = new THREE.Vector3(), inv = matrix.clone().invert();
  let touched = false;
  const emit = polygon => {
    for (let j = 1; j + 1 < polygon.length; j++) {
      const points = [polygon[0], polygon[j], polygon[j + 1]], a = points[0].p, b = points[1].p, c = points[2].p;
      if (new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).lengthSq() < 1e-16) continue;
      for (const v of points) for (let k = 0; k < names.length; k++) {
        if (names[k] === 'position') output[k].push(...p.copy(v.p).applyMatrix4(inv).toArray());
        else output[k].push(...v.attrs[k]);
      }
    }
  };
  const cut = (polygon, a, b, sign) => {
    const yes = [], no = [], distance = v => {
      const d = sign * ((b[0] - a[0]) * (v.p.y - a[1]) - (b[1] - a[1]) * (v.p.x - a[0]));
      return Math.abs(d) < EPS ? 0 : d;
    };
    for (let i = 0; i < polygon.length; i++) {
      const u = polygon[i], v = polygon[(i + 1) % polygon.length], du = distance(u), dv = distance(v);
      if (du >= 0) yes.push(u);
      if (du <= 0) no.push(u);
      if ((du < 0 && dv > 0) || (du > 0 && dv < 0)) {
        const t = du / (du - dv), mid = { p: u.p.clone().lerp(v.p, t), attrs: u.attrs.map((attr, k) => attr.map((x, n) => x + (v.attrs[k][n] - x) * t)) };
        yes.push(mid); no.push(mid);
      }
    }
    return [yes, no];
  };
  for (let i = 0; i < (index?.count ?? pos.count); i += 3) {
    const polygon = [0, 1, 2].map(k => {
      const n = index ? index.getX(i + k) : i + k;
      return { p: new THREE.Vector3().fromBufferAttribute(pos, n).applyMatrix4(matrix),
        attrs: names.map((name, j) => Array.from({ length: sizes[j] }, (_, m) => geometry.attributes[name].getComponent(n, m))) };
    });
    const panel = panels.find(s => polygon.every(v => { const d = (v.p.z - s.z) * s.dir; return d >= -EPS && d <= PANEL_SKIN_DEPTH; })
      && Math.max(...polygon.map(v => v.p.z)) - Math.min(...polygon.map(v => v.p.z)) < EPS);
    if (!panel) { emit(polygon); continue; }
    touched = true;
    let remaining = [polygon];
    for (const [a, b, c] of panel.triangles) {
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (Math.abs(area) < EPS) continue;
      const next = [];
      for (let piece of remaining) {
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
          const [inside, outside] = cut(piece, u, v, Math.sign(area));
          if (outside.length >= 3) next.push(outside);
          piece = inside; if (piece.length < 3) break;
        }
        if (piece.length >= 3) emit(piece);
      }
      remaining = next;
    }
    remaining.forEach(emit);
  }
  if (!touched) return geometry;
  const result = new THREE.BufferGeometry();
  names.forEach((name, i) => result.setAttribute(name, new THREE.Float32BufferAttribute(output[i], sizes[i])));
  result.computeVertexNormals();
  geometry.dispose(); return result;
}
