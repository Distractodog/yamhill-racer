// Streaming test: carries the car west → east across the whole map at a set speed and counts frames where the
// ground under it hadn't loaded yet, plus slow frames. node tools/stream_test.mjs [km/h, default 1000] (needs the preview server)
// Also: frames drawn while a road block within its near level's distance still lacked that level (the far version
// showing up close: must be 0; roadnear.js builds it ahead), and how many were built at once (in the frame they were
// needed, a cost but not a pop-in). Exits 1 on frames with no ground, late road levels or page errors.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
let pageErrors = 0;
page.on('pageerror', e => { pageErrors++; console.log('PAGE ERROR', e.message); });
await page.goto('http://127.0.0.1:8173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.game && game.world.pendingTiles() === 0, { timeout: 90000 });
// carry the car west → east across the whole map at 1000 km/h (278 m/s), z = 1500, and watch the streaming keep up
const KMH = +(process.argv[2] || 1000);
await page.evaluate(() => { game.car.reset(-4800, 1500, Math.PI / 2); game.car.safe = []; });
await page.waitForFunction(() => game.world.loadedAt(-4800, 1500) && game.world.pendingTiles() === 0, { timeout: 90000 });
const r = await page.evaluate(KMH => new Promise(done => {
  const g = game, c = g.car, V = KMH / 3.6, forced0 = g.world.stream?.roadNear?.forced ?? null;
  // just before each frame is drawn: a road block left without its near level (lod.userData.near) inside the
  // distance the near level is drawn at (three.js LOD: camera to the LOD's position)
  let lateFrames = 0, lateBlocks = 0;
  const render = g.renderer.render.bind(g.renderer), cam = g.camera.position;
  g.renderer.render = (scene, camera) => {
    let late = 0;
    for (const tile of g.world.group.children) if (tile.visible) for (const o of tile.children)
      if (o.isLOD && o.userData.near && Math.hypot(cam.x - o.position.x, cam.y - o.position.y, cam.z - o.position.z) < o.userData.near.show) late++;
    if (late) { lateFrames++; lateBlocks = Math.max(lateBlocks, late); }
    return render(scene, camera);
  };
  let last = performance.now(), frames = 0, slow = 0, worst = 0, missing = 0, bounced = 0, x = -4800;
  const tick = now => {
    const dt = Math.min(0.1, (now - last) / 1000); last = now; frames++;
    if (dt > 1 / 30) slow++; worst = Math.max(worst, dt);
    x += V * dt;
    if (!g.world.loadedAt(x, 1500)) { missing++; if (!window._m) window._m = []; window._m.push([Math.round(x), g.world.pendingTiles(), g.world.loadedTiles()]); }
    if (frames % 30 === 0) (window._log ||= []).push([Math.round(x), g.world.pendingTiles(), g.world.loadedTiles(), Math.round(1/dt)]);
    c.pos.set(x, g.world.heightAt(x, 1500) + 0.6, 1500); c.vel.set(V, 0, 0);
    if (Math.abs(c.pos.x - x) > 1) bounced++;
    if (x < 4800) requestAnimationFrame(tick);
    else {
      g.renderer.render = render;
      done({ frames, slow, worstMs: Math.round(worst * 1000), framesWithNoGroundUnderCar: missing, secs: 9600 / V,
        framesWithRoadNearLate: lateFrames, mostLateBlocks: lateBlocks,
        roadNearBuiltAtOnce: forced0 === null ? 'n/a (code without roadnear.js)' : g.world.stream.roadNear.forced - forced0 });
    }
  };
  requestAnimationFrame(tick);
}), KMH);
console.log(KMH, 'km/h', r);
await browser.close();
const fail = r.framesWithNoGroundUnderCar > 0 || r.framesWithRoadNearLate > 0 || pageErrors > 0;
if (fail) console.log('FAIL', r.framesWithNoGroundUnderCar ? `${r.framesWithNoGroundUnderCar} frames with no ground` : '', r.framesWithRoadNearLate ? `${r.framesWithRoadNearLate} frames with a road near level late` : '', pageErrors ? `${pageErrors} page errors` : '');
process.exit(fail ? 1 : 0);
