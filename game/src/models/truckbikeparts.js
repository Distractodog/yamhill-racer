// Geometry tools for the pickup and road bike. +z forward; all dimensions in metres.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function material(color, role) {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
  if (role) m.userData.cosmeticRole = role;
  return m;
}
export function mesh(parent, geometry, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, mat);
  m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
}
export function box(p, m, w, h, d, x, y, z, rx = 0) {
  const part = mesh(p, new THREE.BoxGeometry(w, h, d), m, x, y, z);
  part.rotation.x = rx; return part;
}
export function rod(p, m, a, b, r, segments = 6) {
  const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.sub(start);
  const part = mesh(p, new THREE.CylinderGeometry(r, r, delta.length(), segments), m);
  part.position.copy(start).addScaledVector(delta, .5);
  part.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()); return part;
}
// Cross sections [z, halfWidth, bottomY, topY, topHalfWidth], front to rear.
export function hull(p, mat, sections) {
  const rings = sections.map(([z, w, b, t, tw = w]) => [[-w,b,z],[w,b,z],[tw,t,z],[-tw,t,z]]), points = [];
  const tri = (a,b,c) => points.push(...a,...b,...c);
  for (let j = 1; j < rings.length; j++) for (let i = 0; i < 4; i++) {
    const a = rings[j-1][i], b = rings[j][i], c = rings[j][(i+1)%4], d = rings[j-1][(i+1)%4];
    tri(a,b,c); tri(a,c,d);
  }
  const a = rings[0], b = rings.at(-1);
  tri(a[0],a[1],a[2]); tri(a[0],a[2],a[3]); tri(b[0],b[2],b[1]); tri(b[0],b[3],b[2]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(points,3)); g.computeVertexNormals();
  return mesh(p, g, mat);
}
// Extrude an outline in the y/z plane along x; holes stay genuinely open.
export function sideShape(p, mat, outline, x, width) {
  const shape = new THREE.Shape();
  outline.forEach(([z,y], i) => i ? shape.lineTo(-z,y) : shape.moveTo(-z,y)); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, steps: 1 });
  // (shape x, shape y, depth) -> (depth, y, -shape x), a proper rotation.
  g.rotateY(Math.PI / 2); g.translate(x,0,0);
  return mesh(p,g,mat);
}
// Bake static components per paint role; fixed colours share a single vertex-colour draw call.
// THREE.Color(hex) converts sRGB to linear. Role materials keep uncoloured vertices so Garage
// recolouring cannot multiply the paint twice (or mistake white vertices for race-car trim).
export function batch(group) {
  const batches = new Map(), fixed = material('#ffffff'); fixed.vertexColors = true;
  for (const child of [...group.children]) if (child.isMesh) {
    child.updateMatrix();
    const g = (child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone()).applyMatrix4(child.matrix);
    g.deleteAttribute('uv');
    const role = child.material.userData.cosmeticRole, mat = role ? child.material : fixed;
    if (!role) {
      const c = child.material.color, colors = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i+1] = c.g; colors[i+2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    if (!batches.has(mat)) batches.set(mat, []);
    batches.get(mat).push(g); group.remove(child); child.geometry.dispose();
  }
  for (const [mat, parts] of batches) { mesh(group, mergeGeometries(parts), mat); parts.forEach(g => g.dispose()); }
}
export function lod(parent, near, far, distance = 45) {
  batch(near); batch(far);
  const level = new THREE.LOD(); level.addLevel(near, 0); level.addLevel(far, distance, .12);
  far.visible = false; parent.add(level); return level;
}
// Keep the two direct meshes first: cosmetics relies on spin.children[0] = tyre, [1] = rim.
// Small silhouette wheels stay at both distances; spokes/tread/bolts disappear at the LOD cutoff.
export function wheel(parent, tyre, rim, { x = 0, y, z, r, width, front, sport = false }) {
  const holder = new THREE.Group(); holder.position.set(x,y,z); parent.add(holder);
  const spin = new THREE.Group(); holder.add(spin);
  const profile = sport ? [[r*.45,-width/2],[r*.84,-width/2],[r,-width*.24],[r,width*.24],[r*.84,width/2],[r*.45,width/2]]
    : [[r*.45,-width/2],[r*.91,-width/2],[r,-width*.32],[r,width*.32],[r*.91,width/2],[r*.45,width/2]];
  const tyreGeo = new THREE.LatheGeometry(profile.map(([a,b]) => new THREE.Vector2(a,b)), 16).rotateZ(Math.PI/2);
  mesh(spin, tyreGeo, tyre);
  mesh(spin, new THREE.CylinderGeometry(r*.57,r*.57,width+.016,12).rotateZ(Math.PI/2), rim);
  return { holder, spin, restY: y, r, front };
}
