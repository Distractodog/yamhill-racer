// Air-mass drift in metres/second. Vehicle velocities remain air-relative: controls, stall speeds and
// baseline handling stay unchanged; drift is integrated before the existing collision checks.
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const CELL = 550; // ~3.3 candidate columns/km², rejected unless the whole footprint is open grassland
function hash(x, z, seed) {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ seed;
  n = Math.imul(n ^ n >>> 13, 1274126177);
  return ((n ^ n >>> 16) >>> 0) / 4294967296;
}
export function createWind({ seed = 1, world, sunny = () => false, racing = () => false } = {}) {
  let time = 0, own = null, cacheTime = -1;
  const cache = new Map();
  const out = { x: 0, y: 0, z: 0, speed: 0 };
  const api = {
    enabled: true,
    get seed() { return seed; }, get time() { return time; },
    get active() { return api.enabled && !racing(); },
    get thermalActive() { return api.active && sunny(); },
    update(dt) { if (Number.isFinite(dt) && dt > 0) time += dt; },
    shared: () => ({ seed }), clock: () => ({ seed, time }),
    follow(state) {
      if (!Number.isInteger(state?.seed) || !Number.isFinite(state?.time) || state.time < 0) return;
      own ||= { seed, time }; seed = state.seed >>> 0; time = state.time; cache.clear();
    },
    unfollow() { if (own) { seed = own.seed; time = own.time; own = null; cache.clear(); } },
    column(ix, iz) {
      if (Math.floor(time) !== cacheTime || cache.size > 256) { cache.clear(); cacheTime = Math.floor(time); }
      const key = `${ix},${iz}`;
      if (cache.has(key)) return cache.get(key);
      const c = makeColumn(ix, iz); cache.set(key, c); return c;
    },
    columnsNear(x, z, distance = 1000) {
      const columns = [];
      if (!api.thermalActive) return columns;
      for (let ix = Math.floor((x - distance) / CELL); ix <= Math.floor((x + distance) / CELL); ix++) {
        for (let iz = Math.floor((z - distance) / CELL); iz <= Math.floor((z + distance) / CELL); iz++) {
          const c = api.column(ix, iz);
          if (c && Math.hypot(c.x - x, c.z - z) < distance) columns.push(c);
        }
      }
      return columns;
    },
    sample(x, y, z, result = out) {
      result.x = result.y = result.z = result.speed = 0;
      if (!api.active) return result;
      const ground = world?.heightAt(x, z);
      const height = Math.max(0, y - (Number.isFinite(ground) ? ground : y));
      const phase = hash(0, 0, seed) * Math.PI * 2;
      const direction = phase + .5 * Math.sin(time / 240 + phase) + .2 * Math.sin(time / 417);
      const strength = (25 / 3.6) * (.5 + .5 * Math.sin(time / 310 + phase)) * (.3 + .7 * clamp(height / 600, 0, 1));
      result.x = Math.sin(direction) * strength; result.z = Math.cos(direction) * strength; result.speed = strength;
      if (api.thermalActive && height < 1000) {
        // Centres stay at least 110 m inside their cell; radii <= 100 m never cross a cell edge.
        const c = api.column(Math.floor(x / CELL), Math.floor(z / CELL));
        if (c) {
          const r = Math.hypot(x - c.x, z - c.z) / c.radius, h = y - c.ground;
          if (r < 1 && h > 0) result.y = c.lift * (1 - r * r) ** 2 * clamp(h / 30, 0, 1) * clamp((1000 - h) / 700, 0, 1);
        }
      }
      return result;
    },
  };
  function makeColumn(ix, iz) {
    const x = (ix + .2 + .6 * hash(ix, iz, seed)) * CELL;
    const z = (iz + .2 + .6 * hash(ix, iz, seed ^ 71)) * CELL;
    const radius = 40 + 60 * hash(ix, iz, seed ^ 123);
    const ground = world?.heightAt(x, z);
    if (!Number.isFinite(ground)) return null;
    // Sample the footprint and a wider town/forest buffer. Never cache unloaded terrain as an empty field.
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [.7, .7], [-.7, .7], [.7, -.7], [-.7, -.7]]) {
      const px = x + dx * (radius + 35), pz = z + dz * (radius + 35);
      if (world.surfaceAt(px, pz) !== 0 || !Number.isFinite(world.heightAt(px, pz))) return null;
      const water = world.waterLevelAt?.(px, pz);
      if (Number.isFinite(water) && water > world.heightAt(px, pz)) return null;
    }
    let blocked = false;
    for (const b of world.buildingsNear?.(x, z, radius + 100) || []) {
      const xs = b.pts.map(p => p[0]), zs = b.pts.map(p => p[1]), r = radius + 100;
      if (x + r >= Math.min(...xs) && x - r <= Math.max(...xs) && z + r >= Math.min(...zs) && z - r <= Math.max(...zs)) blocked = true;
    }
    world.treesNear?.(x, z, radius + 20, (tx, tz, tr) => { if (Math.hypot(tx - x, tz - z) < radius + 20 + tr) blocked = true; });
    if (blocked) return null;
    return { x, z, ground, radius, lift: 2 + 2 * hash(ix, iz, seed ^ 351), birds: 3 + Math.floor(4 * hash(ix, iz, seed ^ 17)) };
  }
  return api;
}
export function driftAir(vehicle, dt, response = 1, thermals = true) {
  if (!vehicle.wind) return; // Node baselines explicitly have no wind controller
  const p = vehicle.pos, w = vehicle.wind.sample(p.x, p.y, p.z);
  p.x += w.x * response * dt; p.z += w.z * response * dt;
  if (thermals) p.y += w.y * response * dt;
}
