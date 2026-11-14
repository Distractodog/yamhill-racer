// Session-only spawn: never restored from storage, even when welcome tips are hidden.
export function createSpawn() {
  let choosing = true, loading = false, spawn = null, api;
  const allowed = new Set(['Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'Digit0', 'Numpad0']);
  addEventListener('keydown', e => {
    if (!choosing && !loading) return;
    if (choosing && !loading && allowed.has(e.code)) return;
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  async function move(x, z) {
    const { world, car, clearKeys } = api;
    loading = true; clearKeys();
    try {
      const deadline = performance.now() + 30000;
      // Move the streaming focus while physics is paused; reset only on loaded ground.
      car.pos.set(x, car.pos.y, z); car.vel.set(0, 0, 0); car._lastLoaded = null;
      car.savePrev(); car.interpolate(0);
      while (!world.loadedAt(x, z) || world.pendingTiles() > 0) {
        if (performance.now() > deadline) throw new Error('Loading took too long. Please choose a point again.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      car.reset(x, z, 0); car.safe = []; car._lastLoaded = null;
    } finally { loading = false; clearKeys(); }
  }
  async function choose(x, z) {
    if (loading) return;
    const { world, minimap, settings } = api;
    if (!world.mapContains(x, z, 10) || (api.rim && !api.rim.contains(x, z))) {
      minimap.pickSpawn(choose, 'Choose a point inside the playable map · scroll to zoom · drag to move');
      return;
    }
    minimap.pickSpawn(choose, 'Loading your starting point…');
    try {
      await move(x, z);
      spawn = [x, z]; choosing = false;
      minimap.pickSpawn(null); minimap.toggle(false);
      settings.showWelcome();
    } catch (error) { minimap.pickSpawn(choose, error.message); }
  }
  return {
    get blocked() { return choosing || loading; },
    get point() { return spawn && [...spawn]; },
    start(deps) {
      api = deps;
      deps.settings.closeWelcome();
      deps.minimap.pickSpawn(choose);
    },
    async goHome() {
      if (!spawn || choosing || loading) return;
      api.challenges.quit();
      try { await move(...spawn); }
      catch { choosing = true; api.minimap.pickSpawn(choose, 'Could not load your spawn. Choose a starting point again.'); }
    },
  };
}
