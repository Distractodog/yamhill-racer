// Headless browser check of the vehicles + their races (needs the preview server on 127.0.0.1:8173):
//   node tools/vehicles_test.mjs <screenshot folder>
// V picker → bike (wheelie), bike race start, jet ring race (take-off, ring, crash → air respawn), V mid-race quits it,
// back to the car; page errors and fps.
import puppeteer from 'puppeteer-core';
const OUT = process.argv[2] || '.';
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,760', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 760 });
const errs = [];
page.on('pageerror', e => { errs.push(e.message); console.log('PAGE ERROR', e.message); });
await page.goto('http://127.0.0.1:8173/', { waitUntil: 'load' });
await page.evaluate(() => { localStorage.removeItem('yr-vehicle-1'); });
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => window.game && window.game.world.pendingTiles() === 0, { timeout: 120000 });
const wait = ms => new Promise(r => setTimeout(r, ms));
const st = () => page.evaluate(() => { const v = game.vehicles.current; return `${v.kind}${v.mode ? '/' + v.mode : ''} ${Math.round(v.vel.length() * 3.6)} km/h · race ${game.challenges.state} · line "${document.getElementById('veh-line')?.textContent}" · msg "${document.getElementById('veh-msg')?.textContent}"`; });
const startRace = async id => {
  await page.evaluate(id => game.challenges.start(game.challenges.list.findIndex(c => c.id === id)), id);
  await page.waitForFunction(() => game.challenges.state === 'countdown', { timeout: 90000 });
};
const fps = () => page.evaluate(async () => { let n = 0, slow = 0, last = performance.now(); const t0 = last; await new Promise(r => { function f(now) { n++; if (now - last > 25) slow++; last = now; if (now - t0 < 3000) requestAnimationFrame(f); else r(); } requestAnimationFrame(f); }); return `${(n / 3).toFixed(0)} fps, ${slow} slow frames`; });

// 1. bike race: South woods loop
await startRace('bike-south-loop');
console.log('bike race countdown:', await st());
await page.evaluate(() => game.keys.add('KeyW'));
await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 10000 });
await wait(2500);
console.log('bike race running:', await st(), '·', await fps());
await page.screenshot({ path: OUT + '/bike-race.png' });
await page.evaluate(() => game.keys.delete('KeyW'));
// 2. V mid-race → jet: the race ends
await page.keyboard.press('KeyV'); await wait(200); await page.keyboard.press('Digit3'); await wait(500);
console.log('after V→3 mid-race:', await st());
// 3. jet race: Valley loop
await startRace('jet-valley-loop');
await page.evaluate(() => game.keys.add('KeyW'));
await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 10000 });
await page.waitForFunction(() => game.car.vel.length() * 3.6 > 245, { timeout: 15000 });
await page.evaluate(() => game.keys.add('ArrowDown')); await wait(900); await page.evaluate(() => game.keys.delete('ArrowDown'));
await wait(2500);
console.log('jet airborne:', await st());
await page.screenshot({ path: OUT + '/jet-climb.png' });
// put it just before ring 1 so it flies through, then crash it on purpose
await page.evaluate(() => { const g = game.challenges.list.find(c => c.id === 'jet-valley-loop').gates[1]; game.car.placeInAir(g.x - Math.sin(g.yaw) * 220, g.y, g.z - Math.cos(g.yaw) * 220, g.yaw, 450); });
await wait(1000);
await page.screenshot({ path: OUT + '/jet-ring.png' });
await wait(1500);
console.log('after ring 1:', await st(), 'next gate', await page.evaluate(() => game.challenges.next));
await page.evaluate(() => { game.keys.delete('KeyW'); game.keys.add('ArrowUp'); });     // dive into the ground
await page.waitForFunction(() => game.vehicles.current.mode === 'crashed', { timeout: 20000 });
await page.evaluate(() => game.keys.delete('ArrowUp'));
await wait(600);
console.log('crashed:', await st());
await page.screenshot({ path: OUT + '/jet-crash.png' });
await page.waitForFunction(() => game.vehicles.current.mode === 'air', { timeout: 6000 });
console.log('respawned:', await st(), 'height above ground', await page.evaluate(() => Math.round(game.car.pos.y - game.world.heightAt(game.car.pos.x, game.car.pos.z))));
await wait(1200);
await page.screenshot({ path: OUT + '/jet-respawn.png' });
console.log('jet ·', await fps());
// 4. back to the car via V
await page.keyboard.press('Escape'); await wait(300);
await page.keyboard.press('KeyV'); await wait(200); await page.keyboard.press('Digit1'); await wait(800);
await page.evaluate(() => game.keys.add('KeyW')); await wait(1500); await page.evaluate(() => game.keys.delete('KeyW'));
console.log('car again:', await st());
await page.screenshot({ path: OUT + '/car-again.png' });
console.log('page errors:', errs.length);
await browser.close();
