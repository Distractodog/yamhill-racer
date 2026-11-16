// Respawn hold. R, a jet / helicopter crash respawn or a race's air respawn can put the vehicle where the ground hasn't
// streamed in (a safe spot far back along the flight, the map's spawn point): there heightAt is 0, so the vehicle was
// placed at the wrong height (under the terrain), and its first step pulled it back to the last loaded spot near the
// wreck (keepInBounds), often into a second crash. Now, when a respawn lands on unloaded ground, physics pauses with the
// vehicle at the new spot (so the camera and the tile streaming go there), and once the ground around it is built the
// same placement runs again on real ground. Already-loaded spots are placed at once, exactly as before.
// It never lets go onto unloaded ground: past `timeout` s it also takes the first loaded fallback (the newest safe spot
// that is loaded, then where the vehicle was when the respawn began, if that was loaded); until one of them is, physics
// stays paused. A vehicle switch during the hold (V, a Garage type with its own vehicle such as jet ↔ helicopter) hands
// the hold to the vehicle you're in now, which is placed the same way.
//   const hold = createRespawnHold({ world, vehicles: [...], current });  hold.update(dt) each frame; hold.blocked pauses
//   physics (main.js).
export const HOLD_REACH = 250;     // ground needed this far around the spot (m), where the map has tiles
const WAIT = 'Loading the ground here…', LONG = 'Still loading the ground here… (H goes home)';

export function createRespawnHold({ world, vehicles, current = () => null, timeout = 30 }) {
  let hold = null;
  // the spot itself is built, and the ground the camera sees around it (points where the map has no tile don't count)
  const ready = (x, z) => world.loadedAt(x, z) && [[1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => {
    const px = x + a * HOLD_REACH, pz = z + b * HOLD_REACH;
    return world.loadedAt(px, pz) || (world.mapContains && !world.mapContains(px, pz, 0));
  });
  function check(v, before, req) {
    if (ready(v.pos.x, v.pos.z)) { if (hold?.v === v) hold = null; return; }
    // what the respawn chose: on the wheels at (x, z) facing yaw, or flying (a race's last ring) at this height and
    // speed; req: an aircraft's own respawn request (airrespawn.js), replayed once the ground is there
    hold = { v, x: v.pos.x, z: v.pos.z, yaw: v.heading(), air: v.mode === 'air' && !!v.placeInAir, y: v.pos.y, kmh: v.vel.length() * 3.6, t: 0, req,
      before: before && ready(before[0], before[1]) ? before : null };      // fallback only if verified loaded now
    freeze();
    v.say?.(WAIT, 30);
  }
  function freeze() {
    const v = hold.v;
    v.pos.x = hold.x; v.pos.z = hold.z; v.vel.set(0, 0, 0); v.ang?.set(0, 0, 0); v._lastLoaded = null;
    v.savePrev(); v.interpolate?.(0);
  }
  // after the timeout: a loaded spot to fall back to, or null (then keep waiting)
  function fallback() {
    const safe = hold.v.safe || [];
    for (let i = safe.length - 1; i >= 0; i--) if (ready(safe[i][0], safe[i][1])) return safe[i];
    return hold.before && ready(hold.before[0], hold.before[1]) ? hold.before : null;
  }
  // aircraft go through their respawn placement (level, clear ground, crash grace: airrespawn.js), others reset
  function place(v, spot, air, req = null) {
    hold = null;
    if (air && req?.air && v.respawnInAir) v.respawnInAir(...req.air);
    else if (air) v.placeInAir(spot.x, spot.y, spot.z, spot.yaw, spot.kmh);
    else if (v.respawnAt) v.respawnAt(req?.ground || [spot.x, spot.z, spot.yaw, spot.refY]);
    else v.reset(spot.x, spot.z, spot.yaw);
    v._lastLoaded = null; v.say?.('', 0);
  }
  for (const v of vehicles) {
    const original = v.resetToSafe;
    v.resetToSafe = function (...args) {
      const before = [this.pos.x, this.pos.z, this.heading()];
      this.lastRespawn = null;
      const r = original.apply(this, args); check(this, before, this.lastRespawn); return r;
    };
  }
  return {
    get blocked() { return !!hold; },
    get holding() { return hold && { x: hold.x, z: hold.z, air: hold.air, t: hold.t, vehicle: hold.v }; },
    cancel() { if (hold) hold.v.say?.('', 0); hold = null; },
    update(dt) {
      if (!hold) return;
      const now = current();
      if (now && now !== hold.v) {           // switched vehicle while held: the new one waits here instead
        hold.v.say?.('', 0);
        hold.v = now; hold.air = hold.air && !!now.placeInAir; if (hold.req?.ground) hold.req = null;
        now.say?.(hold.t > timeout ? LONG : WAIT, 30);
      }
      const v = hold.v;
      hold.t += dt;
      if (ready(hold.x, hold.z)) { place(v, hold, hold.air, hold.req); return; }
      if (hold.t > timeout) {
        const f = fallback();
        if (f) { place(v, { x: f[0], z: f[1], yaw: f[2] ?? hold.yaw, refY: f[3] }, false); return; }
        if (hold.t - dt <= timeout) v.say?.(LONG, 1e9);
      }
      freeze();
    },
  };
}
