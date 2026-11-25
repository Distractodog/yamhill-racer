import { createCombatState, combatRadius, sphereEntry, damageFor, killFeedText } from './combatcore.js';
import { groundWreckLook, disposeCombatLook } from './combatlook.js';
import { createCombatUI } from './combatui.js';

export function createCombat({ mp, vehicles, remotes, racing }) {
  const ui = createCombatUI();
  let active = vehicles.current, mesh = active.mesh, type = active.type, wasInGame = false;
  const name = id => id === mp.me.id ? mp.me.name : mp.players.get(id)?.name;
  function feed(by, target) { ui.feed(killFeedText(name(by), name(target))); }
  function restore(v) { v.combatWreck = v.combatProtected = false; v.mesh.visible = true; if (v.kind !== 'jet') groundWreckLook(v.mesh, false); }
  const state = createCombatState({
    onWreck(by) {
      const v = vehicles.current; v.combatProtected = false; v.glide?.cancel?.();
      if (v.kind === 'jet') { v.grace = 0; v.crash('shot'); }
      else { v.combatWreck = true; v.vel.set(0, 0, 0); v.ang.set(0, 0, 0); v.savePrev(); groundWreckLook(v.mesh, true); }
      feed(by, mp.me.id); mp.send({ t: 'wrecked', by });
    },
    onRespawn() {
      const v = vehicles.current; restore(v);
      // A brand new stationary player may not yet have a safe-history sample.
      if (!v.safe.length) v.safe.push([v.pos.x, v.pos.z, v.heading()]);
      v.resetToSafe();
    },
  });
  // Observe resets without changing vehicle physics; aircraft placement also calls afterReset.
  for (const v of [vehicles.car, vehicles.bike, ...vehicles.aircraft]) {
    const reset = v.reset;
    v.reset = function (...args) {
      if (this.combatWreck) return;
      const result = reset.apply(this, args);
      if (this === vehicles.current) { restore(this); state.spawn(); }
      return result;
    };
    const afterReset = v.afterReset;
    v.afterReset = function (...args) {
      afterReset.apply(this, args);
      if (this === vehicles.current) { restore(this); state.spawn(); }
    };
  }
  function refresh() {
    const v = vehicles.current;
    if (v !== active || v.type !== type || v.mesh !== mesh || mp.inGame !== wasInGame) {
      restore(active); mesh.visible = true;
      if (mesh !== active.mesh) disposeCombatLook(mesh); else groundWreckLook(mesh, false);
      active = v; mesh = v.mesh; type = v.type; wasInGame = mp.inGame; state.spawn(); restore(v);
    }
  }
  mp.on('connected', () => { refresh(); state.spawn(); });
  mp.on('disconnected', () => { refresh(); state.spawn(); });
  vehicles.onSwitch(refresh);
  const enabled = () => mp.inGame && mp.weaponsEnabled !== false && !racing();
  mp.on('hit', m => {
    refresh();
    if (m.to !== mp.me.id || m.from === mp.me.id || !mp.players.has(m.from)) return;
    if (state.hit(m, vehicles.current, enabled(), racing())) ui.hit();
  });
  mp.on('wrecked', m => { if (mp.inGame && mp.players.has(m.from) && mp.players.has(m.by)) feed(m.by, m.from); });
  // Borrowed sweep data and callbacks: no vectors, arrays or closures per projectile/remote test.
  let ax, ay, az, dx, dy, dz, best, target;
  function sweepOne(id, p, kind, type) {
    const t = sphereEntry(ax, ay, az, dx, dy, dz, p, combatRadius(kind, type));
    if (t < best) { best = t; target.type = 'player'; target.id = id; }
  }
  let impactPoint, impactKind, impactSerial, direct;
  function sendHit(id, distance) {
    const d = damageFor(impactKind, distance);
    if (d > 0) mp.send({ t: 'hit', to: id, k: impactKind, n: impactSerial, d, p: [impactPoint.x, impactPoint.y, impactPoint.z] });
  }
  function splashOne(id, p) { if (id !== direct) sendHit(id, Math.hypot(p.x - impactPoint.x, p.y - impactPoint.y, p.z - impactPoint.z)); }
  let blinkTime = 0, blinkMesh = null;
  return {
    state,
    get stopped() { return mp.inGame && state.wrecked && vehicles.current.kind !== 'jet'; },
    get blocked() { return mp.inGame && (mp.weaponsEnabled === false || state.wrecked); },
    fired() { refresh(); state.fired(); vehicles.current.combatProtected = false; },
    sweep(x, y, z, vx, vy, vz, limit, hit) {
      if (!enabled()) return limit;
      ax = x; ay = y; az = z; dx = vx; dy = vy; dz = vz; best = limit; target = hit;
      remotes.forEachCombat(sweepOne); return best;
    },
    impact(hit, p, kind, serial) {
      if (!enabled()) return;
      impactPoint = p; impactKind = kind; impactSerial = serial; direct = hit.type === 'player' ? hit.id : null;
      if (direct) sendHit(direct, 0);
      if (kind !== 'cannon') remotes.forEachCombat(splashOne);
    },
    update(dt) {
      refresh();
      const v = vehicles.current;
      if (mp.inGame) state.update(dt);
      v.combatProtected = mp.inGame && state.protected; blinkTime += dt;
      ui.update(dt, mp.inGame, state);
    },
    draw() {
      const v = vehicles.current;
      if (v.combatProtected) { blinkMesh = v.mesh; blinkMesh.visible = Math.floor(blinkTime * 8) % 2 === 0; }
      else if (blinkMesh) { blinkMesh.visible = true; blinkMesh = null; }
    },
  };
}
