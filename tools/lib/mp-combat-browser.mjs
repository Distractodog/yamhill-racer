// Aim a model's +Z axis at a point, compensating for its off-centre missile pylon.
export function missilePose(target, anchor = [2, -.4, 1], distance = 45, height = 22) {
  const origin = [target[0], target[1] + height, target[2] - distance];
  const length = Math.hypot(height, distance), y = -height / length, z = distance / length;
  const qx = -y / Math.sqrt(2 * (1 + z)), qw = Math.sqrt((1 + z) / 2);
  // q rotates about X. Place the missile, rather than the fuselage centre, on the aiming ray.
  const cos = 1 - 2*qx*qx, sin = 2*qx*qw;
  origin[0] -= anchor[0]; origin[1] -= anchor[1]*cos - anchor[2]*sin; origin[2] -= anchor[1]*sin + anchor[2]*cos;
  return { position: origin, quaternion: [qx, 0, 0, qw] };
}
export function localURL(url, protocols) {
  const u = new URL(url);
  if (!protocols.includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw Error('Combat browser check requires a loopback server');
  return u;
}
