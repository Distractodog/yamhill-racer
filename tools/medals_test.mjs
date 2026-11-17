// Race medals (game/src/medals.js) and the medal targets in challenges.json: no browser, no world.
//   node tools/medals_test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { medalFor, nextMedal, isBetterMedal, createMedals, MEDAL_KEY, MEDALS } from '../game/src/medals.js';

const T = { gold: 60, silver: 69, bronze: 81 };
// medalFor: at or under a target earns it, best first
assert.equal(medalFor(55, T), 'gold');
assert.equal(medalFor(60, T), 'gold', 'exactly the gold time is gold');
assert.equal(medalFor(60.01, T), 'silver');
assert.equal(medalFor(69, T), 'silver');
assert.equal(medalFor(81, T), 'bronze');
assert.equal(medalFor(81.01, T), null);
for (const bad of [NaN, Infinity, -1, null, undefined, '50']) assert.equal(medalFor(bad, T), null, `time ${bad}`);
assert.equal(medalFor(10, null), null, 'a race without targets gives no medal');
assert.equal(medalFor(10, { gold: NaN, silver: 20 }), 'silver', 'a broken target is skipped');

// nextMedal: the one above what you got
assert.deepEqual(nextMedal(90, T), { medal: 'bronze', target: 81, gap: 9 });
assert.deepEqual(nextMedal(75, T), { medal: 'silver', target: 69, gap: 6 });
assert.deepEqual(nextMedal(65, T), { medal: 'gold', target: 60, gap: 5 });
assert.equal(nextMedal(59, T), null, 'nothing above gold');
assert.equal(nextMedal(59, null), null);

assert(isBetterMedal('gold', 'silver') && isBetterMedal('bronze', null) && !isBetterMedal(null, 'bronze') && !isBetterMedal('silver', 'silver'));

// storage: best medal per race, only upgrades, survives a reload, ignores junk
function store(init = {}) { const m = new Map(Object.entries(init)); return { m, getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; }
const race = { id: 'r1', medals: T }, other = { id: 'r2', medals: T };
let s = store(), md = createMedals(s);
assert.deepEqual(md.record(race, 85), { medal: null, prev: null, improved: false });
assert.equal(s.m.has(MEDAL_KEY), false, 'no medal: nothing saved');
assert.deepEqual(md.record(race, 70), { medal: 'bronze', prev: null, improved: true });
assert.deepEqual(md.record(race, 58), { medal: 'gold', prev: 'bronze', improved: true });
assert.deepEqual(md.record(race, 66), { medal: 'silver', prev: 'gold', improved: false }, 'a worse run keeps gold');
assert.equal(md.get('r1'), 'gold');
md.record(other, 80);
assert.deepEqual(md.tally(), { gold: 1, silver: 0, bronze: 1 });
assert.deepEqual(JSON.parse(s.m.get(MEDAL_KEY)), { r1: 'gold', r2: 'bronze' });
md = createMedals(s);                                  // reload
assert.equal(md.get('r1'), 'gold'); assert.equal(md.get('r2'), 'bronze'); assert.equal(md.get('r3'), null);
for (const junk of ['{', '[]', 'null', '"x"', JSON.stringify({ r1: 'platinum', r2: 3, r3: 'silver' })]) {
  const j = createMedals(store({ [MEDAL_KEY]: junk }));
  assert.deepEqual(j.all(), junk.includes('r3') ? { r3: 'silver' } : {}, `junk ${junk}`);
}
const broken = createMedals({ getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } });
assert.equal(broken.record(race, 50).medal, 'gold', 'a store that throws still reports the medal');
assert.equal(createMedals(null).record(race, 50).improved, true, 'no store at all');

// best times from before medals: earned once at load, never a downgrade
s = store({ [MEDAL_KEY]: JSON.stringify({ r2: 'gold' }) }); md = createMedals(s);
md.importBests([race, other, { id: 'r3' }], { r1: { time: 68 }, r2: { time: 80 }, r3: { time: 1 }, r4: { time: 1 } });
assert.deepEqual(md.all(), { r1: 'silver', r2: 'gold' });

// challenges.json: every race has targets in order, from its bot time (gold ≈ ×1.02, silver ×1.15, bronze ×1.35);
// top-speed races (pace 'top') from the race car's own time `fast` instead (gold ≈ ×1.05, silver ×1.18, bronze ×1.39)
const list = JSON.parse(fs.readFileSync(new URL('../game/assets/challenges.json', import.meta.url)));
const F = { gold: 1.02, silver: 1.15, bronze: 1.35 }, FAST = { gold: 1.05, silver: 1.18, bronze: 1.39 };
let top = 0;
for (const c of list) {
  assert(c.medals && c.bot > 0, `${c.id}: medals + bot time`);
  const fast = c.pace === 'top', base = fast ? c.fast : c.bot, f = fast ? FAST : F;
  if (fast) { top++; assert(c.fast > 0 && c.fast < c.bot, `${c.id}: the race car beats the capped bot`); }
  for (const m of MEDALS) {
    assert(Number.isFinite(c.medals[m]) && c.medals[m] > 0, `${c.id}: ${m}`);
    assert(Math.abs(c.medals[m] - base * f[m]) <= 0.5, `${c.id}: ${m} ${c.medals[m]} vs ${base} × ${f[m]}`);
  }
  assert(c.medals.gold < c.medals.silver && c.medals.silver < c.medals.bronze, `${c.id}: gold < silver < bronze`);
  assert.equal(medalFor(base, c.medals), 'gold', `${c.id}: the ${fast ? 'race car' : 'bot'}'s own time is gold`);
}
assert(list.find(c => c.id === 'hwy18-top-speed')?.pace === 'top', 'Hwy 18 top speed uses the race car pace');
console.log(`PASS medals: medalFor / nextMedal / storage (yr-medals-1) / import of old bests; ${list.length} races with ordered targets (${top} from the race car's pace, the rest from their bot times)`);
