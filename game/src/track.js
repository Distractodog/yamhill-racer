// Invisible walls for challenge runs: the car must stay on the route's road/trail. The track is the route's centre
// line every ~4 m with the road's half-width there (tools/challenge_routes.py). Each physics step the car's four body
// corners are checked against that corridor (distance to the centre line, so curves get rounded walls); a corner past
// the edge pushes the car back and takes away the speed going into the wall. Walls go all the way up: no shortcuts
// through the air either. No rendering, so the headless test drives use the same code.

const EDGE = 0.3;            // a body corner may hang this far past the road edge (tyres right on the edge line)
const BOUNCE = 0.15;         // how much of the speed into the wall comes back out
const BACK = 10;             // you may roll this far behind the start line

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

  const cx = [0, 0, 0, 0], cz = [0, 0, 0, 0];
  return {
    get index() { return idx; },
    reset() { idx = 0; lastX = NaN; },
    // keep the car inside; returns how hard it hit (m/s into the wall), 0 if no contact
    constrain(car) {
      const p = car.pos, v = car.vel, q = car.quat;
      // follow progress along the route (a window around the last segment, so a route that passes near itself
      // can't snap to the wrong part); after a teleport, search everything
      if (!(Math.hypot(p.x - lastX, p.z - lastZ) < 30)) idx = nearestSeg(p.x, p.z, 0, n - 2)[0];
      else idx = nearestSeg(p.x, p.z, idx - 6, idx + 12)[0];
      lastX = p.x; lastZ = p.z;
      // body corners on the ground plane (car box half-size 0.8 × 1.85, centred 0.1 m back)
      const fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
      const rx = 1 - 2 * (q.y * q.y + q.z * q.z), rz = 2 * (q.x * q.z - q.w * q.y);
      let k = 0;
      const h = car.half, hx = h ? h.x : 0.8, hf = h ? h.front : 1.75, hb = h ? h.back : -1.95;   // bike: narrower
      for (const sx of [-hx, hx]) for (const sz of [hf, hb]) {
        cx[k] = p.x + rx * sx + fx * sz; cz[k] = p.z + rz * sx + fz * sz; k++;
      }
      let worst = 0, nx = 0, nz = 0;
      for (k = 0; k < 4; k++) {
        const [i] = nearestSeg(cx[k], cz[k], idx - 3, idx + 3);
        const [d2, t, px, pz] = onSeg(i, cx[k], cz[k]);
        const d = Math.sqrt(d2), lim = HW[i] + (HW[i + 1] - HW[i]) * t + EDGE;
        let over = d - lim;
        let ux = d > 1e-6 ? (cx[k] - px) / d : 0, uz = d > 1e-6 ? (cz[k] - pz) / d : 0;
        // start: behind the first point, the wall is a rounded cap BACK m behind the line
        if (i === 0 && t === 0) {
          const tx = X[1] - X[0], tz = Z[1] - Z[0], L = Math.hypot(tx, tz) || 1;
          const behind = -((cx[k] - X[0]) * tx + (cz[k] - Z[0]) * tz) / L - BACK;
          if (behind > over) { over = behind; ux = -tx / L; uz = -tz / L; }
        }
        if (over > worst) { worst = over; nx = ux; nz = uz; }
      }
      if (worst <= 0) return 0;
      p.x -= nx * worst; p.z -= nz * worst;
      const vn = v.x * nx + v.z * nz;                 // speed into the wall
      if (vn > 0) { v.x -= nx * vn * (1 + BOUNCE); v.z -= nz * vn * (1 + BOUNCE); }
      lastX = p.x; lastZ = p.z;
      return Math.max(0, vn);
    },
  };
}
