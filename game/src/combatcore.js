import { DAMAGE, validHit } from './weaponswire.js';
export { DAMAGE };
export const HEALTH = 100, PROTECTION = 5, REGEN_DELAY = 8, REGEN_RATE = 10, WRECK_TIME = 3, SPLASH_RADIUS = 12;
export const damageFor = (kind, distance = 0, tank = false) => (DAMAGE[kind] || 0) *
  (kind === 'cannon' ? (distance === 0 ? 1 : 0) : Math.max(0, 1 - Math.max(0, distance) / SPLASH_RADIUS)) * (tank ? .5 : 1);
export const killFeedText = (shooter, target) => `${shooter || 'A player'} wrecked ${target || 'A player'}`;
const AIR_RADIUS = Object.freeze({ fighter: 7, stealth: 10, blackbird: 13, airliner: 20, prop: 6, stunt: 5, heli: 5 });
export const combatRadius = (kind, type) => kind === 'jet' ? (AIR_RADIUS[type] || 7) : kind === 'bike' ? 1.4 : type === 'tank' ? 3.8 : type === 'truck' ? 3.5 : 2.6;
// Segment/sphere entry fraction; all inputs and output are scalars, no temporary vectors.
export function sphereEntry(ax, ay, az, dx, dy, dz, p, radius) {
  if (p.x < Math.min(ax, ax + dx) - radius || p.x > Math.max(ax, ax + dx) + radius ||
      p.y < Math.min(ay, ay + dy) - radius || p.y > Math.max(ay, ay + dy) + radius ||
      p.z < Math.min(az, az + dz) - radius || p.z > Math.max(az, az + dz) + radius) return Infinity;
  const x = ax - p.x, y = ay - p.y, z = az - p.z, c = x*x + y*y + z*z - radius*radius;
  if (c <= 0) return 0;
  const a = dx*dx + dy*dy + dz*dz, b = x*dx + y*dy + z*dz, disc = b*b - a*c;
  if (a < 1e-12 || b >= 0 || disc < 0) return Infinity;
  const t = (-b - Math.sqrt(disc)) / a;
  return t <= 1 ? t : Infinity;
}
export function createCombatState({ onWreck = () => {}, onRespawn = () => {} } = {}) {
  const seen = Array.from({ length: 128 }, () => ({ from: '', n: -1, k: '', until: 0 }));
  let cursor = 0, clock = 0, health = HEALTH, protectedFor = PROTECTION, quiet = 0, wreckTime = 0, wrecked = false, aircraft = false;
  const api = {
    get health() { return health; }, get protected() { return protectedFor > 0; }, get wrecked() { return wrecked; },
    spawn() { health = HEALTH; protectedFor = PROTECTION; quiet = 0; wrecked = false; wreckTime = 0; },
    fired() { protectedFor = 0; },
    hit(m, vehicle, enabled = true, racing = false) {
      if (!enabled || racing || protectedFor > 0 || wrecked || vehicle.mode === 'crashed' || !validHit(m)) return false;
      if (Math.hypot(m.p[0] - vehicle.pos.x, m.p[1] - vehicle.pos.y, m.p[2] - vehicle.pos.z) > 25) return false;
      for (const s of seen) if (s.from === m.from && s.n === m.n && s.k === m.k && s.until > clock) return false;
      const s = seen[cursor++ % seen.length]; s.from = m.from; s.n = m.n; s.k = m.k; s.until = clock + 10;
      health = Math.max(0, health - m.d * (vehicle.kind === 'car' && vehicle.type === 'tank' ? .5 : 1)); quiet = 0;
      if (!health) { wrecked = true; aircraft = vehicle.kind === 'jet'; wreckTime = WRECK_TIME; onWreck(m.from); }
      return true;
    },
    update(dt) {
      clock += dt; protectedFor = Math.max(0, protectedFor - dt);
      if (wrecked) {
        if (!aircraft && (wreckTime -= dt) <= 1e-9) { api.spawn(); onRespawn(); }
      } else {
        const healing = Math.max(0, quiet + dt - REGEN_DELAY) - Math.max(0, quiet - REGEN_DELAY);
        quiet += dt; health = Math.min(HEALTH, health + healing * REGEN_RATE);
      }
    },
  };
  return api;
}
