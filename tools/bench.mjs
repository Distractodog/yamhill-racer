// Fixed-spot frame-time benchmark. node tools/bench.mjs
// Needs the preview server: python3 tools/serve.py 8173 game  then http://127.0.0.1:8173
// Headless Chrome, 1280×760, camera mode 0 (chase), no driving input, 20 s at each spot.
// Compare runs with each other: headless Chrome is slower than a real browser.
//
// Spots are world metres (x east, z south). Yaw faces along the street (fx = sin(yaw), fz = cos(yaw)).
// Surface class is the one teleport uses to sit on that road. The campus drive in front of the
// Main Building is gravel (class 4); the three town streets are asphalt (class 3).
//
//   McMinnville downtown, NE 3rd St:     x=19451  z=-11032  yaw=-1.573  cam=0  surface=3
//   Sheridan, East Main St:              x=3794   z=1288    yaw=-1.834  cam=0  surface=3
//   Willamina, Main St (OR 18 Business): x=-3306  z=3499    yaw=2.008   cam=0  surface=3
//   Campus, Main Building front drive:   x=-542   z=440     yaw=1.800   cam=0  surface=4
import puppeteer from 'puppeteer-core';

const SPOTS = [
  { name: 'McMinnville NE 3rd St', x: 19451, z: -11032, yaw: -1.573, cls: 3, cam: 0 },
  { name: 'Sheridan East Main St', x: 3794, z: 1288, yaw: -1.834, cls: 3, cam: 0 },
  { name: 'Willamina Main St', x: -3306, z: 3499, yaw: 2.008, cls: 3, cam: 0 },
  { name: 'Campus Main Building', x: -542, z: 440, yaw: 1.800, cls: 4, cam: 0 },
];
const SAMPLE_MS = 20000;

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
page.setDefaultTimeout(180000);
const pageErrors = [];
page.on('pageerror', e => { pageErrors.push(e.message); console.log('PAGE ERROR', e.message); });
await page.evaluateOnNewDocument(() => localStorage.setItem('yr-welcome-hidden-1', '1'));
await page.goto('http://127.0.0.1:8173/', { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.game && game.world.pendingTiles() === 0, { timeout: 90000 });

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

console.log('spot                      tris   calls   median    p95   >20ms     n   end x,z');
for (const spot of SPOTS) {
  const row = await page.evaluate(async (spot, sampleMs) => {
    const g = window.game, car = g.car;
    for (let k = 0; k < 100 && !(g.world.loadedAt(spot.x, spot.z) && g.world.pendingTiles() === 0); k++) {
      car.pos.set(spot.x, car.pos.y, spot.z);
      car.vel.set(0, 0, 0);
      car._lastLoaded = null;
      await new Promise(r => setTimeout(r, 200));
    }
    if (!g.world.loadedAt(spot.x, spot.z) || g.world.pendingTiles() !== 0) {
      return { error: 'tiles did not finish loading' };
    }
    g.teleport(spot.x, spot.z, spot.cls);
    car.reset(spot.x, spot.z, spot.yaw);
    car.vel.set(0, 0, 0);
    car.safe = [];
    g.setCam(spot.cam);
    await new Promise(r => setTimeout(r, 2000));
    const dts = [], tris = [], calls = [];
    await new Promise(done => {
      let last = performance.now(), t0 = last, first = true;
      const tick = now => {
        const dt = now - last; last = now;
        if (!first) {
          dts.push(dt);
          tris.push(g.renderer.info.render.triangles);
          calls.push(g.renderer.info.render.calls);
        }
        first = false;
        if (now - t0 < sampleMs) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    const q = car.quat;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
    return {
      dts, tris, calls,
      x: car.pos.x, z: car.pos.z, yaw, surf: g.world.surfaceAt(car.pos.x, car.pos.z),
    };
  }, spot, SAMPLE_MS);
  if (row.error) {
    console.log(spot.name, 'FAILED', row.error);
    await browser.close();
    process.exit(1);
  }
  const dts = row.dts.slice().sort((a, b) => a - b);
  const tri = row.tris.slice().sort((a, b) => a - b);
  const call = row.calls.slice().sort((a, b) => a - b);
  const slow = row.dts.filter(dt => dt > 20).length;
  const med = pct(dts, 0.5), p95 = pct(dts, 0.95);
  const pad = (s, n) => String(s).padStart(n);
  console.log(
    spot.name.padEnd(24) +
    pad(Math.round(pct(tri, 0.5)), 8) +
    pad(Math.round(pct(call, 0.5)), 8) +
    pad(med.toFixed(1), 8) + ' ms' +
    pad(p95.toFixed(1), 6) +
    pad((100 * slow / row.dts.length).toFixed(1) + '%', 8) +
    pad(row.dts.length, 6) +
    `   ${row.x.toFixed(0)},${row.z.toFixed(0)} yaw ${row.yaw.toFixed(3)} surf ${row.surf}`
  );
}
if (pageErrors.length) {
  console.log('PAGE ERRORS', pageErrors.length);
  await browser.close();
  process.exit(1);
}
await browser.close();
