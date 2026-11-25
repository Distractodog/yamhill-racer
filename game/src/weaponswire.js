// Shared, bounded wire format; no rendering imports (also used by the relay).
const KINDS = new Set(['cannon', 'missile', 'rocket', 'shell', 'blast']);
export function validShot(m) {
  if (!m || m.t !== 'shot' || !KINDS.has(m.k) || !Number.isInteger(m.n) || m.n < 0 || m.n > 65535) return false;
  if (!Array.isArray(m.p) || m.p.length !== 3 || !m.p.every(v => Number.isFinite(v) && Math.abs(v) <= 100000)) return false;
  if (!Array.isArray(m.v) || m.v.length !== 3 || !m.v.every(Number.isFinite)) return false;
  const speed = Math.hypot(...m.v);
  return m.k === 'blast' ? speed === 0 : speed >= 10 && speed <= 2000;
}
export function encodeShot(kind, n, point, velocity) {
  return { t: 'shot', k: kind, n, p: [point.x, point.y, point.z], v: [velocity.x, velocity.y, velocity.z] };
}
