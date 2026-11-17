// Director-run browser review of the private renderer, with no secrets/network/ports.
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderStats, DAY } from '../server/stats.mjs';
const outIndex = process.argv.indexOf('--out');
const out = resolve(outIndex >= 0 ? process.argv[outIndex + 1] : '/tmp/yr-stats-shots');
await mkdir(out, { recursive: true });
const now = Date.parse('2026-11-17T22:00:00Z');
const rows = Array.from({ length: 60 }, (_, i) => ({ day: new Date(now - i * DAY).toISOString().slice(0, 10), visits: i % 11 + 2, unique: i % 7 + 1, games: i % 3, countries: { US: i % 11 + 2 } }));
const game = { id: 'example-game-id', code: 'ABCDE', start: now - 1800000, end: now - 60000, last: now - 60000, host: 'Maple', names: ['Maple', 'River', '<Anonymous>'], maxPlayers: 3 };
const sessions = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, visitor: `0123456789abcd${i}`, country: i % 2 ? 'CA' : 'US', nickname: i === 0 ? 'Maple' : '',
  start: now - (i + 1) * 600000, last: now - i * 60000, end: i ? now - i * 60000 : null, activeMs: 480000,
  vehicles: ['car:race', 'aircraft:stealth', 'bike:dirt'], races: { started: 3, finished: 2, medals: { gold: 1, silver: 1, bronze: 0 } },
  graphics: 'auto', browser: 'Chrome', screen: 'large', offset: 480, builder: i % 2 === 0, mpGames: i < 3 ? [{ id: game.id, code: game.code, maxPlayers: 3 }] : [],
}));
const html = renderStats(rows, sessions, [game], now);
await writeFile(resolve(out, 'stats.html'), html);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  for (const [name, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewport({ width, height }); await page.setContent(html, { waitUntil: 'load' });
    await page.screenshot({ path: resolve(out, `${name}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) errors.push(`${name}: document overflows viewport`);
  }
  console.log(JSON.stringify({ out, errors }));
  if (errors.length) process.exitCode = 1;
} finally { await browser.close(); }
