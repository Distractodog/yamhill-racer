// Drawing only. wheelArch is the tyre-top ceiling in the wheel holder parent's coordinates
// (one number, or one number per wheel). Models with cut-out arches should supply it explicitly.
import * as THREE from 'three';

const cache = new WeakMap();
const point = new THREE.Vector3(), matrix = new THREE.Matrix4();

export function wheelArch(model, index) {
  const explicit = model.userData.wheelArch;
  const value = Array.isArray(explicit) ? explicit[index] : explicit;
  if (Number.isFinite(value)) return value;
  let arches = cache.get(model);
  if (!arches) {
    // Inspect triangles, rather than a merged body's bounding box (which includes the roof/rider).
    // Only surfaces over the tyre footprint can define an arch. Thin suspension arms below the
    // hub are ignored; an open-wheel racer gets a small travel allowance over its model stance.
    model.updateWorldMatrix(true, true);
    const ud = model.userData, holders = new Set(ud.wheels.map(w => w.holder));
    arches = ud.wheels.map(w => {
      const body = ud.bodyPivot || w.holder.parent;
      const parentInverse = body.matrixWorld.clone().invert();
      const x = w.holder.position.x, z = w.holder.position.z;
      const rest = w.restY ?? w.holder.position.y;
      let top = -Infinity;
      body.traverse(o => {
        if (!o.isMesh) return;
        for (let p = o; p && p !== model; p = p.parent) {
          if (holders.has(p) || p === ud.rider || p === ud.bars) return;
        }
        matrix.multiplyMatrices(parentInverse, o.matrixWorld);
        const positions = o.geometry.attributes.position, indices = o.geometry.index;
        const count = indices ? indices.count : positions.count;
        for (let j = 0; j < count; j += 3) {
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxY = -Infinity;
          for (let k = 0; k < 3; k++) {
            point.fromBufferAttribute(positions, indices ? indices.getX(j + k) : j + k).applyMatrix4(matrix);
            minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
            minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z); maxY = Math.max(maxY, point.y);
          }
          if (minX <= x + .08 && maxX >= x - .08 && minZ <= z + w.r && maxZ >= z - w.r && maxY > rest + .12) top = Math.max(top, maxY);
        }
      });
      return Number.isFinite(top) ? top - .02 : rest + w.r + .08;
    });
    cache.set(model, arches);
  }
  return arches[index];
}

export function drawnWheelY(model, index, requestedY) {
  const ud = model.userData, w = ud.wheels[index];
  let ceiling = wheelArch(model, index);
  // Car wheels are siblings of the leaning body. Reserve clearance for its roll and brake dive.
  // Bike wheels share the body's parent, so their arch and tyre lean together.
  if (ud.bodyPivot && w.holder.parent === model) {
    const b = ud.bodyPivot;
    ceiling = ceiling * Math.cos(b.rotation.x) * Math.cos(b.rotation.z) + b.position.y
      - Math.abs(Math.sin(b.rotation.z)) * (Math.abs(w.holder.position.x) + .25)
      - Math.abs(Math.sin(b.rotation.x)) * (Math.abs(w.holder.position.z) + w.r);
  }
  const limit = ceiling - w.r, ease = .06;
  const start = limit - ease;
  // C1 soft stop: unchanged below the last 6 cm, approaches the ceiling without overshoot.
  return requestedY <= start ? requestedY : start + ease * (1 - Math.exp(-(requestedY - start) / ease));
}
