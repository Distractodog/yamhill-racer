// Director: serve game/ at YR_URL (default http://127.0.0.1:8173), then run through the heavy gate:
//   node tools/picker_shots.mjs --out /tmp/yr-picker
// The V picker in the real game (start-up: tools/lib/startgame.mjs). Screenshots (review them):
//   picker-car.png            open on the car (current card highlighted, car types row under it)
//   picker-aircraft-types.png keyboard → Aircraft card, ↓ into its type row
//   picker-new-type-paint.png after choosing the Prop plane with Enter and a blue body paint: its card and chip
//   picker-mouse-bike.png     opened from ☰ Menu → Vehicles, Bike card hovered (bike types)
//   picker-race-locked.png    during a car race: type chips locked with the race message
//   picker-mobile.png         390 px wide
// Checks: pictures drawn in idle time after start-up (none drawn while opening) and repainted after a paint change,
// the frame time around opening, game keys held off and physics paused while open (single-player), ←/→ ↓ Enter, 1–3,
// V / Esc / click outside close, mouse-only choose from the menu, V never opens the ☰ Menu (nor leaves focus on it for
// Space), type chips locked in a race (race goes on, clock paused while open), an aircraft type swap in flight keeps
// its height, accessible names, no page errors.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, openMenu, watchErrors } from './lib/startgame.mjs';

const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true });
const out = values.out || positionals[0] || '/tmp/yr-picker';
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'picker', errors);
  page.on('console', m => { if (/thumbnail|vehicle thumbnails/.test(m.text())) console.log('CONSOLE', m.text()); });
  await startGame(page, { storage: { 'yr-vtype-1': JSON.stringify({ car: 'race', bike: 'dirt', jet: 'fighter' }) } });
  const shot = name => page.screenshot({ path: `${out}/${name}.png` });
  const state = () => page.evaluate(() => {
    const m = document.getElementById('veh-menu'), v = game.vehicles.current;
    return { open: game.vehicles.open, visible: !!m && !m.hidden, driving: `${v.kind}/${game.vehicles.getType(v.kind)}`,
      cur: m.querySelector('.vp-card.cur')?.dataset.kind, sel: m.querySelector('.vp-card.sel')?.dataset.kind,
      row: [...m.querySelectorAll('.vp-row')].find(r => !r.hidden)?.dataset.kind,
      chips: [...m.querySelectorAll('.vp-row:not([hidden]) .vp-chip')].map(c => c.dataset.type + (c.classList.contains('cur') ? '*' : '') + (c.classList.contains('sel') ? '<' : '')),
      empty: m.querySelectorAll('.vp-empty').length, focus: document.activeElement?.getAttribute('aria-label') || document.activeElement?.id || '',
      names: [...m.querySelectorAll('.vp-card .vp-name')].map(n => n.textContent) };
  });
  const menuOpen = () => page.$eval('#menu-panel', el => !el.hidden);
  const press = async (...codes) => { for (const c of codes) { await page.keyboard.press(c); await wait(60); } };

  // 1. pictures: drawn in idle time once the warm-up is done, before anyone opens the picker
  const t0 = Date.now();
  await page.waitForFunction(() => game.vehicleThumbs.started && game.vehicleThumbs.pending === 0, { timeout: 120000, polling: 200 });
  console.log(`pictures drawn ${(Date.now() - t0) / 1000}s after start-up${await page.evaluate(() => game.vehicleThumbs.failed) ? ' (WEBGL FAILED: icons only)' : ''}`);

  // 2. open on the car: frame times around opening (nothing is drawn in 3D on open)
  const frames = await page.evaluate(async () => {
    const d = []; let last = performance.now();
    await new Promise(r => { const f = now => { d.push(now - last); last = now; if (d.length < 40) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f);
      setTimeout(() => dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', bubbles: true })), 250); });
    return { max: Math.max(...d.slice(2)).toFixed(1), median: d.slice(2).sort((a, b) => a - b)[Math.floor(d.length / 2)].toFixed(1) };
  });
  console.log(`frames around opening: median ${frames.median} ms, worst ${frames.max} ms`);
  let s = await state(); console.log('open on car:', JSON.stringify(s));
  assert(s.open && s.visible && s.cur === 'car' && s.sel === 'car' && s.row === 'car', 'opens on the car, car types under it');
  assert.equal(s.empty, 0, 'every picture is drawn');
  assert.deepEqual(s.chips, ['race*', 'sports', 'hatch', 'suv', 'truck']);
  assert(/^Car: Race car\. Key 1\. Top speed \d of 5/.test(s.focus), `focused card has an accessible name (${s.focus})`);
  await page.keyboard.down('KeyW'); await wait(150);
  assert.equal(await page.evaluate(() => !!(game.keys.has('KeyW') || game.input.throttle)), false, 'game keys held off while open');
  await page.keyboard.up('KeyW');
  // single-player: physics paused while it's open (a push doesn't move the car)
  const moved = await page.evaluate(async () => {
    const v = game.vehicles.current, x = v.pos.x, z = v.pos.z; v.vel.set(0, 0, 15);
    await new Promise(r => setTimeout(r, 400)); const d = Math.hypot(v.pos.x - x, v.pos.z - z); v.vel.set(0, 0, 0); return d;
  });
  assert(moved < 0.01, `physics paused while open (moved ${moved.toFixed(3)} m)`);
  assert.equal(await menuOpen(), false, 'V did not open the ☰ Menu');
  await shot('picker-car');

  // 3. keyboard: → → to Aircraft, ↓ into its types
  await press('ArrowRight', 'ArrowRight', 'ArrowDown');
  s = await state(); console.log('aircraft types:', JSON.stringify(s));
  assert(s.sel === 'jet' && s.row === 'jet' && s.cur === 'car', 'aircraft selected, car still current');
  assert.deepEqual(s.chips, ['fighter*<', 'stealth', 'prop', 'stunt', 'heli']);
  await shot('picker-aircraft-types');

  // 4. → → to the Prop plane, Enter: vehicle + type in one go; then paint it blue and reopen
  await press('ArrowRight', 'ArrowRight', 'Enter'); await wait(300);
  s = await state(); console.log('after Enter:', JSON.stringify(s));
  assert(!s.open && !s.visible && s.driving === 'jet/prop', 'chose the prop plane and closed');
  await page.evaluate(() => game.cosmetics.set('jet', { body: '#1e88ff' }));
  await page.waitForFunction(() => game.vehicleThumbs.pending === 0, { timeout: 30000, polling: 100 });
  await press('KeyV'); await wait(200);
  s = await state(); console.log('reopened:', JSON.stringify(s));
  assert(s.cur === 'jet' && s.names[2] === 'Prop plane' && s.row === 'jet' && s.chips.includes('prop*'), 'aircraft card current, Prop plane');
  const blue = await page.evaluate(() => {      // the picture really took the new paint: count blue-ish pixels
    const c = document.querySelector('#veh-menu .vp-card[data-kind="jet"] canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && d[i + 2] > 150 && d[i + 2] > d[i] + 60) n++; return n;
  });
  console.log('blue pixels in the aircraft picture:', blue);
  assert(blue > 500, 'aircraft picture repainted blue');
  await shot('picker-new-type-paint');

  // 5. V closes, Esc closes, a click outside closes; 1–3 switch at once
  await press('KeyV'); assert.equal((await state()).visible, false, 'V closes');
  await press('KeyV', 'Escape'); assert.equal((await state()).visible, false, 'Esc closes');
  await press('KeyV'); await page.mouse.click(8, 790); await wait(100); assert.equal((await state()).visible, false, 'click outside closes');
  await press('KeyV', 'Digit2'); await wait(200);
  s = await state(); assert(!s.visible && s.driving === 'bike/dirt', `2 switches to the bike (${s.driving})`);
  // V with the ☰ Menu button focused (after using the menu): opens only the picker, and closing leaves focus off the
  // menu button so Space stays the handbrake
  await page.focus('#menu-button');
  await press('KeyV'); assert(((await state()).visible) && !(await menuOpen()), 'V with the menu button focused: picker only');
  await press('KeyV');
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'menu-button', 'V close: focus not left on the menu button');
  await press('Space'); assert.equal(await menuOpen(), false, 'Space after the picker does not open the ☰ Menu');

  // 6. mouse only: ☰ Menu → Vehicles (Esc gives focus back to the menu button), then hover the Bike card, click Sport bike
  await openMenu(page); await page.click('#vehicles-button'); await wait(200);
  assert((await state()).visible && !(await menuOpen()), 'menu item opens the picker, menu closed');
  await press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'menu-button', 'Esc: focus back on the menu button');
  await openMenu(page); await page.click('#vehicles-button'); await wait(200);
  s = await state(); assert(s.visible && s.cur === 'bike', 'opened from the menu');
  await page.hover('#veh-menu .vp-card[data-kind="car"]'); await wait(100);
  assert.equal((await state()).row, 'car', 'hovering a card shows its types');
  await page.hover('#veh-menu .vp-card[data-kind="bike"]'); await wait(100);
  await shot('picker-mouse-bike');
  await page.click('#veh-menu .vp-chip[data-type="sport"]'); await wait(300);
  s = await state(); assert(!s.visible && s.driving === 'bike/sport', `clicked Sport bike (${s.driving})`);
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), 'menu-button', 'chosen: back to driving, focus off the menu');
  assert.equal(await menuOpen(), false);

  // 6b. a car race: the type chips are locked (the race goes on), the race clock is paused while it's open
  await page.evaluate(() => game.challenges.start(game.challenges.list.findIndex(c => c.id === 'long-walk')));
  await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 120000 });
  await press('KeyV'); await wait(100);
  const t0r = await page.evaluate(() => game.challenges.time); await wait(500);
  const t1r = await page.evaluate(() => game.challenges.time);
  assert(Math.abs(t1r - t0r) < 0.01, `race clock paused while open (${t0r} → ${t1r})`);
  await press('ArrowDown', 'ArrowRight', 'Enter'); await wait(100);
  const race = await page.evaluate(() => ({ open: game.vehicles.open, type: game.vehicles.getType('car'), state: game.challenges.state,
    lock: document.getElementById('vp-lock')?.textContent, lockShown: !document.getElementById('vp-lock')?.hidden,
    disabled: [...document.querySelectorAll('#veh-menu .vp-row:not([hidden]) .vp-chip')].every(c => c.getAttribute('aria-disabled') === 'true') }));
  console.log('race:', JSON.stringify(race));
  assert(race.open && race.type === 'race' && race.state === 'running' && race.lockShown && race.disabled, 'type locked in a race, race goes on');
  await page.click('#veh-menu .vp-chip[data-type="suv"]'); await wait(100);
  assert.equal(await page.evaluate(() => `${game.vehicles.getType('car')} ${game.vehicles.open} ${game.challenges.state}`), 'race true running', 'clicked chip: still locked');
  await shot('picker-race-locked');
  await press('Escape'); await page.evaluate(() => game.challenges.quit());
  await page.waitForFunction(() => game.challenges.state === 'idle', { timeout: 10000 });

  // 7. in flight: an aircraft type chosen in the picker keeps flying at the same height
  await page.evaluate(() => { game.vehicles.choose('jet', 'fighter'); const v = game.vehicles.current, p = v.pos; v.placeInAir(p.x, game.world.heightAt(p.x, p.z) + 400, p.z, 0, 500); });
  await wait(300);
  const before = await page.evaluate(() => game.vehicles.current.pos.y);
  await press('KeyV', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'Enter'); await wait(100);
  const after = await page.evaluate(() => ({ y: game.vehicles.current.pos.y, mode: game.vehicles.current.mode, type: game.vehicles.getType('jet') }));
  console.log('in flight:', before.toFixed(1), '→', JSON.stringify(after));
  assert(after.type === 'stunt' && after.mode === 'air' && Math.abs(after.y - before) < 30, 'stunt plane takes over in the air');

  // 8. small screen
  await page.setViewport({ width: 390, height: 844 }); await press('KeyV'); await wait(200);
  assert.equal(await page.$eval('#veh-menu .vp-panel', el => el.getBoundingClientRect().right <= innerWidth), true, 'fits 390 px');
  await shot('picker-mobile'); await press('Escape');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`PASS picker shots → ${out}`);
} finally {
  await browser.close();
}
