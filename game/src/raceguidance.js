// Race guidance calculations, independent of rendering and vehicle implementation.
export function checkpointStart(challenge, next) {
  const p = next > 1 ? challenge.gates[Math.min(next - 1, challenge.gates.length - 1)] : challenge.start;
  return { x: p.x, z: p.z, yaw: p.yaw };
}

// Use the track's current segment so bends and routes crossing themselves retain their direction.
export function drivingWrongWay(velocity, points, index) {
  if (!points || index < 0 || index >= points.length - 1) return false;
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < 5) return false;
  const a = points[index], b = points[index + 1], dx = b[0] - a[0], dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  return length > 0 && (velocity.x * dx + velocity.z * dz) < -0.4 * speed * length;
}
