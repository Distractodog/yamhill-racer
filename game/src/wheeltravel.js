// Drawing only. wheelArch is a tyre-top ceiling (number or per-wheel array), in the
// UNLEANED BODY frame: mesh.userData.bodyPivot for cars, wheel.holder.parent (body)
// for bikes. Do not supply hub height, suspension travel, or model-root/world height.
// Fallbacks use the first model stance; cosmetic-* groups and userData.cosmetic add-ons
// never define an arch. Changing paint/livery therefore does not invalidate the cache.
import * as THREE from 'three';

const cache = new WeakMap();
const matrix = new THREE.Matrix4();
const inverse = new THREE.Matrix4(), rotation = new THREE.Matrix4();

// Clip a triangle to the actual tyre's rectangular footprint before measuring its underside.
function clip(poly, axis, edge, sign) {
  const result = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const da = (a[axis] - edge) * sign, db = (b[axis] - edge) * sign;
    if (da >= 0) result.push(a);
    if ((da < 0) !== (db < 0)) result.push(a.clone().lerp(b, da / (da - db)));
  }
  return result;
}
function wheelData(model, index) {
  let wheels = cache.get(model);
  if (!wheels) { wheels = []; cache.set(model, wheels); }
  if (wheels[index]) return wheels[index];
  const ud = model.userData, w = ud.wheels[index], body = ud.bodyPivot || w.holder.parent;
  model.updateWorldMatrix(true, true);
  // The model's parked stance includes the lifted truck's suspension offset. restY is the
  // suspension mount datum, NOT the parked hub height.
  const restY = w.holder.position.y;
  const tyre = w.spin.children.find(o => o.isMesh);
  tyre.geometry.computeBoundingBox();
  // Rims/spokes can be a little wider than the rubber; include them when reserving
  // clearance under a rolling car body, just as remote geometry batching does.
  const wheelBox = new THREE.Box3();
  for (const part of w.spin.children) if (part.isMesh && part.visible && !part.userData.cosmetic) {
    part.geometry.computeBoundingBox(); part.updateMatrix();
    wheelBox.union(part.geometry.boundingBox.clone().applyMatrix4(part.matrix));
  }
  const halfWidth = Math.max(Math.abs(wheelBox.min.x), Math.abs(wheelBox.max.x));
  const bodyInverse = body.matrixWorld.clone().invert(), holders = new Set(ud.wheels.map(g => g.holder));
  const footprint = tyre.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(bodyInverse, tyre.matrixWorld));
  const restTop = footprint.max.y;
  let underside = Infinity;
  body.traverse(o => {
    if (!o.isMesh) return;
    for (let p = o; p && p !== model; p = p.parent) {
      if (holders.has(p) || p === ud.rider || p === ud.bars || p.name.startsWith('cosmetic-') || p.userData.cosmetic) return;
    }
    matrix.multiplyMatrices(bodyInverse, o.matrixWorld);
    const positions = o.geometry.attributes.position, indices = o.geometry.index;
    const count = indices ? indices.count : positions.count;
    for (let j = 0; j < count; j += 3) {
      let polygon = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(positions, indices ? indices.getX(j + k) : j + k).applyMatrix4(matrix));
      // A downward-facing triangle is an underside; a tank/bonnet top or a vertical side is not.
      const [a, b, c] = polygon;
      const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
      if (ny >= -1e-9) continue;
      polygon = clip(polygon, 'x', footprint.min.x, 1);
      polygon = clip(polygon, 'x', footprint.max.x, -1);
      polygon = clip(polygon, 'z', footprint.min.z, 1);
      polygon = clip(polygon, 'z', footprint.max.z, -1);
      if (!polygon.some(v => v.y > restTop + 1e-6)) continue;
      polygon = clip(polygon, 'y', restTop, 1);
      for (const v of polygon) underside = Math.min(underside, v.y);
    }
  });
  // An open wheel with no overhead skin retains a small amount of upward visual travel.
  return wheels[index] = { body, restY, halfWidth, arch: Number.isFinite(underside) ? underside : restTop + .08 };
}

export function wheelArch(model, index) {
  const explicit = model.userData.wheelArch;
  const value = Array.isArray(explicit) ? explicit[index] : explicit;
  return Number.isFinite(value) ? value : wheelData(model, index).arch;
}

export function drawnWheelY(model, index, requestedY) {
  const w = model.userData.wheels[index], data = wheelData(model, index);
  // Convert the body-frame ceiling into hub travel in the holder parent's frame. For bikes
  // these frames coincide; car body roll/brake dive uses the inverse body matrix, including
  // its translation, and the tyre AABB's support along the body up axis.
  if (data.body === w.holder.parent) inverse.identity();
  else { data.body.updateMatrix(); inverse.copy(data.body.matrix).invert(); }
  rotation.makeRotationFromQuaternion(w.holder.quaternion).premultiply(inverse);
  const e = inverse.elements, r = rotation.elements;
  const support = Math.abs(r[1]) * data.halfWidth + Math.abs(r[5]) * w.r + Math.abs(r[9]) * w.r;
  const limit = (wheelArch(model, index) - support - e[1] * w.holder.position.x - e[9] * w.holder.position.z - e[13]) / e[5];
  // Never spend the parked clearance on easing: even a zero-clearance rest pose stays exact.
  const ease = Math.min(.02, Math.max(0, (limit - data.restY) / 2));
  const start = limit - ease;
  if (requestedY <= start) return requestedY;
  return ease > 1e-9 ? start + ease * (1 - Math.exp(-(requestedY - start) / ease)) : Math.min(requestedY, limit);
}
