// Route progress and corridor queries only. Solid, finite-height contacts live in racebarriers.js.

export function makeTrack(points) {
  const n = points.length;
  const X = new Float64Array(n), Z = new Float64Array(n), HW = new Float64Array(n);
  points.forEach(([x, z, hw], i) => { X[i] = x; Z[i] = z; HW[i] = hw; });
  let idx = 0, lastX = NaN, lastZ = NaN;

  // nearest point on segment i to (x, z): [distance², t, px, pz]
  function onSeg(i, x, z) {
    const ax = X[i], az = Z[i], ex = X[i + 1] - ax, ez = Z[i + 1] - az, L2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t, pz = az + ez * t;
    return [(x - px) ** 2 + (z - pz) ** 2, t, px, pz];
  }
  function nearestSeg(x, z, lo, hi) {
    let best = lo, bd = Infinity;
    for (let i = Math.max(0, lo); i <= Math.min(n - 2, hi); i++) { const d = onSeg(i, x, z)[0]; if (d < bd) { bd = d; best = i; } }
    return [best, bd];
  }

  return {
    get index() { return idx; },
    get endWidth() { return HW[n - 1]; },
    reset() { idx = 0; lastX = NaN; },
    contains(x, z) {
      for (let i = 0; i < n - 1; i++) {
        const [d2, t] = onSeg(i, x, z);
        if (Math.sqrt(d2) <= HW[i] + (HW[i + 1] - HW[i]) * t) return true;
      }
      return false;
    },
    update(x, z) {
      idx = Math.hypot(x - lastX, z - lastZ) < 30
        ? nearestSeg(x, z, idx - 6, idx + 12)[0] : nearestSeg(x, z, 0, n - 2)[0];
      lastX = x; lastZ = z;
    },
    outside(car) {
      const h = car.half || { x: 0.8, front: 1.75, back: -1.95 };
      const q = car.quat || { x: 0, y: 0, z: 0, w: 1 };
      const yaw = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
      const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = fz, rz = -fx;
      for (let i = Math.max(0, idx - 8); i <= Math.min(n - 2, idx + 12); i++) {
        const [d2, t] = onSeg(i, car.pos.x, car.pos.z);
        if (Math.sqrt(d2) <= HW[i] + (HW[i+1] - HW[i]) * t) return false;
      }
      // Distance from each tapered corridor segment to the oriented body rectangle. Test changes of closest
      // rectangle feature and the stationary point beside each corner; this also catches a parked parallel car
      // just beyond the wall, which a bounding circle would incorrectly keep in the race forever.
      for (let i = Math.max(0, idx - 8); i <= Math.min(n - 2, idx + 12); i++) {
        const ax = (X[i]-car.pos.x)*rx + (Z[i]-car.pos.z)*rz;
        const az = (X[i]-car.pos.x)*fx + (Z[i]-car.pos.z)*fz;
        const dx = (X[i+1]-X[i])*rx + (Z[i+1]-Z[i])*rz;
        const dz = (X[i+1]-X[i])*fx + (Z[i+1]-Z[i])*fz;
        const l2 = dx*dx + dz*dz, dh = HW[i+1]-HW[i];
        const candidates = [0,1];
        if (Math.abs(dx)>1e-9) candidates.push((-h.x-ax)/dx, (h.x-ax)/dx);
        if (Math.abs(dz)>1e-9) candidates.push((h.back-az)/dz, (h.front-az)/dz);
        if (l2>1e-9 && l2>dh*dh) for (const x of [-h.x,h.x]) for (const z of [h.back,h.front]) {
          const along = ((x-ax)*dx+(z-az)*dz)/l2;
          const across = Math.abs((x-ax)*dz-(z-az)*dx)/Math.sqrt(l2);
          candidates.push(along + dh*across/Math.sqrt(l2*(l2-dh*dh)));
        }
        for (const u of candidates) if (u>=0 && u<=1) {
          const x=ax+dx*u, z=az+dz*u;
          const distance=Math.hypot(Math.max(0,Math.abs(x)-h.x), Math.max(0,h.back-z,z-h.front));
          if (distance <= HW[i]+dh*u+0.16) return false;
        }
      }
      return true;
    },
  };
}
