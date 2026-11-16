// Far trees the fog already hides: world.js leaves out a far tree chunk (one instanced mesh) only when not drawing it
// changes no pixel. Pure (no three.js) so tools/fog_cull_test.mjs can check it.
// three.js fog goes by view depth (distance along the camera's forward axis, not straight-line distance) and is
// complete at fog.far: a fragment at depth ≥ fog.far is drawn in exactly the fog colour. But the sky (scene.background)
// is a different colour, so a fogged tree against the sky still shows as a fog-coloured bump on the skyline. A chunk is
// only left out when
//   1. every corner of its bounding box is at depth ≥ fog.far + DEPTH_MARGIN (then every vertex is, the box is convex);
//   2. the camera is at least CLEAR m above the chunk's highest point, so every ray through the chunk goes down, and
//   3. each such ray, carried on past the chunk, meets drawn ground (shown tiles, within the camera's far plane)
//      before it could leave it: what is behind the tree is fogged ground, also exactly the fog colour.
// Driving (the camera below the treetops) nothing is left out; flying, the band from fog.far out to where the ground
// behind runs past the far plane is. The decision uses this frame's camera, so nothing can appear late.
export const DEPTH_MARGIN = 60, CLEAR = 5, CLIP_MARGIN = 20;

// box: { min: {x, y, z}, max: {x, y, z} } (world). cam: {x, y, z}; fwd: the camera's unit forward vector.
export function minDepth(box, cam, fwd) {
  const { min: a, max: b } = box;
  // depth is linear in the point: the smallest corner per axis, by the sign of fwd
  return ((fwd.x >= 0 ? a.x : b.x) - cam.x) * fwd.x + ((fwd.y >= 0 ? a.y : b.y) - cam.y) * fwd.y + ((fwd.z >= 0 ? a.z : b.z) - cam.z) * fwd.z;
}

// view: { cam, fwd, fogFar, clip (camera far plane) }. groundUnder(x0, z0, x1, z1): the lowest drawn ground height
// over that rectangle, or null if any of it isn't drawn (no tile there, not built yet, hidden, off the map).
export function fogHidden(box, view, groundUnder) {
  const { cam, fwd, fogFar, clip } = view;
  if (!(fogFar > 0) || minDepth(box, cam, fwd) < fogFar + DEPTH_MARGIN) return false;
  const top = box.max.y, drop = cam.y - top;
  if (!(drop >= CLEAR)) return false;
  const { x: x0, z: z0 } = box.min, { x: x1, z: z1 } = box.max;
  // quick no first (most far chunks seen from low): the ground under the chunk is about as high as its lowest point
  // (trunks start 0.3 m into it) or lower, so the rays run at least this far; past the far plane already → drawn
  const k0 = (cam.y - box.min.y - 1) / drop;
  if (Math.hypot(Math.max(Math.abs(x0 - cam.x), Math.abs(x1 - cam.x)) * k0, Math.max(Math.abs(z0 - cam.z), Math.abs(z1 - cam.z)) * k0) > clip - CLIP_MARGIN) return false;
  // a ray from the camera through a point of the box at height y ≤ top reaches height g by k = (cam.y − g)/(cam.y − y)
  // ≤ (cam.y − g)/drop times its horizontal distance: inside the box scaled by k about the camera. The ground there
  // must be drawn and no lower than g; g is the lowest ground over the box itself, then over the scaled area.
  let g = groundUnder(x0, z0, x1, z1);
  for (let pass = 0; pass < 3; pass++) {
    if (g === null || !(cam.y - g > drop - 1e-9)) return false;
    const k = (cam.y - g) / drop;
    const rx0 = Math.min(x0, cam.x + (x0 - cam.x) * k), rx1 = Math.max(x1, cam.x + (x1 - cam.x) * k);
    const rz0 = Math.min(z0, cam.z + (z0 - cam.z) * k), rz1 = Math.max(z1, cam.z + (z1 - cam.z) * k);
    // the farthest the ray can travel before it meets the ground: the scaled area's far corner, down at g
    const far = Math.hypot(Math.max(Math.abs(rx0 - cam.x), Math.abs(rx1 - cam.x)), Math.max(Math.abs(rz0 - cam.z), Math.abs(rz1 - cam.z)), cam.y - g);
    if (far > clip - CLIP_MARGIN) return false;
    const g2 = groundUnder(rx0, rz0, rx1, rz1);
    if (g2 === null) return false;
    if (g2 >= g) return true;              // the ground over the whole area the rays cross is no lower than assumed
    g = g2;                                // lower ground further out: the rays reach further; check again
  }
  return false;
}
