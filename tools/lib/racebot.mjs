// Shared driver for Node and browser regressions. Only steering/pedals: no pose or velocity corrections.
export function createRaceBot(race, R, track) {
  const isBike = race.vehicle === 'bike', cap = race.id === 'long-walk' ? 110 : isBike ? 90 : 260;
  let tgt = 0, slowT = 0, backT = 0, backs = 0;
  return {
    get target() { return tgt; },
    get backs() { return backs; },
    drive(k, i, dt) {
      track.update(k.pos.x, k.pos.z);
      const sp = k.vel.length(), look = 5 + sp * 0.35;
      // Follow the local centreline with a speed-dependent lookahead, including car hairpins.
      tgt = track.index; let ahead = 0;
      while (R[tgt + 1] && ahead < look) { ahead += Math.hypot(R[tgt+1][0]-R[tgt][0], R[tgt+1][1]-R[tgt][1]); tgt++; }
      const q = k.quat, heading = Math.atan2(2 * (q.x*q.z + q.w*q.y), 1 - 2 * (q.x*q.x + q.y*q.y));
      let d = Math.atan2(R[tgt][0] - k.pos.x, R[tgt][1] - k.pos.z) - heading; d = Math.atan2(Math.sin(d), Math.cos(d));
      i.steer = Math.max(-1, Math.min(1, -d * 2.5));
      if (isBike && sp > 4) {      // a rider asks for a lean: pure-pursuit turn rate → the lean that gives it → bars
        const L = Math.max(6, look), w = 2 * sp * Math.sin(d) / L, lean = -Math.atan(w * sp / k.t.gravity);
        const lmax = k.t.maxLean * Math.min(1, Math.max(0.05, (sp - 2) / 14));
        i.steer = Math.max(-1, Math.min(1, lean / lmax + (lean - k.lean) * 0.8));
      }
      // Brake before tight bends instead of relying on an infinite wall to redirect the bot.
      let curvature = 0;
      for (let j = track.index; j < Math.min(R.length - 2, track.index + 12); j++) {
        const a=R[j], b=R[j+1], c=R[j+2];
        const turn=Math.atan2(c[0]-b[0],c[1]-b[1])-Math.atan2(b[0]-a[0],b[1]-a[1]);
        curvature=Math.max(curvature,Math.abs(Math.atan2(Math.sin(turn),Math.cos(turn)))/Math.max(2,Math.hypot(b[0]-a[0],b[1]-a[1])));
      }
      const want = Math.max(12, Math.min(cap, Math.sqrt((isBike ? 3 : 6) / Math.max(.001, curvature)) * 3.6));
      i.throttle = sp * 3.6 < want ? 1 : 0; i.brake = sp * 3.6 > want + 4 ? 1 : 0;
      // stuck (wedged on a tight bend): back up for 1.5 s with the wheel the other way, like a person would
      slowT = sp < 1 ? slowT + dt : 0;
      if (slowT > 1 && backT <= 0) { backT = 1.5; backs++; }
      if (backT > 0) { backT -= dt; i.throttle = 0; i.brake = 1; i.steer = -i.steer; }
    },
  };
}
