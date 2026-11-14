// node tools/townbuild_test.mjs
// Classifies real footprints from three town tiles and checks the building rules.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { planBuilding, hash } from '../game/src/townbuild.js';
import { inPoly, partTop } from '../game/src/campus.js';

const TILES = [
  ['McMinnville', '10_-6'],
  ['Sheridan', '2_1'],
  ['Willamina', '-2_2'],
];

function load(name) {
  const raw = gunzipSync(readFileSync(new URL(`../game/assets/tiles/${name}/tile.json.gz`, import.meta.url)));
  return JSON.parse(raw.toString());
}
function distToEdge(p, a, b) {
  const abx = b[0] - a[0], abz = b[1] - a[1];
  const den = abx * abx + abz * abz || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * abz) / den));
  return Math.hypot(p[0] - (a[0] + abx * t), p[1] - (a[1] + abz * t));
}
function onOrIn(poly, p) {
  if (inPoly(poly, p[0], p[1])) return true;
  for (let i = 0; i < poly.length; i++) if (distToEdge(p, poly[i], poly[(i + 1) % poly.length]) <= 0.45) return true;
  return false;
}
function check(plan, original) {
  assert.equal(JSON.stringify(plan), JSON.stringify(planBuilding(original.foot, original.context)), 'same footprint must plan the same building');
  assert.ok(plan.top > 0);
  let peak = 0;
  for (const part of plan.parts) {
    assert.equal(part.wallH, part.h);
    assert.equal(part.roof.over, 0, 'roof outline stays on the walls');
    peak = Math.max(peak, partTop(part));
    for (const p of part.pts) assert.ok(onOrIn(original.foot.pts, p), `${plan.kind} corner left the footprint`);
    if (part.roof.type === 'flat') assert.ok(Math.abs(partTop(part) - (part.h + (part.roof.parapet || 0) + (part.boxes ? 7 : 0))) < 1e-6 || part.boxes);
    if (part.roof.type === 'gable' || part.roof.type === 'hip') assert.ok(partTop(part) >= part.h);
  }
  assert.equal(plan.top, peak, 'top is the roof height');
}

const rnd = hash(10.2, -3.4);
const a = rnd(), b = rnd();
assert.notEqual(a, b);
assert.equal(a, hash(10.2, -3.4)());
assert.equal(b, (() => { const r = hash(10.2, -3.4); r(); return r(); })());

const rect = (x, z, L, W) => [[x, z], [x + L, z], [x + L, z + W], [x, z + W]];
const cases = [
  ['house', { pts: rect(0, 0, 12, 9), h: 6 }, { roads: [{ cls: 'residential', pts: [[6, -6], [6, 20]] }] }],
  ['outbuilding', { pts: rect(0, 0, 4, 3), h: 2.4 }, { roads: [] }],
  ['commercial', { pts: rect(0, 0, 40, 20), h: 8 }, { roads: [{ cls: 'primary', pts: [[0, -10], [40, -10]] }] }],
  ['warehouse', { pts: rect(0, 0, 60, 30), h: 7 }, { roads: [{ cls: 'residential', pts: [[0, 200], [60, 200]] }] }],
  ['school', { pts: rect(0, 0, 40, 30), h: 6 }, { roads: [{ cls: 'residential', pts: [[20, 80], [20, 120]] }] }],
  ['apartment', { pts: rect(0, 0, 24, 16), h: 9 }, { roads: [{ cls: 'residential', pts: [[12, 40], [12, 80]] }] }],
  ['church', { pts: rect(0, 0, 16, 12), h: 14 }, { roads: [] }],
  ['house', { pts: [[0, 0], [14, 0], [14, 6], [6, 6], [6, 12], [0, 12]], h: 6 }, { roads: [{ cls: 'residential', pts: [[7, -8]] }] }],
];
for (const [kind, foot, context] of cases) {
  const plan = planBuilding(foot, context);
  assert.equal(plan.kind, kind, `expected ${kind}, got ${plan.kind}`);
  check(plan, { foot, context });
  if (kind === 'house') assert.ok(plan.parts[0].porch, 'a house has a porch toward the road');
  if (kind === 'commercial') assert.ok(plan.parts[0].awnings.length, 'a shop has an awning');
  if (kind === 'church') assert.ok(plan.top > plan.parts[0].h + 6, 'a church steeple raises the top');
  if (kind === 'outbuilding') assert.equal(plan.parts[0].win, null);
}

for (const [town, name] of TILES) {
  const tile = load(name);
  const counts = {};
  for (const foot of tile.buildings) {
    if (!foot.pts || foot.pts.length < 3) continue;
    const plan = planBuilding(foot, { roads: tile.paths });
    counts[plan.kind] = (counts[plan.kind] || 0) + 1;
    check(plan, { foot, context: { roads: tile.paths } });
  }
  const line = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`${town} (${tile.buildings.length}): ${line}`);
}
console.log('PASS town building rules: determinism, roofs inside walls, top matches the roof');
