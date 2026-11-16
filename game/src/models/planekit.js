// Low-poly parts for the propeller aircraft (propplane.js, stuntplane.js). Model space: +x = left wing, +y up,
// +z forward (nose), metres; the origin is the centre of mass the physics (jet.js airframe) flies.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const OCT = Math.tan(Math.PI / 8);     // a regular octagon's flat side, as a fraction of its half height

export function material(color, role = null, extra = {}) {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true, ...extra });
  if (role) m.userData.cosmeticRole = role;
  return m;
}
export function put(parent, geometry, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, mat); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
}
export function pivot(parent, x, y, z) { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; }
// Merge a group's static meshes by material (fewer draw calls); `keep` stay separate (the canopy the wreck hides).
export function batch(group, keep = new Set()) {
  const batches = new Map();
  for (const child of [...group.children]) {
    if (!child.isMesh || keep.has(child) || child.material.transparent) continue;
    child.updateMatrix();
    const g = (child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone()).applyMatrix4(child.matrix);
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!batches.has(child.material)) batches.set(child.material, []);
    batches.get(child.material).push(g); child.geometry.dispose(); group.remove(child);
  }
  for (const [mat, parts] of batches) { put(group, mergeGeometries(parts), mat); parts.forEach(p => p.dispose()); }
}

// A closed eight-sided tube through sections [z, halfWidth, yBottom, yTop] (nose to tail). k = how much of the
// height the flat vertical sides take (a regular octagon by default; larger = boxier). A ribbon() with the same
// sections and k lies flush on those sides.
export function loft(sections, k = OCT) {
  const P = [[1, -k], [1, k], [k, 1], [-k, 1], [-1, k], [-1, -k], [-k, -1], [k, -1]], n = P.length;
  const rings = sections.map(([z, w, b, t]) => P.map(([px, py]) => [w * px, (b + t) / 2 + (t - b) / 2 * py, z]));
  const pos = [], tri = (a, b, c) => pos.push(...a, ...b, ...c);
  for (let j = 1; j < rings.length; j++) for (let i = 0; i < n; i++) {
    const a = rings[j - 1][i], b = rings[j - 1][(i + 1) % n], c = rings[j][(i + 1) % n], d = rings[j][i];
    tri(a, d, c); tri(a, c, b);
  }
  const cap = (r, z, flip) => {
    const c = [0, r.reduce((s, p) => s + p[1], 0) / n, z];
    for (let i = 0; i < n; i++) flip ? tri(c, r[(i + 1) % n], r[i]) : tri(c, r[i], r[(i + 1) % n]);
  };
  cap(rings[0], sections[0][0], false); cap(rings.at(-1), sections.at(-1)[0], true);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// A paint band on both flat sides of a loft(): f = -1..1 across the side face (0 = middle), h = half height (m).
export function ribbon(sections, f, h, from = 0, to = sections.length - 1, k = OCT) {
  const pos = [];
  for (const s of [1, -1]) for (let j = from + 1; j <= to; j++) {
    const p = ([z, w, b, t]) => [s * (w + 0.012), (b + t) / 2 + f * k * (t - b) / 2, z];
    const [x0, y0, z0] = p(sections[j - 1]), [x1, y1, z1] = p(sections[j]);
    const q = [[x0, y0 - h, z0], [x0, y0 + h, z0], [x1, y1 + h, z1], [x1, y1 - h, z1]];
    if (s > 0) pos.push(...q[0], ...q[2], ...q[1], ...q[0], ...q[3], ...q[2]);
    else pos.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// A flat panel from a planform [[x, z], …] with a thickness, centred on y = 0 (wings, tailplanes, stripes on them)
export function plate(pts, thick) {
  const sh = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z)));
  return new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, thick / 2, 0);
}
// A vertical panel from a side outline [[z, y], …] (fins), centred on x = 0
export function fin(pts, thick) {
  const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
  return new THREE.ExtrudeGeometry(sh, { depth: thick, bevelEnabled: false }).rotateY(-Math.PI / 2).translate(thick / 2, 0, 0);
}
// mirror left ↔ right, keeping the faces facing out
export function mirrorX(g) {
  g = (g.index ? g.toNonIndexed() : g.clone()).scale(-1, 1, 1);
  for (const a of Object.values(g.attributes)) for (let i = 0; i < a.count; i += 3) for (let c = 0; c < a.itemSize; c++) {
    const t = a.getComponent(i + 1, c); a.setComponent(i + 1, c, a.getComponent(i + 2, c)); a.setComponent(i + 2, c, t);
  }
  g.computeVertexNormals();
  return g;
}
// a thin strut from a to b (low-poly, 4 sides)
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
export function rod(parent, mat, a, b, r = 0.04, sides = 4) {
  _a.set(...a); _b.set(...b);
  const len = _a.distanceTo(_b), m = put(parent, new THREE.CylinderGeometry(r, r, len, sides), mat);
  m.position.copy(_a).add(_b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(_up, _b.sub(_a).normalize());
  return m;
}
// a wing half with dihedral: plate() pts for the left (+x) side, mirrored for the right; returns both meshes
export function wingPair(parent, mat, pts, thick, y, dihedral) {
  const g = plate(pts, thick);
  const left = put(parent, g, mat, 0, y, 0); left.rotation.z = dihedral;
  const right = put(parent, mirrorX(g), mat, 0, y, 0); right.rotation.z = -dihedral;
  return [left, right];
}

// Wheel for physics wheel i: holder (steers) → spin (rolls; children[0] = tyre for the Garage paint) + optional pant.
export function wheel(parent, tyre, hubMat, x, y, z, r, width, front) {
  const holder = pivot(parent, x, y, z), spin = pivot(holder, 0, 0, 0);
  put(spin, new THREE.CylinderGeometry(r, r, width, 10).rotateZ(Math.PI / 2), tyre);
  put(spin, new THREE.CylinderGeometry(r * 0.45, r * 0.45, width + 0.03, 6).rotateZ(Math.PI / 2), hubMat);
  return { holder, spin, r, front, leg: holder };
}
// teardrop wheel fairing around a wheel holder (non-rolling)
export function pant(holder, mat, r, width) {
  return put(holder, loft([[r * 1.5, width * 0.25, -r * 0.1, r * 0.25], [r * 0.6, width * 0.75, -r * 0.35, r * 0.95],
    [-r * 0.5, width * 0.75, -r * 0.3, r * 0.95], [-r * 2.1, width * 0.2, r * 0.2, r * 0.55]]), mat);
}

// Propeller: hub group (spins about z) with the blades in their own group (hidden when blurred) and a spinner, plus a
// see-through disc that fades in with speed. spin(v, dt) keeps the turn rate per model (yours and other players').
export function propeller(parent, { x = 0, y = 0, z = 0, radius = 1, blades = 2, chord = 0.14, blade, tip, spinner, spinnerR = 0.18, spinnerL = 0.4, idle = 14, max = 95 }) {
  const hub = pivot(parent, x, y, z), set = pivot(hub, 0, 0, 0);
  for (let i = 0; i < blades; i++) {
    const arm = pivot(set, 0, 0, 0); arm.rotation.z = i / blades * Math.PI * 2;
    const b = put(arm, new THREE.BoxGeometry(chord, radius * 0.86, 0.035), blade, 0, radius * 0.47, 0); b.rotation.y = 0.35;
    const t = put(arm, new THREE.BoxGeometry(chord * 0.95, radius * 0.12, 0.04), tip, 0, radius * 0.94, 0); t.rotation.y = 0.35;
  }
  put(hub, new THREE.ConeGeometry(spinnerR, spinnerL, 8).rotateX(Math.PI / 2), spinner, 0, 0, spinnerL / 2);
  const discMat = new THREE.MeshBasicMaterial({ color: 0x30343a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 20), discMat); disc.position.set(x, y, z + 0.02);
  disc.visible = false; disc.castShadow = false; disc.name = 'prop-disc'; parent.add(disc);
  let w = 0;
  const spin = (v, dt) => {
    const want = v.mode === 'crashed' ? 0 : idle + (v.throttle || 0) * (max - idle);
    w += (want - w) * Math.min(1, dt * (want > w ? 2.5 : 1.2));
    hub.rotation.z = (hub.rotation.z - w * dt) % (Math.PI * 2);
    const blur = Math.min(1, Math.max(0, (w - 30) / 45));
    discMat.opacity = blur * 0.38; disc.visible = blur > 0.02; set.visible = blur < 0.7;
  };
  return { hub, blades: set, disc, spin };
}
