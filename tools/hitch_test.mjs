// Frame-time hitches on V switches, Garage type changes, R resets, crash respawns and H (go home), in the real game.
//   python3 tools/serve.py 8173 game            (another terminal)
//   node tools/hitch_test.mjs [--out after.json] [--before before.json] [--repeat 3]
//                             [--only switch,types,garage,reset,crash,crashnear,crashfar,home] [--strict] [--headful]
// Start-up via tools/lib/startgame.mjs (campus spawn, all three vehicles painted black), then tools/lib/hitchprobe.mjs:
// each action `repeat` times (V switches; every car / bike / aircraft type, by code and through the Garage's Type
// menu; R near and 5 km out and back; jet crash respawns near and 5 km out and back; H from 5 km). For each: the worst
// main-thread ms of the game's frame callback in the following ~1–2 s (split: renderer.render, world.updateLOD, the
// biggest other system), shader programs compiled, GPU uploads, the slowest tile-build step, frames over 50 ms.
// Run it on main (--out before.json) and on this branch (--before before.json): the summary prints, per action, the
// worst frame on first use and over the later repeats, before and after.
// Fails on page errors and on the probe's own checks (paint on the first frame, respawns on loaded ground at their
// spot at the right height). Target: no frame over 50 ms after the first use; --strict fails on it.
// Headless Chrome is slower than a real browser, so compare runs on the same machine.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';
import { hitchSuite } from './lib/hitchprobe.mjs';
import { VEHICLE_TYPES } from '../game/src/vehicletypes.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const only = arg('--only')?.split(',') || null, out = arg('--out'), beforeFile = arg('--before'), repeat = +arg('--repeat', 3);
const types = Object.fromEntries(Object.entries(VEHICLE_TYPES).map(([k, list]) => [k, list.map(t => t.id)]));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.argv.includes('--headful') ? false : 'new', args: ['--window-size=1280,800', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const errors = [];
let report;
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  watchErrors(page, 'game', errors);
  const t0 = Date.now();
  await startGame(page);
  console.log(`game started in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  page.setDefaultTimeout(0);
  report = await page.evaluate(`(${hitchSuite.toString()})(window, ${JSON.stringify({ types, only, repeat })})`);
} finally { await browser.close(); }

console.table(report.rows.map(r => ({ action: r.label, 'worst ms': r.worst, render: r.render, lod: r.lod, top: r.top, programs: r.programs,
  uploads: r.uploads, 'build step': r.step, '>50 ms': r.over50, note: r.note })));
report.notes.forEach(n => console.log('note:', n));
// per action: worst frame on first use (#1) and over the repeats after it, with the --before run's numbers
const summary = rows => {
  const by = new Map();
  for (const r of rows || []) {
    const s = by.get(r.action) || { first: 0, later: null }; by.set(r.action, s);
    if (r.round === 1) s.first = Math.max(s.first, r.worst); else s.later = Math.max(s.later ?? 0, r.worst);
  }
  return by;
};
const now = summary(report.rows), before = beforeFile && fs.existsSync(beforeFile) ? summary(JSON.parse(fs.readFileSync(beforeFile, 'utf8')).rows) : null;
console.table([...now].map(([action, s]) => ({ action, 'first use ms': s.first, 'later ms': s.later ?? '–',
  ...(before ? { 'before: first': before.get(action)?.first ?? '–', 'before: later': before.get(action)?.later ?? '–' } : {}) })));
const slowLater = [...now].filter(([, s]) => s.later > 50), slowAny = [...now].filter(([, s]) => Math.max(s.first, s.later ?? 0) > 50);
console.log(`worst frame: ${Math.max(...report.rows.map(r => r.worst)).toFixed(1)} ms · over 50 ms: ${slowAny.length} actions (${slowLater.length} after their first use)`);
if (out) { fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), url: process.env.YR_URL || 'http://127.0.0.1:8173/', ...report }, null, 1)); console.log('wrote', out); }
const fails = [...report.fails, ...errors];
if (process.argv.includes('--strict')) fails.push(...slowLater.map(([a, s]) => `${a}: ${s.later} ms after first use`));
if (fails.length) { console.log('FAIL\n' + fails.join('\n')); process.exit(1); }
console.log('PASS hitch test: no page errors; paint and respawn checks held');
