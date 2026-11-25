// Fixed storage and swept world queries. No player damage: all local contacts pass through onHit.
export const ROUND_CAP = 200, MISSILE_CAP = 24, CANNON_INTERVAL = 1 / 12, MISSILE_COOLDOWN = 1.5;
export const armed = v => v?.kind === 'jet' && (v.type === 'fighter' || v.type === 'stealth' || v.type === 'heli');
const noop = () => {};
const point = () => ({ x: 0, y: 0, z: 0 });
export function createWeaponsCore({ world, onFire = noop, onImpact = noop, onTrail = noop, roofAt = null }) {
  const pool = Array.from({ length: ROUND_CAP + MISSILE_CAP }, () => ({ active: false, p: point(), v: point(), life: 0, trail: 0, kind: '', remote: false, from: '', n: 0 }));
  const hit = { type: '', id: null }, contact = point(), impact = { dx: 0, dz: 0 };
  let cannon = 0, cooldown = 0, lastSecondary = false, serial = 0, roundCursor = 0, missileCursor = 0;
  let ax, ay, az, dx, dy, dz, best;
  const bounds = new WeakMap();
  function tree(tx, tz, radius, height, broad, id) {
    const base = (world.terrainAt || world.heightAt)(tx, tz), r = Math.max(radius, height * (broad ? .22 : .16));
    // Crown/trunk envelope, continuous segment/cylinder intersection (including vertical shots).
    const ox = ax - tx, oz = az - tz, a = dx * dx + dz * dz, b = ox * dx + oz * dz, c = ox * ox + oz * oz - r * r;
    let lo = 0, hi = best;
    if (a < 1e-12) { if (c > 0) return; }
    else { const disc = b * b - a * c; if (disc < 0) return; const s = Math.sqrt(disc); lo = Math.max(lo, (-b - s) / a); hi = Math.min(hi, (-b + s) / a); }
    if (Math.abs(dy) < 1e-12) { if (ay < base || ay > base + height) return; }
    else { const t0 = (base - ay) / dy, t1 = (base + height - ay) / dy; lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1)); }
    if (lo <= hi && lo < best) { best = lo; hit.type = 'tree'; hit.id = id; }
  }
  function inside(pts, x, z) {
    let yes = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) yes = !yes;
    }
    return yes;
  }
  function buildingAt(b, t, floor, top) {
    if (t < 0 || t >= best) return;
    const x = ax + dx * t, y = ay + dy * t, z = az + dz * t;
    if (y >= floor && y <= (roofAt ? roofAt(b, x, z, world) : top)) { best = t; hit.type = 'building'; hit.id = b; }
  }
  function sweep(p, dt) {
    ax = p.p.x; ay = p.p.y; az = p.p.z; dx = p.v.x * dt; dy = p.v.y * dt; dz = p.v.z * dt; best = 1.000001; hit.type = ''; hit.id = null;
    const length = Math.hypot(dx, dy, dz);
    world.treesNear?.(ax + dx / 2, az + dz / 2, Math.hypot(dx, dz) / 2 + 18, tree);
    const buildings = world.buildingsNear?.(ax + dx / 2, az + dz / 2, length / 2 + 20);
    if (buildings) for (let k = 0; k < buildings.length; k++) {
      const b = buildings[k], pts = b.pts;
      if (!pts?.length) continue;
      let bb = bounds.get(b);
      if (!bb) { bb = [Infinity, Infinity, -Infinity, -Infinity]; for (const p of pts) { bb[0] = Math.min(bb[0], p[0]); bb[1] = Math.min(bb[1], p[1]); bb[2] = Math.max(bb[2], p[0]); bb[3] = Math.max(bb[3], p[1]); } bounds.set(b, bb); }
      if (Math.max(ax, ax + dx) < bb[0] || Math.min(ax, ax + dx) > bb[2] || Math.max(az, az + dz) < bb[1] || Math.min(az, az + dz) > bb[3]) continue;
      const floor = (world.terrainAt || world.heightAt)(pts[0][0], pts[0][1]), top = b.top ?? floor + (b.h || 6);
      if (inside(pts, ax, az)) buildingAt(b, 0, floor, top);
      // Exact wall crossing; a thin wall must not fall between terrain samples.
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[j], ex = pts[i][0] - a[0], ez = pts[i][1] - a[1], det = dx * ez - dz * ex;
        if (Math.abs(det) < 1e-12) continue;
        const x = a[0] - ax, z = a[1] - az, t = (x * ez - z * ex) / det, u = (x * dz - z * dx) / det;
        if (u >= 0 && u <= 1) buildingAt(b, t + 1e-7, floor, top);
      }
      const steps = Math.max(1, Math.ceil(length));
      for (let i = 1; i <= steps && i / steps < best; i++) {
        const t = i / steps;
        if (inside(pts, ax + dx * t, az + dz * t)) buildingAt(b, t, floor, top);
      }
    }
    const steps = Math.max(1, Math.ceil(length / 2));
    for (let i = 0; i <= steps && i / steps < best; i++) {
      const t = i / steps, x = ax + dx * t, z = az + dz * t;
      if (world.loadedAt && !world.loadedAt(x, z)) continue;
      if (ay + dy * t <= world.heightAt(x, z)) {
        let lo = Math.max(0, (i - 1) / steps), hi = t;
        for (let j = 0; j < 7; j++) { const m = (lo + hi) / 2; if (ay + dy * m <= world.heightAt(ax + dx * m, az + dz * m)) hi = m; else lo = m; }
        best = hi; hit.type = 'terrain'; hit.id = null; break;
      }
    }
    const t = Math.min(1, best); p.p.x = ax + dx * t; p.p.y = ay + dy * t; p.p.z = az + dz * t;
    return !!hit.type;
  }
  let blastPoint;
  function blastTree(x, z, r, h, broad, id) {
    const y = (world.terrainAt || world.heightAt)(x, z), dy = Math.max(y - blastPoint.y, 0, blastPoint.y - y - h);
    if ((x - blastPoint.x) ** 2 + (z - blastPoint.z) ** 2 + dy * dy <= 144) world.breakTree?.(id, impact);
  }
  const api = {
    pool,
    get cooldown() { return cooldown; },
    // Phase 2 entry point: target is {type,id}; point is borrowed until the next step.
    onHit(target, p, kind) {
      if (target.type === 'tree') world.breakTree?.(target.id, impact);
      if (kind !== 'cannon') { blastPoint = p; world.treesNear?.(p.x, p.z, 12, blastTree); }
    },
    spawn(kind, origin, velocity, remote = false, from = '', n = serial++ % 65536) {
      const index = kind === 'cannon' ? roundCursor++ % ROUND_CAP : ROUND_CAP + missileCursor++ % MISSILE_CAP;
      const p = pool[index]; p.active = true; p.kind = kind; p.remote = remote; p.from = from; p.n = n;
      p.p.x = origin.x; p.p.y = origin.y; p.p.z = origin.z; p.v.x = velocity.x; p.v.y = velocity.y; p.v.z = velocity.z;
      p.life = kind === 'cannon' ? 1.2 : 6; p.trail = 0; onFire(p); return p;
    },
    clear() { for (const p of pool) p.active = false; cannon = 0; },
    control(dt, vehicle, primary, secondary, blocked, fire) {
      cooldown = Math.max(0, cooldown - dt); cannon -= dt;
      const press = secondary && !lastSecondary; lastSecondary = secondary;
      if (blocked || !armed(vehicle) || vehicle.mode === 'crashed') { cannon = Math.max(0, cannon); return; }
      if (primary) { while (cannon < -1e-9) { fire('cannon'); cannon += CANNON_INTERVAL; } }
      else cannon = Math.max(0, cannon);
      if (press && cooldown <= 1e-9) { fire(vehicle.type === 'heli' ? 'rocket' : 'missile'); cooldown = MISSILE_COOLDOWN; }
    },
    step(dt) {
      // Bounded substeps keep terrain sweeps cheap even after a stalled animation frame.
      let remaining = Math.min(.1, dt);
      while (remaining > 1e-9) {
        const step = Math.min(1 / 120, remaining); remaining -= step;
        for (const p of pool) if (p.active) {
          const collision = sweep(p, step); p.life -= step;
          if (collision || p.life <= 0) {
            p.active = false;
            if (!collision && p.kind === 'cannon') continue;
            if (!collision) { hit.type = 'air'; hit.id = null; }
            contact.x = p.p.x; contact.y = p.p.y; contact.z = p.p.z; impact.dx = p.v.x; impact.dz = p.v.z;
            if (!p.remote) api.onHit(hit, contact, p.kind);
            onImpact(p, hit);
          } else if (p.kind !== 'cannon') { p.trail -= step; if (p.trail <= 0) { onTrail(p); p.trail += .05; } }
        }
      }
    },
  };
  return api;
}
