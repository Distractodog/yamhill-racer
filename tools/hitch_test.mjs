// Frame-time hitches on V switches, Garage type changes, R resets, crash respawns and H (go home), in the real game.
//   python3 tools/serve.py 8173 game            (another terminal)
//   node tools/hitch_test.mjs [--out after.json] [--before before.json] [--repeat 3]
//                             [--only switch,types,garage,reset,crash,crashnear,crashfar,home] [--strict] [--headful]
// Start-up via tools/lib/startgame.mjs (campus spawn, all three vehicles painted black), then tools/lib/hitchprobe.mjs:
// each action `repeat` times (V switches; every car / bike / aircraft type, by code and through the Garage's Type
// menu; R near and 5 km out and back; jet crash respawns near and 5 km out and back; H from 5 km). For each: the worst
// elapsed frame ms (performance.now deltas) in the following ~1–2 s; also callback timing (renderer.render, world.updateLOD, the
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
if (!Number.isInteger(repeat) || repeat < 1) throw Error('--repeat must be a positive integer');
const types = Object.fromEntries(Object.entries(VEHICLE_TYPES).map(([k, list]) => [k, list.map(t => t.id)]));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  protocolTimeout: 300000,
  headless: process.argv.includes('--headful') ? false : 'new', args: ['--window-size=1280,800', '--enable-gpu', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const errors = [];
let report;
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800 });
  page.setDefaultTimeout(30000);
  await page.bringToFront();
  watchErrors(page, 'game', errors);
  const t0 = Date.now();
  await startGame(page);
  console.log(`game started in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  // Do not return the suite promise from evaluate: the full run can exceed CDP's
  // timeout even on a healthy page. Poll short snapshots and keep partial results.
  await page.evaluate(`(() => {
    window.__hitchRun = { done: false };
    (${hitchSuite.toString()})(window, ${JSON.stringify({ types, only, repeat })}).then(
      report => { window.__hitchRun = { done: true, report }; },
      error => { window.__hitchRun = { done: true, error: error.stack || String(error) }; }
    );
  })()`);
  let lastPhase = '', lastProgress = Date.now();
  report = { rows: [], fails: [], notes: [] };
  while (true) {
    // Node-side deadline still fires if the page's event loop (including timers) stalls.
    let timer;
    let state;
    try {
      state = await Promise.race([
        page.evaluate(() => ({ ...window.__hitchRun, progress: window.__hitchProgress, partial: window.__hitchPartial })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`page unresponsive during ${lastPhase || 'suite startup'} (snapshot evaluate exceeded 15 s)`)), 15000); }),
      ]);
    } finally { clearTimeout(timer); }
    report = state.report || state.partial || report;
    if (state.progress?.phase !== lastPhase || state.progress?.at !== lastProgress) {
      lastPhase = state.progress?.phase || 'suite startup';
      lastProgress = state.progress?.at || Date.now();
      console.log('hitch:', lastPhase);
    }
    if (state.done) {
      if (state.error) report.fails.push(`suite stopped during ${lastPhase}: ${state.error}`);
      break;
    }
    if (Date.now() - lastProgress > 90000) throw Error(`no progress for 90 s during ${lastPhase}`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} catch (e) {
  report ||= { rows: [], fails: [], notes: [] };
  report.fails.push(e.stack || String(e));
} finally { await browser.close(); }

console.table(report.rows.map(r => ({ action: r.label, 'worst ms': r.worst, 'median ms': r.median, 'callback ms': r.callbackWorst, frames: r.frames, render: r.render, lod: r.lod, top: r.top, programs: r.programs,
  uploads: r.uploads, 'build step': r.step, '>50 ms': r.over50, note: r.note })));
// per action: worst frame on first use (#1) and over the repeats after it, with the --before run's numbers
const summary = rows => {
  const by = new Map();
  for (const r of rows || []) {
    const s = by.get(r.action) || { first: null, later: null, firstMedian: null, laterMedians: [] }; by.set(r.action, s);
    if (r.round === 1) { s.first = r.worst; s.firstMedian = r.median ?? null; }
    else {
      if (r.worst !== null) s.later = Math.max(s.later ?? 0, r.worst);
      if (r.median != null) s.laterMedians.push(r.median);
    }
  }
  return by;
};
const metric = 'raf-performance-now-v1';
const beforeReport = beforeFile ? JSON.parse(fs.readFileSync(beforeFile, 'utf8')) : null;
const now = summary(report.rows), before = beforeReport?.metric === metric ? summary(beforeReport.rows) : null;
if (beforeReport && !before) report.notes.push('Before file uses a different or unversioned metric; callback-only measurements cannot be compared to frame intervals.');
console.log('Frame intervals in ms; repeat median column lists the median for each later run.');
console.table([...now].map(([action, s]) => ({ action, 'first worst': s.first ?? '–', 'first median': s.firstMedian ?? '–',
  'repeat worst': s.later ?? '–', 'repeat medians': s.laterMedians.join(', ') || '–',
  ...(before ? { 'before: first': before.get(action)?.first ?? '–', 'before: repeat': before.get(action)?.later ?? '–' } : {}) })));
const slowLater = [...now].filter(([, s]) => s.later > 50), slowAny = [...now].filter(([, s]) => Math.max(s.first, s.later ?? 0) > 50);
console.log(`worst frame: ${Math.max(0, ...report.rows.map(r => r.worst ?? 0)).toFixed(1)} ms · over 50 ms: ${slowAny.length} actions (${slowLater.length} after their first use)`);
report.metric = metric;
report.notes.forEach(n => console.log('note:', n));
if (out) { fs.writeFileSync(out, JSON.stringify({ when: new Date().toISOString(), url: process.env.YR_URL || 'http://127.0.0.1:8173/', ...report }, null, 1)); console.log('wrote', out); }
const fails = [...report.fails, ...errors];
if (!report.rows.length) fails.push('no actions measured (check --only)');
if (process.argv.includes('--strict')) fails.push(...slowLater.map(([a, s]) => `${a}: ${s.later} ms after first use`));
if (fails.length) { console.log('FAIL\n' + fails.join('\n')); process.exit(1); }
console.log('PASS hitch test: no page errors; paint and respawn checks held');
