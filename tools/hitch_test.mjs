// Frame-time hitches on V switches, Garage type changes, R resets, crash respawns and H (go home), in the real game.
//   python3 tools/serve.py 8173 game            (another terminal)
//   node tools/hitch_test.mjs [--out after.json] [--before before.json] [--only switch,types,garage,reset,crash,home]
//                             [--strict] [--headful]
// Start-up via tools/lib/startgame.mjs (campus spawn, all three vehicles painted black), then tools/lib/hitchprobe.mjs:
// for each action the worst main-thread ms of the game's frame callback in the next ~1.2 s (split: renderer.render,
// world.updateLOD), the worst rAF interval, shader programs compiled, frames over 50 ms. Run it on main and on this
// branch (or point YR_URL at another server) and pass --before to print the two side by side.
// Fails on page errors and on the probe's own checks (paint on the first frame, respawns on loaded ground at the right
// height). Target: no frame over 50 ms after the first use of each thing (first use ideally too); --strict fails on it.
// Headless Chrome is slower than a real browser, so compare runs on the same machine.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';
import { hitchSuite } from './lib/hitchprobe.mjs';
import { VEHICLE_TYPES } from '../game/src/vehicletypes.js';

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const only = arg('--only')?.split(',') || null, out = arg('--out'), beforeFile = arg('--before');
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
  report = await page.evaluate(`(${hitchSuite.toString()})(window, ${JSON.stringify({ types, only })})`);
} finally { await browser.close(); }

const before = beforeFile && fs.existsSync(beforeFile) ? JSON.parse(fs.readFileSync(beforeFile, 'utf8')) : null;
const was = label => before?.rows.find(r => r.label === label);
console.table(report.rows.map(r => ({ action: r.label, 'worst ms': r.worst, ...(before ? { 'before ms': was(r.label)?.worst ?? '–' } : {}),
  render: r.render, lod: r.lod, 'rAF ms': r.worstRaf, programs: r.programs, '>50 ms': r.over50, note: r.note })));
report.notes.forEach(n => console.log('note:', n));
// first use of each thing vs. later uses: the label without "(round n)" / the repeated V switches
const seen = new Set(), later = [];
for (const r of report.rows) { const k = r.label.replace(/ \(round \d\)/, ''); if (seen.has(k)) later.push(r); seen.add(k); }
const slowLater = later.filter(r => r.worst > 50), slowAny = report.rows.filter(r => r.worst > 50);
console.log(`worst frame: ${Math.max(...report.rows.map(r => r.worst)).toFixed(1)} ms · over 50 ms: ${slowAny.length} actions (${slowLater.length} after their first use)`);
if (out) { fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), url: process.env.YR_URL || 'http://127.0.0.1:8173/', ...report }, null, 1)); console.log('wrote', out); }
const fails = [...report.fails, ...errors];
if (process.argv.includes('--strict')) fails.push(...slowLater.map(r => `${r.label}: ${r.worst} ms after first use`));
if (fails.length) { console.log('FAIL\n' + fails.join('\n')); process.exit(1); }
console.log('PASS hitch test: no page errors; paint and respawn checks held');
