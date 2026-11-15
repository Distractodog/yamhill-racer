// Shared taper geometry contract for data.js and roads.js. s is metres along the written strip.
// Constant-width ranges only mark a lane already covered by a parallel ramp: do not pave it twice.
export function rampExtraWidth(widen, s, side) {
  let width = 0;
  for (const [sign, s0, s1, w0, w1] of widen || []) {
    if (sign !== side || w0 === w1 || s < s0 - 1e-6 || s > s1 + 1e-6 || s1 <= s0) continue;
    const t = Math.max(0, Math.min(1, (s - s0) / (s1 - s0)));
    width = Math.max(width, w0 + (w1 - w0) * t);
  }
  return width;
}

// roads.js should use these side widths per sample; far meshes must retain taper boundary samples.
export function roadHalfWidth(r, i, side) {
  return r.hw + rampExtraWidth(r.widen, r.s[i], side);
}

export function roadEdge(r, i, side, extra = 0, lift = 0) {
  const off = side * (roadHalfWidth(r, i, side) + extra);
  return [r.x[i] + r.lx[i] * off, r.z[i] + r.lz[i] * off, r.y[i] + r.c[i] * off + lift];
}

// Height inside a rendered triangle; vertices are [x,z,y]. The strip quad is split L0,R0,R1 / L0,R1,L1.
export function triangleHeight(x, z, A, B, C) {
  const ux = B[0] - A[0], uz = B[1] - A[1], vx = C[0] - A[0], vz = C[1] - A[1];
  const det = ux * vz - uz * vx;
  if (Math.abs(det) < 1e-9) return -Infinity;
  const px = x - A[0], pz = z - A[1];
  const a = (px * vz - pz * vx) / det, b = (ux * pz - uz * px) / det;
  if (a < -1e-7 || b < -1e-7 || a + b > 1 + 1e-7) return -Infinity;
  return A[2] + a * (B[2] - A[2]) + b * (C[2] - A[2]);
}
