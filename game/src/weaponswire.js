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

export const DAMAGE = Object.freeze({ cannon: 6, missile: 70, rocket: 55, shell: 80 });
export function validHit(m) {
  return !!m && m.t === 'hit' && Object.hasOwn(DAMAGE, m.k) &&
    typeof m.to === 'string' && /^[A-Za-z0-9_-]{12}$/.test(m.to) &&
    Number.isInteger(m.n) && m.n >= 0 && m.n <= 65535 &&
    Number.isFinite(m.d) && m.d > 0 && m.d <= DAMAGE[m.k] &&
    Array.isArray(m.p) && m.p.length === 3 && m.p.every(v => Number.isFinite(v) && Math.abs(v) <= 100000);
}
