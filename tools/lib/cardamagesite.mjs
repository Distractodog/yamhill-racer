// Select a real loaded campus building face for the controller screenshot run and its Node rehearsal.
// No model/damage injection; all candidates must have loaded, clear, gently sloped approaches.
export function findCarDamageSite(W = globalThis.game?.world) {
  // Find a long, clear, gently sloped real building face on loaded campus ground.
  const buildings = new Set();
  for (let x = -850; x <= 100; x += 30) for (let z = -100; z <= 800; z += 30)
    if (W.loadedAt(x, z)) for (const b of W.buildingsNear(x, z)) buildings.add(b);
  const inside = (pts, x, z) => {
    let yes = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
    }
    return yes;
  };
  const choices = [];
  for (const b of buildings) for (let i = 0; i < b.pts.length; i++) {
    const a = b.pts[i], end = b.pts[(i + 1) % b.pts.length], dx = end[0] - a[0], dz = end[1] - a[1], len = Math.hypot(dx, dz);
    if (len < 12) continue;
    const x = (a[0] + end[0]) / 2, z = (a[1] + end[1]) / 2;
    let nx = dz / len, nz = -dx / len;
    if (inside(b.pts, x + nx, z + nz)) { nx = -nx; nz = -nz; }
    const heights = [], near = [];
    for (const d of [1, 3, 6, 10, 15, 22]) {
      const px = x + nx * d, pz = z + nz * d;
      if (!W.loadedAt(px, pz)) break;
      heights.push(W.heightAt(px, pz));
      for (const other of W.buildingsNear(px, pz)) if (inside(other.pts, px, pz)) near.push(other);
      W.treesNear(px, pz, 4, () => near.push('tree'));
    }
    const slope = Math.max(...heights) - Math.min(...heights);
    if (heights.length === 6 && !near.length && slope < 2) choices.push({ x, z, nx, nz, len, slope, footprint: b.pts });
  }
  choices.sort((a, b) => a.slope - b.slope);
  if (!choices.length) throw Error('No clear real building face found; do not substitute injected damage');
  return choices[0];
}
