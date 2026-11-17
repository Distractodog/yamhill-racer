// Director browser check of the engine sounds (no listening possible): serve game/ on 127.0.0.1:8173, then
//   node tools/sound_check.mjs [--out /tmp/yr-sound]
// Starts the sound with a key press, puts you in every vehicle type in turn (throttle held, then released), and logs
// for each: which engine loops loaded (file, bytes, seconds, sample rate, ms to fetch + decode), the engine voice's
// state (rpm, gear, live sources), the AudioContext state and the Settings → Sound levels; page errors, failed requests
// and audio warnings. Also moves the Engines slider, checks it is saved, and screenshots Settings → Sound.
// Exits 1 on page errors, failed loads, a type with no engine sound, or a type that loaded another type's files.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : '/tmp/yr-sound';
const URL0 = process.env.YR_URL || 'http://127.0.0.1:8173/';
fs.mkdirSync(out, { recursive: true });
const TYPES = { car: ['race', 'sports', 'hatch', 'suv', 'truck'], bike: ['dirt', 'sport'], jet: ['fighter', 'stealth', 'prop', 'stunt', 'heli'] };
const wait = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new', args: ['--window-size=1280,800', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'] });
const errors = [], failed = [], warnings = [], results = [];
let ok = true;
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.message); });
  page.on('requestfailed', r => { if (!/favicon|cloudflareinsights/.test(r.url())) failed.push(`${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) failed.push(`${r.url()} HTTP ${r.status()}`); });
  page.on('console', m => { const t = m.text(); if (/engine sound|audio/i.test(t) && m.type() !== 'log') warnings.push(t); if (m.type() === 'error' && !/favicon|cloudflareinsights/.test(t + (m.location()?.url || ''))) errors.push(t); });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('yr-welcome-hidden-1', '1'); localStorage.removeItem('yr-sound-1');
    Object.defineProperty(navigator, 'getGamepads', { value: () => [] });
  });
  await page.goto(URL0, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.game?.sessionSpawn, { timeout: 120000 });
  if (await page.evaluate(() => game.sessionSpawn.blocked)) {
    await page.waitForSelector('#fullmap.open canvas', { visible: true });
    const box = await (await page.$('#fullmap canvas')).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(() => !game.sessionSpawn.blocked, { timeout: 120000 });
  }
  await page.evaluate(() => { document.getElementById('welcome-start')?.click(); game.minimap.toggle(false); game.challenges.quit(); });
  await page.waitForFunction(() => game.world.pendingTiles() === 0, { timeout: 120000 });
  await page.keyboard.press('KeyU'); await page.keyboard.press('KeyU');     // a real key press: starts the sound (units toggled back)
  const ctxState = await page.evaluate(() => game.audio.ctx?.state);
  console.log(`AudioContext: ${ctxState}`);
  if (!game_ok(ctxState === 'running' || ctxState === 'suspended', 'no AudioContext after a key press')) ok = false;
  const start = await page.evaluate(() => [game.car.pos.x, game.car.pos.z, game.car.heading()]);
  for (const [kind, ids] of Object.entries(TYPES)) for (const type of ids) {
    const r = await page.evaluate(async ({ kind, type, start }) => {
      const g = game, sleep = ms => new Promise(res => setTimeout(res, ms)), a = g.audio;
      const before = (await import('./src/audio/engines.js')).soundLog.length;
      if (!g.vehicles.choose(kind, type)) return { kind, type, error: 'could not choose' };
      g.vehicles.current.reset(...start);
      g.keys.add('KeyW'); await sleep(2500);
      const on = { rpm: a.engine?.st.rpm, gear: a.gear, key: a.engine?.key, sources: a.engine?.part?.sources.length, layers: a.engine?.part?.layers?.length ?? null };
      g.keys.delete('KeyW'); await sleep(800);
      const { soundLog } = await import('./src/audio/engines.js');
      return { kind, type, engine: on.key, on, offRpm: a.engine?.st.rpm, kmh: Math.round(g.vehicles.current.vel.length() * 3.6), loaded: soundLog.slice(before), ctx: a.ctx?.state };
    }, { kind, type, start });
    results.push(r);
    const files = (r.loaded || []).map(l => l.error ? `${l.file} ERROR ${l.error}` : `${l.file} ${(l.bytes / 1024).toFixed(0)} KB ${l.seconds?.toFixed(2)} s ${l.rate} Hz ${l.ms} ms`);
    console.log(`${kind}/${type}: engine ${r.engine}, ${r.kmh} km/h, rpm ${Math.round(r.on?.rpm ?? NaN)} (gear ${r.on?.gear}) → ${Math.round(r.offRpm ?? NaN)} off throttle, ` +
      `${r.on?.sources} sources${r.on?.layers != null ? `, ${r.on.layers} loops playing` : ''}; ctx ${r.ctx}\n    loaded now: ${files.length ? files.join('\n                ') : '(nothing new: synthesised or already decoded)'}`);
    if (r.error || r.engine == null) { ok = false; console.log(`  FAIL: ${r.error || 'no engine voice'}`); }
    if ((r.loaded || []).some(l => l.error)) ok = false;
    const own = r.engine && (r.loaded || []).every(l => l.type === r.engine);
    if (!own) { ok = false; console.log('  FAIL: loaded another type\'s loops'); }
    if (r.on?.layers === 0) { ok = false; console.log('  FAIL: loops not playing after 2.5 s'); }
  }
  // Settings → Sound: slider moves the Engines level and is saved
  await page.evaluate(() => { game.vehicles.choose('car', 'race'); document.getElementById('settings-button').click(); });
  await wait(300);
  const slider = await page.evaluate(() => {
    const s = document.getElementById('sound-engines'); s.value = '40'; s.dispatchEvent(new Event('input', { bubbles: true }));
    return { saved: localStorage.getItem('yr-sound-1'), gain: game.audio.mixer?.engines.gain.value, label: s.nextElementSibling.textContent };
  });
  await wait(300);
  slider.gainLater = await page.evaluate(() => game.audio.mixer?.engines.gain.value);
  console.log('Engines slider at 40 %:', JSON.stringify(slider));
  if (!slider.saved || JSON.parse(slider.saved).engines !== 0.4 || Math.abs(slider.gainLater - 0.16) > 0.02) { ok = false; console.log('  FAIL: slider not applied / saved'); }
  await page.evaluate(() => document.getElementById('sound-content').scrollIntoView());
  await page.screenshot({ path: path.join(out, 'settings-sound.png') });
  const total = results.flatMap(r => r.loaded || []).reduce((s, l) => s + (l.bytes || 0), 0);
  console.log(`\nloops fetched: ${results.flatMap(r => r.loaded || []).length} files, ${(total / 1024).toFixed(0)} KB in all`);
} finally {
  fs.writeFileSync(path.join(out, 'sound_check.json'), JSON.stringify({ results, errors, failed, warnings }, null, 2));
  await browser.close();
}
if (warnings.length) console.log('audio warnings:\n  ' + warnings.join('\n  '));
if (failed.length) { ok = false; console.log('failed requests:\n  ' + failed.join('\n  ')); }
if (errors.length) { ok = false; console.log('page errors:\n  ' + errors.join('\n  ')); }
console.log(ok ? `PASS — details in ${out}/sound_check.json; look at ${out}/settings-sound.png` : 'FAIL');
process.exit(ok ? 0 : 1);

function game_ok(cond, msg) { if (!cond) console.log('FAIL:', msg); return cond; }
