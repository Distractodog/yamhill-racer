// Frame-time probe for vehicle switches, Garage type changes, R resets, crash respawns and H (go home), run INSIDE the
// game page. hitchSuite is self-contained (no imports, no outside variables) so a puppeteer script can run its source
// with page.evaluate (tools/hitch_test.mjs); it also works on an iframe's window.
//   const report = await hitchSuite(window, { only: ['switch', 'types'] });
// For each action it records every frame for `settle` ms after it: the game's own frame callback time (main-thread ms,
// split into renderer.render / world.updateLOD / the rest), the rAF interval, and shader programs compiled.
// Rows: { label, first, worst, worstRaf, render, lod, programs, frames, over50, note }. The checks it can do on the
// spot (paint shown at once, respawn placed on loaded ground, no pull-back) go into report.fails.
// types: { car: [ids…], bike: [...], jet: [...] } (vehicletypes.js VEHICLE_TYPES ids, the default first).
export async function hitchSuite(win, { types = {}, only = null, paint = '#000000', settle = 1200, log = () => {} } = {}) {
  const g = win.game, doc = win.document, raf = win.requestAnimationFrame.bind(win);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frames = n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : raf(f)); raf(f); });
  const until = async (ok, ms, what) => { const end = performance.now() + ms; while (!ok()) { if (performance.now() > end) throw Error(`timed out: ${what}`); await sleep(50); } };
  const want = name => !only || only.includes(name);
  const rows = [], fails = [], notes = [];
  // ---- instrumentation: time the game's frame callback and its two big parts
  let cur = null, last = 0;
  const frameStats = () => ({ cb: 0, render: 0, lod: 0, raf: 0, parts: {} });
  if (!win.__hitchWrapped) {
    win.__hitchWrapped = true;
    const r = g.renderer, render = r.render.bind(r), lod = g.world.updateLOD;
    r.render = (s, c) => { const t = performance.now(); render(s, c); if (win.__hitchFrame) win.__hitchFrame.render += performance.now() - t; };
    g.world.updateLOD = (...a) => { const t = performance.now(); const out = lod(...a); if (win.__hitchFrame) win.__hitchFrame.lod += performance.now() - t; return out; };
    // 2D canvas calls (the minimaps): the slowest call of a frame, with its source size for drawImage
    const proto = win.CanvasRenderingContext2D.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const d = Object.getOwnPropertyDescriptor(proto, name), f = d.value;
      if (typeof f !== 'function' || name === 'constructor') continue;
      proto[name] = function (...a) {
        const t = performance.now(); const out = f.apply(this, a); const ms = performance.now() - t, fr = win.__hitchFrame;
        if (fr && ms > (fr.parts.__draw || 0)) { fr.parts.__draw = ms; const src = a[0]; fr.drawWhat = name === 'drawImage' ? `drawImage ${src.constructor?.name} ${src.naturalWidth || src.width}x${src.naturalHeight || src.height}` : name; }
        return out;
      };
    }
    // the other per-frame systems main.js calls, timed by name (the worst frame lists the biggest)
    for (const [obj, fn] of [['minimap', 'update'], ['world', 'updateShadows'], ['effects', 'update'], ['drivingFX', 'update'], ['directions', 'update'],
      ['pinGuide', 'update'], ['remotes', 'update'], ['challenges', 'update'], ['atmosphere', 'update'], ['cosmetics', 'update'], ['respawnHold', 'update'],
      ['vehicleLights', 'update'], ['garage', 'update'], ['warmup', 'step']]) {
      const o = g[obj], f = o?.[fn]; if (typeof f !== 'function') continue;
      o[fn] = function (...a) { const t = performance.now(); const out = f.apply(this, a); const fr = win.__hitchFrame; if (fr) fr.parts[`${obj}.${fn}`] = (fr.parts[`${obj}.${fn}`] || 0) + performance.now() - t; return out; };
    }
    win.requestAnimationFrame = cb => raf(t => {
      win.__hitchFrame = frameStats();
      const s = performance.now(); cb(t); win.__hitchFrame.cb = performance.now() - s;
      win.__hitchFrame.raf = last ? t - last : 0; last = t;
      win.__hitchLog?.push(win.__hitchFrame); win.__hitchFrame = null;
    });
  }
  const programs = () => g.renderer.info.programs?.length ?? 0;
  async function measure(label, action, { ms = settle, note = '' } = {}) {
    await frames(3);
    const list = win.__hitchLog = [], p0 = programs();
    // the action's synchronous part blocks the page like a frame does; an async action's waiting doesn't
    const t0 = performance.now();
    let result, actionMs = 0;
    try { const pending = action(); actionMs = performance.now() - t0; result = await pending; } catch (e) { fails.push(`${label}: ${e.message}`); }
    await sleep(ms); await frames(2);
    win.__hitchLog = null;
    const worst = list.reduce((a, f) => f.cb > a.cb ? f : a, frameStats());
    const row = { label, worst: +Math.max(worst.cb, actionMs).toFixed(1), worstRaf: +Math.max(0, ...list.slice(1).map(f => f.raf)).toFixed(1),
      render: +worst.render.toFixed(1), lod: +worst.lod.toFixed(1), action: +actionMs.toFixed(1), programs: programs() - p0, frames: list.length,
      over50: list.filter(f => f.cb > 50).length, note: (typeof result === 'string' ? result : '') || note,
      top: Object.entries(worst.parts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, ms]) => `${k === '__draw' ? `2d ${worst.drawWhat}` : k} ${ms.toFixed(1)}`).join(', ') };
    rows.push(row); log(row);
    return row;
  }
  // ---- paint: the colours of the materials the Garage paints (body role) on the current vehicle, right now
  const bodyHex = () => { const s = new Set(); g.vehicles.current.mesh.traverse(o => { if (o.material?.userData?.cosmeticRole === 'body') s.add('#' + o.material.color.getHexString()); }); return [...s]; };
  // (the race car paints vertex colours, no body material: tools/paint_spawn_test.mjs checks it)
  const checkPaint = what => { const got = bodyHex(); if (got.length && (got.length !== 1 || got[0] !== paint)) fails.push(`${what}: body paint ${got.join(',')} (want ${paint})`); };
  const v = () => g.vehicles.current;
  const loaded = (x, z) => g.world.loadedAt(x, z);
  const place = async (x, z, yaw = 0) => {         // like goHome: hold the focus there until the ground is built
    const hold = () => { const c = v(); c.pos.set(x, c.pos.y, z); c.vel.set(0, 0, 0); c._lastLoaded = null; c.savePrev(); c.interpolate(0); };
    hold();
    const end = performance.now() + 60000;
    while (!loaded(x, z) || g.world.pendingTiles() > 0) { if (performance.now() > end) throw Error(`no ground at ${x},${z}`); await sleep(100); hold(); }
    v().reset(x, z, yaw); v().safe = []; v()._lastLoaded = null;
  };
  // ---- start: paint every kind black (the owner's choice), wait for warm-up if the build has one
  for (const kind of ['car', 'bike', 'jet']) g.cosmetics.set(kind, { body: paint });
  if (g.warmup) { await until(() => g.warmup.done, 20000, 'warm-up').catch(e => notes.push(e.message)); }
  notes.push(`warm-up: ${g.warmup ? (g.warmup.done ? 'done' : 'not finished') : 'none in this build'}`);
  // start from a settled world: no tiles still building in the background
  await until(() => g.world.pendingTiles() === 0, 30000, 'tiles settled').catch(e => notes.push(e.message));
  const home = [v().pos.x, v().pos.z];

  if (want('switch')) for (const kind of ['bike', 'jet', 'car', 'bike', 'jet', 'car']) {
    const from = v().kind;
    await measure(`V ${from}→${kind}`, () => { g.vehicles.switchTo(kind); checkPaint(`V switch to ${kind}`); });
  }
  if (want('types')) for (const round of [1, 2]) for (const kind of ['car', 'bike', 'jet']) {
    g.vehicles.switchTo(kind);
    const list = types[kind] || [];
    for (const id of [...list.slice(1), list[0]]) await measure(`type ${kind}: ${id} (round ${round})`, () => { g.vehicles.setType(kind, id); checkPaint(`type ${kind} ${id}`); });
  }
  if (want('garage')) {
    g.vehicles.switchTo('jet'); g.garage.show(); await frames(5);
    const select = doc.querySelector('#cosmetic-garage [name="vehicleType"]');
    for (const id of [...select.options].map(o => o.value).concat(select.value)) {
      await measure(`Garage type jet: ${id}`, () => { select.value = id; select.dispatchEvent(new win.Event('input', { bubbles: true })); });
    }
    g.garage.close(); await frames(3); checkPaint('after the Garage');
  }
  if (want('reset')) {
    g.vehicles.switchTo('car'); await place(...home);
    const c = v(); c.safe = [[home[0] + 300, home[1], 0]];
    await measure('R reset (loaded spot 300 m away)', () => { c.resetToSafe(); });
    // far: a safe spot 5 km away that hasn't streamed in
    const far = [home[0] + 5000, home[1] + 300];
    c.safe = [[...far, 0]];
    const r = await measure('R reset (spot 5 km away, not loaded)', async () => {
      c.resetToSafe();
      const t = performance.now();
      while (g.respawnHold?.blocked && performance.now() - t < 60000) await sleep(50);
      return `held ${((performance.now() - t) / 1000).toFixed(1)} s`;
    });
    const p = v().pos, ground = g.world.heightAt(p.x, p.z);
    if (!loaded(p.x, p.z)) fails.push(`far R reset: placed on unloaded ground (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
    if (Math.hypot(p.x - far[0], p.z - far[1]) > 30) fails.push(`far R reset: ended ${Math.hypot(p.x - far[0], p.z - far[1]).toFixed(0)} m from the spot`);
    if (Math.abs(p.y - ground) > 3) fails.push(`far R reset: ${(p.y - ground).toFixed(1)} m off the ground`);
    r.note += ` · end ${(p.y - ground).toFixed(2)} m above ground`;
    await place(...home);
  }
  // 'crash' = near + far; 'crashfar' = only the far one
  if (want('crash') || want('crashfar')) for (const [name, dx, dz] of [['near', 0, 0], ['far (safe spot 4 km back)', 4000, 0]].slice(want('crash') ? 0 : 1)) {
    g.vehicles.switchTo('jet'); await place(home[0] + dx, home[1] + dz);
    const j = v(); j.safe = [[home[0], home[1], 0]];
    j.placeInAir(j.pos.x, g.world.heightAt(j.pos.x, j.pos.z) + 200, j.pos.z, Math.PI / 2, 900);
    await frames(10); j.crash('impact');
    await sleep(300);
    const r = await measure(`jet crash respawn (${name})`, async () => {
      const t = performance.now();
      while ((j.mode === 'crashed' || g.respawnHold?.blocked) && performance.now() - t < 60000) await sleep(16);
      await frames(1); checkPaint(`jet respawn (${name}) first frame`);
      return `back after ${((performance.now() - t) / 1000).toFixed(1)} s`;
    }, { ms: 2500 });
    const p = j.pos, ground = g.world.heightAt(p.x, p.z);
    if (Math.hypot(p.x - home[0], p.z - home[1]) > 30) fails.push(`jet respawn (${name}): ${Math.hypot(p.x - home[0], p.z - home[1]).toFixed(0)} m from the safe spot`);
    if (j.mode !== 'ground' || Math.abs(p.y - 1.6 - ground) > 3) fails.push(`jet respawn (${name}): mode ${j.mode}, ${(p.y - ground).toFixed(1)} m above ground`);
    if (!loaded(p.x, p.z)) fails.push(`jet respawn (${name}): no ground loaded under it`);
    r.note += ` · ${j.mode}, ${(p.y - ground).toFixed(2)} m above ground`;
  }
  if (want('home')) {
    g.vehicles.switchTo('car');
    await place(home[0] + 3500, home[1]);
    await measure('H go home (3.5 km)', async () => {
      g.sessionSpawn.goHome(); await sleep(50);
      await until(() => !g.sessionSpawn.blocked, 60000, 'go home');
      checkPaint('H go home');
    }, { ms: 2000 });
  }
  return { rows, fails, notes };
}
