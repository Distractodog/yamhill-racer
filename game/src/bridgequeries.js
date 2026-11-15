// Junction fans attached to a deck must obey the same height-layer rule as it.
// A flag-0 ring edge is a road mouth; its midpoint matches that road's endpoint.
// Match topology rather than proximity, which could mistake the lower road for a deck.
export function bridgeJunction(j, roads) {
  if (j.bridge) return true;
  for (let k = 0; k < j.ring.length; k++) {
    const a = j.ring[k], b = j.ring[(k + 1) % j.ring.length];
    if (a[3] !== 0) continue;
    const x = (a[0] + b[0]) / 2, z = (a[1] + b[1]) / 2, y = (a[2] + b[2]) / 2;
    for (const r of roads) if (r.bridge) for (const i of [0, r.n - 1]) {
      // Allow baked coordinate rounding and the mouth's interpolated cross slope.
      if (Math.hypot(r.x[i] - x, r.z[i] - z) < .05 && Math.abs(r.y[i] - y) < .25) return true;
    }
  }
  return false;
}
