// Entrance at the foot of the campus driveway, just uphill of the main-road junction.
// Both leaves are fixed open, parallel to the driveway; the 16 m opening stays clear.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
export const CAMPUS_GATE = { x: 684, z: 283, yaw: -0.70, opening: 16 };
export function buildCampusGateGeometry(terrainAt) {
  const { x, z, yaw, opening } = CAMPUS_GATE, parts = [];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  function box(u, v, y, w, h, depth, hex) {
    const gx = x + u * c + v * s, gz = z - u * s + v * c;
    const g = new THREE.BoxGeometry(w, h, depth).toNonIndexed();
    g.rotateY(yaw); g.translate(gx, terrainAt(gx, gz) + y, gz);
    const color = new THREE.Color(hex), colors = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.deleteAttribute('uv'); parts.push(g);
  }
  for (const side of [-1, 1]) {
    const u = side * (opening / 2 + 0.6);
    box(u, 0, 1.6, 1.2, 3.2, 1.2, '#b5aa91');
    box(u, 0, 3.25, 1.5, 0.25, 1.5, '#ddd4bf');
    // Open leaves extend uphill from the hinge, entirely outside the drivable opening.
    for (const y of [0.65, 2.2]) box(u, 3.5, y, 0.12, 0.14, 7, '#28312c');
    for (let v = 0.2; v <= 7; v += 0.5) box(u, v, 1.45, 0.10, 1.9, 0.10, '#28312c');
  }
  const geometry = mergeGeometries(parts); parts.forEach(g => g.dispose());
  return geometry;
}
