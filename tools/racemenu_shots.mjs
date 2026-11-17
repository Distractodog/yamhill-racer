// Director: serve game/ at YR_URL (default http://127.0.0.1:8173), then run through the heavy gate:
//   node tools/racemenu_shots.mjs --out /tmp/yr-racemenu
// The J race menu, medals, finish screen and start markers in the real game (start-up: tools/lib/startgame.mjs).
// Screenshots (review them):
//   menu-all.png        J: every race as a card with its route picture, distance, vehicle, ramps / rings, best + medal
//   menu-bike.png       key 2: the Bike filter (only bike cards), first bike race selected
//   menu-card.png       → / ↓ to another card: its description, medal targets and your best under the cards
//   menu-mobile.png     390 px wide
//   finish-medal.png    a race run through every checkpoint: time, medal, personal best, targets, splits, buttons
//   marker.png          free roam near a race start: the glowing start ring on the road
//   marker-opened.png   drove slowly into the ring: that race's card open in the menu
// Checks: one card per race with facts and a drawn route picture (not one flat colour), the filter shows only its
// vehicle, keys move the selection, a click selects and a second click starts, Start / Esc / J, the finish screen's
// medal saved (yr-medals-1) and Next race, the marker opens the right card and only once until you leave it, no
// page errors.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors } from './lib/startgame.mjs';

const { values, positionals } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: true });
const out = values.out || positionals[0] || '/tmp/yr-racemenu';
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
const errors = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' ' + extra : ''}`); if (!ok) failed++; };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'racemenu', errors);
  // a few saved best times (earn gold / silver / no medal at load: medals.importBests)
  const list = await (await fetch(new URL('assets/challenges.json', process.env.YR_URL || 'http://127.0.0.1:8173/'))).json();
  const best = {};
  for (const [id, f] of [['long-walk', 0.99], ['bike-south-loop', 1.1], ['jet-valley-loop', 1.6]]) {
    const c = list.find(r => r.id === id); if (c) best[id] = { time: c.bot * f, splits: [], date: '2026-11-01' };
  }
  await startGame(page, { storage: { 'yr-best-1': JSON.stringify(best) } });
  const shot = name => page.screenshot({ path: `${out}/${name}.png` });
  const press = async (...codes) => { for (const c of codes) { await page.keyboard.press(c); await wait(80); } };
  const menu = () => page.evaluate(() => {
    const m = document.getElementById('ch-menu'), cards = [...m.querySelectorAll('.rm-card')];
    const shown = cards.filter(c => !c.hidden);
    // a route picture is drawn when its canvas is not one flat colour
    const drawn = shown.filter(c => { const cv = c.querySelector('canvas'), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 4; i < d.length; i += 4 * 97) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 30) return true; return false; }).length;
    return { open: game.challenges.menuOpen, visible: !m.hidden, cards: cards.length, shown: shown.map(c => c.dataset.kind), drawn,
      sel: m.querySelector('.rm-card.sel')?.dataset.i, filter: m.querySelector('.rm-tab[aria-selected="true"]')?.dataset.f,
      facts: shown.map(c => c.querySelector('.rm-facts').textContent), won: shown.map(c => c.querySelector('.rm-won').textContent),
      detail: m.querySelector('.rm-detail').textContent.replace(/\s+/g, ' ').trim(), invite: !m.querySelector('.rm-invite').hidden,
      focus: document.activeElement?.className || '' };
  });

  // 1. J: all races as cards
  await press('KeyJ'); await wait(1800);
  let s = await menu(); console.log('menu:', JSON.stringify({ ...s, facts: s.facts.slice(0, 4) }));
  check('J opens the race menu', s.open && s.visible);
  check('one card per race', s.cards === list.length && s.shown.length === list.length, `(${s.cards} / ${list.length})`);
  check('every card says distance · ramps / rings', s.facts.every(f => /·/.test(f) && /(ramp|ring)/.test(f)));
  check('route pictures drawn', s.drawn === s.shown.length, `(${s.drawn} of ${s.shown.length})`);
  check('saved bests earn medals on the cards', s.won.filter(Boolean).length >= 2, JSON.stringify(s.won.filter(Boolean)));
  check('no Invite players in single player', !s.invite);
  await shot('menu-all');

  // 2. filter: Bike (key 2), then Aircraft by clicking its tab
  await press('Digit2'); await wait(300);
  s = await menu();
  check('key 2 = Bike filter, bike cards only', s.filter === 'bike' && s.shown.length > 0 && s.shown.every(k => k === 'bike'), JSON.stringify(s.shown));
  await shot('menu-bike');
  await page.click('#ch-menu .rm-tab[data-f="jet"]'); await wait(300);
  s = await menu();
  check('Aircraft tab click: aircraft cards only', s.filter === 'jet' && s.shown.every(k => k === 'jet'));
  await press('Digit4'); await wait(200);

  // 3. keys move the selection; the detail follows it
  const before = (await menu()).sel;
  await press('ArrowRight', 'ArrowDown'); await wait(300);
  s = await menu();
  check('→ ↓ move the selection', s.sel !== before, `${before} → ${s.sel}`);
  check('detail shows medal targets', /🥇.*🥈.*🥉/.test(s.detail), s.detail.slice(0, 120));
  await shot('menu-card');

  // 4. mouse: click another card selects it (menu stays), Esc closes, J reopens on it
  const target = await page.$('#ch-menu .rm-card[data-i="1"]'); await target.click(); await wait(200);
  s = await menu();
  check('a click selects the card, no race yet', s.sel === '1' && s.open && (await page.evaluate(() => game.challenges.state)) === 'idle');
  await press('Escape'); await wait(200);
  check('Esc closes', !(await menu()).open);
  await press('KeyJ'); await wait(400);
  check('J reopens on the same race', (await menu()).sel === '1');

  // 4b. integration: J closes the other panels (Settings, V picker), the ☰ Menu has Races, ✕ gives focus back to it
  await press('Escape'); await wait(200);
  await press('KeyT'); await wait(300);
  await press('KeyJ'); await wait(300);
  check('J over Settings: Settings closed, race menu open', (await menu()).open && await page.$eval('#settings-panel', el => el.hidden));
  await press('Escape'); await wait(200);
  await press('KeyV'); await wait(300);
  await press('KeyJ'); await wait(300);
  check('J over the V picker: picker closed, race menu open', (await menu()).open && !(await page.evaluate(() => game.vehicles.open)));
  await press('Escape'); await wait(200);
  await page.click('#menu-button'); await page.waitForSelector('#races-button', { visible: true }); await page.click('#races-button'); await wait(300);
  check('☰ Menu → Races opens the race menu', (await menu()).open);
  await page.click('#ch-menu .rm-close'); await wait(200);
  check('✕ gives focus back to the ☰ Menu button', await page.evaluate(() => document.activeElement?.id === 'menu-button'));
  await page.evaluate(() => document.activeElement?.blur());
  await press('KeyJ'); await wait(300);

  // 5. small screen
  await page.setViewport({ width: 390, height: 780 }); await wait(500);
  await shot('menu-mobile');
  await page.setViewport({ width: 1280, height: 800 }); await wait(400);

  // 6. finish screen: start McMinnville downtown sprint from its card (click it twice), run every gate
  const mcm = list.findIndex(c => c.id === 'mcminnville-downtown');
  await page.evaluate(i => game.challenges.raceMenu.select(i), mcm); await wait(100);
  await page.click(`#ch-menu .rm-card[data-i="${mcm}"]`); await wait(300);
  check('second click on the selected card starts it', await page.evaluate(() => ['placing', 'countdown'].includes(game.challenges.state) && !game.challenges.menuOpen));
  await page.waitForFunction(() => game.challenges.state === 'running', { timeout: 120000 });
  // single player: the race menu pauses the run (clock and car) like the V picker
  await wait(500); await press('KeyJ'); await wait(100);
  const t0 = await page.evaluate(() => game.challenges.time); await wait(1200);
  const t1 = await page.evaluate(() => game.challenges.time);
  check('J mid-race (single player) pauses the race clock', (await menu()).open && Math.abs(t1 - t0) < 0.05, `${t0.toFixed(2)} → ${t1.toFixed(2)}`);
  await press('KeyJ'); await wait(200);
  await page.evaluate(async () => {
    const { car, challenges } = window.game, gates = challenges.runInfo().gates;
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    for (let i = 1; i < gates.length; i++) {
      const g = gates[i], fx = Math.sin(g.yaw), fz = Math.cos(g.yaw);
      for (const d of [-4, 3]) { car.pos.set(g.x + fx * d, g.y ?? car.pos.y, g.z + fz * d); car.vel.set(0, 0, 0); await frame(); await frame(); }
    }
  });
  await page.waitForFunction(() => game.challenges.state === 'finished', { timeout: 20000 });
  await wait(600);
  const done = await page.evaluate(() => {
    const d = document.getElementById('ch-done');
    return { shown: getComputedStyle(d).display !== 'none', html: d.innerHTML, splits: d.querySelectorAll('.ch-splits div').length,
      result: game.challenges.result, saved: localStorage.getItem('yr-medals-1') };
  });
  console.log('finish:', JSON.stringify({ ...done, html: undefined }));
  check('finish screen shows', done.shown);
  check('medal earned and shown', /ch-medal (gold|silver|bronze)/.test(done.html) && !!done.result?.medal, done.result?.medal);
  check('medal saved per browser', JSON.parse(done.saved || '{}')['mcminnville-downtown'] === done.result?.medal);
  check('personal best, targets, splits', /Personal best/.test(done.html) && /ch-targets/.test(done.html) && done.splits >= 2, `(${done.splits} split rows)`);
  check('Race again + Next race buttons', /data-action="retry"/.test(done.html) && /data-action="next"/.test(done.html));
  await shot('finish-medal');
  await page.click('#ch-done [data-action="next"]'); await wait(300);
  const nextId = await page.evaluate(() => game.challenges.runInfo()?.id);
  check('Next race starts the next race', !!nextId && nextId !== 'mcminnville-downtown', nextId);
  await press('Escape'); await wait(300);

  // 7. start marker: free roam 45 m before the Sheridan river loop's start, looking at it; then roll in slowly
  const sh = list.find(c => c.id === 'sheridan-river-loop'), fx = Math.sin(sh.start.yaw), fz = Math.cos(sh.start.yaw);
  await holdCar(page, { x: sh.start.x - fx * 45, z: sh.start.z - fz * 45, yaw: sh.start.yaw, kind: 'car' });
  await wait(1500);
  const mk = await page.evaluate(id => {
    const m = game.challenges.markers.markers.find(m => m.races.some(i => game.challenges.list[i].id === id));
    return { visible: m?.grp.visible, placed: m?.placed, y: m?.grp.position.y };
  }, sh.id);
  check('start ring shown near the start', mk.visible && mk.placed, JSON.stringify(mk));
  await shot('marker');
  await page.evaluate(async (x, z, yaw) => {          // drive in at walking pace
    const car = game.vehicles.current, frame = () => new Promise(r => requestAnimationFrame(() => r()));
    for (let k = 0; k <= 30 && !game.challenges.menuOpen; k++) {
      const d = 45 - k * 1.5; car.pos.set(x - Math.sin(yaw) * d, car.pos.y, z - Math.cos(yaw) * d); car.vel.set(Math.sin(yaw) * 3, 0, Math.cos(yaw) * 3);
      await frame(); await frame();
    }
  }, sh.start.x, sh.start.z, sh.start.yaw);
  await wait(800);
  s = await menu();
  check('driving into the ring opens that race\'s card', s.open && list[+s.sel]?.start.x === sh.start.x, list[+s.sel]?.id);
  await shot('marker-opened');
  await press('Escape'); await wait(400);
  check('…and not again while still inside', !(await menu()).open);
} catch (e) { console.log('FAIL', e.stack || e); failed++; }
finally { await browser.close(); }
if (errors.length) { console.log('page errors:', errors); failed++; }
console.log(failed ? `${failed} FAILED` : 'ALL PASS', '· screenshots in', out);
process.exit(failed ? 1 : 0);
