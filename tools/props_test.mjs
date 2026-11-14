// node tools/props_test.mjs
// Street props come from the tile paths and stay off the campus and out of junctions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { placeProps } from '../game/src/props.js';

const TILES = [['McMinnville', '10_-6'], ['Sheridan', '2_1'], ['Willamina', '-2_2']];
const CAMPUS = (x, z) => x >= -900 && x <= -350 && z >= 130 && z <= 650;

function load(name) {
  const raw = gunzipSync(readFileSync(new URL(`../game/assets/tiles/${name}/tile.json.gz`, import.meta.url)));
  return JSON.parse(raw.toString());
}
function distPointSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, den = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / den));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}
function nearPath(paths, x, z, max) {
  for (const p of paths) {
    const pts = p.pts || [];
    for (let i = 1; i < pts.length; i++) if (distPointSeg(x, z, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= max) return true;
  }
  return false;
}

for (const [name, id] of TILES) {
  const tile = load(id);
  const a = placeProps(tile);
  const b = placeProps(tile);
  assert.equal(JSON.stringify(a), JSON.stringify(b), name + ' placement must be stable');
  const n = Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.length]));
  console.log(name, JSON.stringify(n));
  assert.ok(n.lights > 8 && n.poles > 8 && n.lines > 4 && n.stops > 0, name + ' is missing a prop type');
  for (const list of Object.values(a)) for (const it of list) {
    const x = it.x, z = it.z;
    assert.ok(!CAMPUS(x, z), name + ' prop landed on the campus');
    if (it.x2 !== undefined) assert.ok(!CAMPUS(it.x2, it.z2));
  }
  for (const it of a.lights) assert.ok(nearPath(tile.paths, it.x, it.z, 14), name + ' light left the street');
  for (const it of a.stops) assert.ok(nearPath(tile.paths, it.x, it.z, 16), name + ' stop sign left the street');
  assert.ok(n.lights < 8000 && n.fences < 8000, name + ' placed too many props');
}
const mac = placeProps(load('10_-6'));
assert.ok(mac.mailboxes.length > 5 && mac.fences.length > 5, 'McMinnville should have mailboxes and fences');
console.log('PASS');
