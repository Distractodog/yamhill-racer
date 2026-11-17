// Session state, stable across tile unloads. IDs address the committed tree record, not a render instance.
export const TREE_REGROW_MS = 300000;
export const treeId = (tx, tz, index) => `${tx}_${tz}:${index}`;
export function parseTreeId(id) {
  if (typeof id !== 'string' || !/^-?\d{1,3}_-?\d{1,3}:\d{1,6}$/.test(id)) return null;
  const ref = id.split(/[_:]/).map(Number);
  return treeId(...ref) === id ? ref : null;
}

export function createTreeBreaks(validTile, clock = Date.now) {
  const broken = new Map(), listeners = new Set();
  function emit(event) { for (const fn of listeners) fn(event); }
  function restore(id, remainingMs) {
    const ref = parseTreeId(id);
    if (!ref || !validTile(...ref) || !Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > TREE_REGROW_MS) return false;
    const until = clock() + remainingMs, old = broken.get(id);
    if (old) { old.until = until; return true; } // authoritative host expiry, no fresh crack/fall
    const event = { id, ref, until, dx: 0, dz: 1, remote: true, snapshot: true, broken: true };
    broken.set(id, event); emit(event); return true;
  }
  return {
    broken,
    restore,
    snapshot() {
      const now = clock();
      return [...broken.values()].filter(e => e.until > now).map(e => ({ id: e.id, remainingMs: e.until - now }));
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    break(id, impact = {}, remote = false) {
      const ref = parseTreeId(id);
      if (!ref || !validTile(...ref) || broken.has(id)) return false;
      const dx = Number.isFinite(impact.dx) ? impact.dx : 0;
      let dz = Number.isFinite(impact.dz) ? impact.dz : 0;
      if (!dx && !dz) dz = 1;
      const event = { id, ref, until: clock() + TREE_REGROW_MS, dx, dz, remote, broken: true };
      broken.set(id, event); emit(event); return true;
    },
    update(now = clock()) {
      for (const [id, event] of broken) if (now >= event.until) {
        broken.delete(id); emit({ ...event, broken: false });
      }
    },
  };
}

// Normal impact speed, not total speed: sideswiping at speed must not fell a trunk.
export function treeBreakRule(kind, type, height) {
  const size = Math.max(0, Math.min(1, (height - 8) / 24));
  if (kind === 'bike') return { kmh: height <= 8 ? 150 : Infinity, loss: .65 + .1 * Math.min(1, height / 8) };
  if (kind !== 'car') return { kmh: Infinity, loss: 0 };
  const base = type === 'truck' ? 70 : type === 'suv' ? 110 : 150;
  return { kmh: base + (type === 'truck' ? 70 : 250 - base) * size, loss: type === 'truck' ? .1 + .1 * size : .3 + .2 * size };
}

export function breakTrunk(vehicle, id, height, vn) {
  const rule = treeBreakRule(vehicle.kind, vehicle.type, height);
  if (!Number.isFinite(height) || -vn * 3.6 + 1e-7 < rule.kmh) return false;
  if (!vehicle.world.breakTree?.(id, { dx: vehicle.vel.x, dz: vehicle.vel.z })) return false;
  vehicle.vel.multiplyScalar(1 - rule.loss);
  return true;
}

// Wing/crown clips shatter the tree; a central fuselage/trunk or deep crown strike retains the old crash.
export function breakTreeClip(vehicle, id, distance, crown, trunk, height, y) {
  const core = y > height * .8 ? trunk : Math.max(trunk + .7, crown * .65);
  if (distance <= core || vehicle.vel.lengthSq() < 25) return false;
  if (!vehicle.world.breakTree?.(id, { dx: vehicle.vel.x, dz: vehicle.vel.z })) return false;
  vehicle.vel.multiplyScalar(.88);
  return true;
}

export function connectTreeBreaks(world, mp, audio) {
  const off = world.treeBreaks.onChange(e => {
    if (!e.broken) return;
    if (!e.remote) mp.send({ t: 'tree-break', id: e.id });
    // Optional crack hook: the sound module can implement treeBreak(event).
    if (!e.snapshot) audio?.treeBreak?.(e);
  });
  const offNet = mp.on('tree-break', m => { if (m.from !== mp.me.id) world.breakTree(m.id, {}, true); });
  // The host has the shared session state, including breaks received from peers. Chunk snapshots so
  // a long forest drive stays within the relay message limit; the relay routes only to the new player.
  const offJoin = mp.on('joined', m => {
    if (!mp.isHost || !m.player?.id || m.player.id === mp.me.id) return;
    const trees = world.treeBreaks.snapshot();
    for (let i = 0; i < trees.length; i += 128) mp.send({ t: 'tree-sync', to: m.player.id, trees: trees.slice(i, i + 128) });
  });
  const offSync = mp.on('tree-sync', m => {
    if (m.to !== mp.me.id || !mp.players.get(m.from)?.host || !Array.isArray(m.trees)) return;
    // Relative TTL also works before the joining client's first clock-sync pong arrives.
    for (const tree of m.trees) world.treeBreaks.restore(tree.id, tree.remainingMs);
  });
  return () => { off(); offNet?.(); offJoin?.(); offSync?.(); };
}
