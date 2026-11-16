// Frame-time probe for vehicle switches, Garage type changes, R resets, crash respawns and H (go home), run INSIDE the
// game page. hitchSuite is self-contained (no imports, no outside variables) so a puppeteer script can run its source
// with page.evaluate (tools/hitch_test.mjs); it also works on an iframe's window.
//   const report = await hitchSuite(window, { types, only: ['switch', 'garage'], repeat: 3 });
// For each action it records every frame for `settle` ms after it: the game's own frame callback time (main-thread
// ms, split into renderer.render / world.updateLOD / the biggest other systems and 2D-canvas call), the rAF interval,
// shader programs compiled, geometries / textures first uploaded while drawing, and the slowest tile-build step.
// Rows: { label, action (the label without the repeat number), round, worst, render, lod, top, programs, uploads,
// step, worstRaf, frames, over50, note }. The checks it can do on the spot (paint shown at once, respawns placed on
// loaded ground at the chosen spot) go into report.fails.
// types: { car: [ids…], bike: [...], jet: [...] } (vehicletypes.js VEHICLE_TYPES ids, the default first).
// Parts: switch (V, twice round), types (vehicles.setType), garage (the Garage's Type menu, all three tabs), reset
// (R near, R far there and back), crash (jet crash respawns near, and far there and back), home (H after a far R).
// settleWait: how long (ms) to wait for streaming to go quiet before measuring (start, and before each H)
export async function hitchSuite(win, { types = {}, only = null, repeat = 3, paint = '#000000', settle = 1200, settleWait = 30000, log = () => {} } = {}) {
  const g = win.game, doc = win.document, raf = win.requestAnimationFrame.bind(win);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const frames = n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : raf(f)); raf(f); });
  const until = async (ok, ms, what) => { const end = performance.now() + ms; while (!ok()) { if (performance.now() > end) throw Error(`timed out: ${what}`); await sleep(50); } };
  const want = name => !only || only.includes(name);
  const rows = [], fails = [], notes = [];
  // ---- instrumentation
  let last = 0;
  const frameStats = () => ({ cb: 0, render: 0, lod: 0, raf: 0, geo: 0, tex: 0, step: '', parts: {} });
  if (!win.__hitchWrapped) {
    win.__hitchWrapped = true;
    const r = g.renderer, render = r.render.bind(r), lod = g.world.updateLOD, mem = r.info.memory;
    r.render = (s, c) => {
      const t = performance.now(), g0 = mem.geometries, t0 = mem.textures; render(s, c); const fr = win.__hitchFrame;
      if (fr) { fr.render += performance.now() - t; fr.geo += Math.max(0, mem.geometries - g0); fr.tex += Math.max(0, mem.textures - t0); }
    };
    g.world.updateLOD = (...a) => {
      const t = performance.now(); const out = lod(...a); const fr = win.__hitchFrame;
      if (fr) { fr.lod += performance.now() - t; const s = g.world.buildStep; if (s?.ms > 1) fr.step = `${s.label} ${s.ms.toFixed(1)}`; }
      return out;
    };
    // 2D canvas calls (the minimaps): the slowest call of a frame, with its source size for drawImage
    const proto = win.CanvasRenderingContext2D.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const f = Object.getOwnPropertyDescriptor(proto, name).value;
      if (typeof f !== 'function' || name === 'constructor') continue;
      proto[name] = function (...a) {
        const t = performance.now(); const out = f.apply(this, a); const ms = performance.now() - t, fr = win.__hitchFrame;
        if (fr && ms > (fr.parts.__draw || 0)) { fr.parts.__draw = ms; const src = a[0]; fr.drawWhat = name === 'drawImage' ? `drawImage ${src.constructor?.name} ${src.naturalWidth || src.width}x${src.naturalHeight || src.height}` : name; }
        return out;
      };
    }
    // the other per-frame systems main.js calls, timed by name
    for (const [obj, fn] of [['minimap', 'update'], ['world', 'updateShadows'], ['effects', 'update'], ['drivingFX', 'update'], ['directions', 'update'],
      ['pinGuide', 'update'], ['remotes', 'update'], ['challenges', 'update'], ['atmosphere', 'update'], ['cosmetics', 'update'], ['respawnHold', 'update'],
      ['vehicleLights', 'update'], ['garage', 'update'], ['warmup', 'step']]) {
      const o = g[obj], f = o?.[fn]; if (typeof f !== 'function') continue;
      o[fn] = function (...a) { const t = performance.now(); const out = f.apply(this, a); const fr = win.__hitchFrame; if (fr) fr.parts[`${obj}.${fn}`] = (fr.parts[`${obj}.${fn}`] || 0) + performance.now() - t; return out; };
    }
    // physics: every vehicle's 120 Hz step (a long frame is followed by up to 12 catch-up steps)
    for (const veh of new Set([...Object.values(g.vehicles.all), ...(g.vehicles.aircraft || [])])) {
      const f = veh.step;
      veh.step = function (...a) { const t = performance.now(); const out = f.apply(this, a); const fr = win.__hitchFrame; if (fr) fr.parts.physics = (fr.parts.physics || 0) + performance.now() - t; return out; };
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
    const round = +(label.match(/#(\d+)/)?.[1] || 1);
    const row = { label, action: label.replace(/ #\d+/, ''), round, worst: +Math.max(worst.cb, actionMs).toFixed(1), render: +worst.render.toFixed(1), lod: +worst.lod.toFixed(1),
      top: Object.entries(worst.parts).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${k === '__draw' ? `2d ${worst.drawWhat}` : k} ${v.toFixed(1)}`).join(', '),
      programs: programs() - p0, uploads: `${list.reduce((n, f) => n + f.geo, 0)} geo / ${list.reduce((n, f) => n + f.tex, 0)} tex (worst frame ${worst.geo}/${worst.tex})`,
      step: worst.step, action_ms: +actionMs.toFixed(1), worstRaf: +Math.max(0, ...list.slice(1).map(f => f.raf)).toFixed(1), frames: list.length,
      over50: list.filter(f => f.cb > 50).length, note: (typeof result === 'string' ? result : '') || note };
    rows.push(row); log(row);
    return row;
  }
  // ---- paint: the colours of the materials the Garage paints (body role) on the current vehicle, right now
  const bodyHex = () => { const s = new Set(); g.vehicles.current.mesh.traverse(o => { if (o.material?.userData?.cosmeticRole === 'body') s.add('#' + o.material.color.getHexString()); }); return [...s]; };
  // (the race car paints vertex colours, no body material: tools/paint_spawn_test.mjs checks it)
  const checkPaint = what => { const got = bodyHex(); if (got.length && (got.length !== 1 || got[0] !== paint)) fails.push(`${what}: body paint ${got.join(',')} (want ${paint})`); };
  const v = () => g.vehicles.current;
  const loaded = (x, z) => g.world.loadedAt(x, z);
  // like goHome: hold the focus there until the ground is built (all: also wait for every tile in flight)
  const place = async (x, z, yaw = 0, all = true) => {
    const hold = () => { const c = v(); c.pos.set(x, c.pos.y, z); c.vel.set(0, 0, 0); c._lastLoaded = null; c.savePrev(); c.interpolate(0); };
    hold();
    const end = performance.now() + 60000;
    while (!loaded(x, z) || (all && g.world.pendingTiles() > 0)) { if (performance.now() > end) throw Error(`no ground at ${x},${z}`); await sleep(100); hold(); }
    v().reset(x, z, yaw); v().safe = []; v()._lastLoaded = null;
  };
  const waitHold = async () => { const t = performance.now(); while (g.respawnHold?.blocked && performance.now() - t < 60000) await sleep(50); return (performance.now() - t) / 1000; };
  // where a respawn ended vs where it was sent
  const landed = (what, spot, { mode = null, clear = [-0.5, 3] } = {}) => {
    const p = v().pos, ground = g.world.heightAt(p.x, p.z), off = Math.hypot(p.x - spot[0], p.z - spot[1]), up = p.y - ground;
    if (!loaded(p.x, p.z)) fails.push(`${what}: on unloaded ground (${p.x.toFixed(0)}, ${p.z.toFixed(0)})`);
    if (off > 30) fails.push(`${what}: ended ${off.toFixed(0)} m from its spot`);
    if (up < clear[0] || up > clear[1]) fails.push(`${what}: ${up.toFixed(1)} m above the ground`);
    if (mode && v().mode !== mode) fails.push(`${what}: mode ${v().mode}`);
    return ` · ${off.toFixed(0)} m off, ${up.toFixed(2)} m up`;
  };
  // ---- start: paint every kind black (the owner's choice), wait for warm-up if the build has one
  for (const kind of ['car', 'bike', 'jet']) g.cosmetics.set(kind, { body: paint });
  if (g.warmup) { await until(() => g.warmup.done, 20000, 'warm-up').catch(e => notes.push(e.message)); }
  notes.push(`warm-up: ${g.warmup ? (g.warmup.done ? 'done' : 'not finished') : 'none in this build'}`);
  // start from a settled world: no tiles still building in the background
  await until(() => g.world.pendingTiles() === 0, settleWait, 'tiles settled').catch(e => notes.push(e.message));
  const home = [v().pos.x, v().pos.z], far = [home[0] + 5000, home[1] + 300];

  if (want('switch')) for (let i = 1; i <= repeat; i++) for (const kind of ['bike', 'jet', 'car']) {
    const from = v().kind;
    await measure(`V ${from}→${kind} #${i}`, () => { g.vehicles.switchTo(kind); checkPaint(`V switch to ${kind}`); });
  }
  if (want('types')) for (let i = 1; i <= Math.min(repeat, 2); i++) for (const kind of ['car', 'bike', 'jet']) {
    g.vehicles.switchTo(kind);
    const list = types[kind] || [];
    for (const id of [...list.slice(1), list[0]]) await measure(`type ${kind}: ${id} #${i}`, () => { g.vehicles.setType(kind, id); checkPaint(`type ${kind} ${id}`); });
  }
  if (want('garage')) for (const kind of ['car', 'bike', 'jet']) {
    g.vehicles.switchTo(kind); g.garage.show(); await frames(5);
    doc.querySelector(`#cosmetic-garage [data-kind="${kind}"]`)?.click(); await frames(3);
    const select = doc.querySelector('#cosmetic-garage [name="vehicleType"]'), ids = [...select.options].map(o => o.value);
    for (let i = 1; i <= Math.min(repeat, 2); i++) for (const id of [...ids.slice(1), ids[0]]) {
      await measure(`Garage ${kind}: ${id} #${i}`, () => { select.value = id; select.dispatchEvent(new win.Event('input', { bubbles: true })); }, { ms: Math.min(settle, 700) });
    }
    g.garage.close(); await frames(3); checkPaint(`after the Garage (${kind})`);
  }
  if (want('reset')) {
    g.vehicles.switchTo('car'); await place(...home);
    const c = v();
    for (let i = 1; i <= repeat; i++) {
      const near = [home[0] + (i % 2 ? 300 : 0), home[1]];
      c.safe = [[...near, 0]];
      const r = await measure(`R reset near (300 m) #${i}`, () => { c.resetToSafe(); });
      r.note += landed(`near R #${i}`, near);
    }
    // far: 5 km out and back again, the spot not streamed in either way
    for (let i = 1; i <= repeat; i++) {
      const spot = i % 2 ? far : home;
      c.safe = [[...spot, 0]];
      const r = await measure(`R reset far (5 km, not loaded) #${i}`, async () => { c.resetToSafe(); return `held ${(await waitHold()).toFixed(1)} s`; });
      r.note += landed(`far R #${i}`, spot);
    }
    if (repeat % 2) { c.safe = [[...home, 0]]; c.resetToSafe(); await waitHold(); }
  }
  // 'crash' = near + far; 'crashnear' / 'crashfar' = one of them
  const crash = async (label, spot) => {
    const j = v(); j.safe = [[...spot, 0]];
    j.placeInAir(j.pos.x, g.world.heightAt(j.pos.x, j.pos.z) + 200, j.pos.z, Math.PI / 2, 900);
    await frames(10); j.grace = 0; j.crash('impact');          // (a crash within 3 s of the last respawn would only reset it)
    await sleep(300);
    const r = await measure(label, async () => {
      const t = performance.now();
      while ((j.mode === 'crashed' || g.respawnHold?.blocked) && performance.now() - t < 60000) await sleep(16);
      await frames(1); checkPaint(`${label} first frame`);
      return `back after ${((performance.now() - t) / 1000).toFixed(1)} s`;
    }, { ms: 2000 });
    r.note += landed(label, spot, { mode: 'ground' });
  };
  if (want('crash') || want('crashnear')) {
    g.vehicles.switchTo('jet'); await place(...home);
    for (let i = 1; i <= repeat; i++) await crash(`jet crash respawn near #${i}`, home);
  }
  if (want('crash') || want('crashfar')) {
    g.vehicles.switchTo('jet'); await place(...home);
    for (let i = 1; i <= repeat; i++) await crash(`jet crash respawn far (5 km) #${i}`, i % 2 ? far : home);
    if (repeat % 2) { v().safe = [[...home, 0]]; v().resetToSafe(); await waitHold(); }
  }
  if (want('home')) {
    g.vehicles.switchTo('car');
    for (let i = 1; i <= repeat; i++) {
      await place(...far, 0, false);                                                  // out to 5 km (same in every build)
      await until(() => g.world.pendingTiles() === 0, settleWait, 'tiles settled').catch(() => {});
      const r = await measure(`H go home (5 km) #${i}`, async () => {
        g.sessionSpawn.goHome(); await sleep(50);
        await until(() => !g.sessionSpawn.blocked, 60000, 'go home');
        checkPaint('H go home');
      }, { ms: 2000 });
      r.note += landed(`H #${i}`, g.sessionSpawn.point || home);
    }
  }
  return { rows, fails, notes };
}
