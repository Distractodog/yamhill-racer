// Respawn hold. R, a jet / helicopter crash respawn or a race's air respawn can put the vehicle where the ground hasn't
// streamed in (a safe spot far back along the flight, the map's spawn point): there heightAt is 0, so the vehicle was
// placed at the wrong height (under the terrain), and its first step pulled it back to the last loaded spot near the
// wreck (keepInBounds), often into a second crash. Now, when a respawn lands on unloaded ground, physics pauses with the
// vehicle at the new spot (so the camera and the tile streaming go there), and once the ground around it is built the
// same placement runs again on real ground. Already-loaded spots are placed at once, exactly as before.
//   const hold = createRespawnHold({ world, vehicles: [...] });  hold.update(dt) each frame; hold.blocked pauses physics.
export const HOLD_REACH = 250;     // ground needed this far around the spot (m), where the map has tiles

export function createRespawnHold({ world, vehicles, current = () => null, timeout = 30 }) {
  let hold = null;
  // the spot and the ground the camera sees around it are built (points where the map has no tile don't count)
  const ready = (x, z) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].every(([a, b]) => {
    const px = x + a * HOLD_REACH, pz = z + b * HOLD_REACH;
    return world.loadedAt(px, pz) || (world.mapContains && !world.mapContains(px, pz, 0));
  });
  function check(v) {
    if (ready(v.pos.x, v.pos.z)) { if (hold?.v === v) hold = null; return; }
    // what the respawn chose: on the wheels at (x, z) facing yaw, or flying (a race's last ring) at this height and speed
    hold = { v, x: v.pos.x, z: v.pos.z, yaw: v.heading(), air: v.mode === 'air' && !!v.placeInAir, y: v.pos.y, kmh: v.vel.length() * 3.6, t: 0 };
    freeze();
    v.say?.('Loading the ground here…', 30);
  }
  function freeze() {
    const v = hold.v;
    v.pos.x = hold.x; v.pos.z = hold.z; v.vel.set(0, 0, 0); v.ang?.set(0, 0, 0); v._lastLoaded = null;
    v.savePrev(); v.interpolate?.(0);
  }
  for (const v of vehicles) {
    const original = v.resetToSafe;
    v.resetToSafe = function (...args) { const r = original.apply(this, args); check(this); return r; };
  }
  return {
    get blocked() { return !!hold; },
    get holding() { return hold && { x: hold.x, z: hold.z, air: hold.air, t: hold.t }; },
    cancel() { if (hold) hold.v.say?.('', 0); hold = null; },
    update(dt) {
      if (!hold) return;
      const v = hold.v;
      if (current() && current() !== v) { hold = null; v.say?.('', 0); return; }   // switched vehicle meanwhile: that one is placed already
      hold.t += dt;
      if (!ready(hold.x, hold.z) && hold.t < timeout) { freeze(); return; }
      const { x, z, yaw, air, y, kmh } = hold;
      hold = null;
      if (air) v.placeInAir(x, y, z, yaw, kmh); else v.reset(x, z, yaw);
      v._lastLoaded = null; v.say?.('', 0);
    },
  };
}
