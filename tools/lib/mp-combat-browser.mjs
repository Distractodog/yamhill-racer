// Aim a model's +Z axis at a point, compensating for its off-centre missile pylon.
export function missilePose(target, anchor = [2, -.4, 1], distance = 120, height = 15) {
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

// Serializable into page.evaluate; optional `only` revalidates a selected lane on the other client.
export function findCombatLane(world = null, only = null) {
  world ||= globalThis.game.world;
  for (let x = only?.x ?? -1400; x <= (only?.x ?? 400); x += 40) for (let z = only?.z ?? -400; z <= (only?.z ?? 1240); z += 40) {
    let clear = true, low = Infinity, high = -Infinity;
    for (let back = 0; back <= 120 && clear; back += 8) {
      const at = z - back;
      if (!world.loadedAt(x, at)) { clear = false; break; }
      const h = world.heightAt(x, at);
      low = Math.min(low, h); high = Math.max(high, h);
      if (!Number.isFinite(h) || high - low > 2 || world.waterLevelAt(x, at) > h) { clear = false; break; }
      // buildingsNear returns tile-wide candidates; reject footprints actually near the lane.
      for (const b of world.buildingsNear(x, at, 18)) {
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const p of b.pts) { x0 = Math.min(x0,p[0]); x1 = Math.max(x1,p[0]); z0 = Math.min(z0,p[1]); z1 = Math.max(z1,p[1]); }
        if (x0 <= x+18 && x1 >= x-18 && z0 <= at+18 && z1 >= at-18) { clear = false; break; }
      }
      world.treesNear(x, at, 40, (tx,tz,r,height,broad) => {
        const crown = Math.max(r, height * (broad ? .22 : .16));
        if (Math.hypot(tx-x,tz-at) <= 12+crown) clear = false;
      });
    }
    if (clear) return { x, z, ground: world.heightAt(x, z), sourceGround: world.heightAt(x, z - 120) };
  }
  throw Error('No loaded flat firing lane clear of buildings and tree canopies');
}
