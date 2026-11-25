import assert from 'node:assert/strict';
import { createWeaponsCore, ROUND_CAP, MISSILE_CAP, armed } from '../game/src/weaponscore.js';
import { createTreeBreaks, treeId } from '../game/src/treebreak.js';
import { validShot, encodeShot } from '../game/src/weaponswire.js';
const v = { kind: 'jet', type: 'fighter' }, p = (x = 0, y = 10, z = 0) => ({ x, y, z });
function fixture(trees = [], buildings = []) {
  const breaks = createTreeBreaks(() => true, () => 0), hits = [], fired = [];
  const world = { heightAt: () => 0, terrainAt: () => 0, buildingsNear: () => buildings,
    treesNear(x, z, r, cb) { for (let i = 0; i < trees.length; i++) { const t = trees[i]; if (!breaks.broken.has(treeId(0, 0, i))) cb(t[0], t[1], .3, t[2], 0, treeId(0, 0, i)); } },
    breakTree: (id, impact) => breaks.break(id, impact) };
  const w = createWeaponsCore({ world, onFire: s => fired.push(s.kind), onImpact: (s, hit) => hits.push({ type: hit.type, y: s.p.y }) });
  return { w, breaks, hits, fired };
}
{
  const { w } = fixture(); let shots = 0;
  for (let i = 0; i < 120; i++) w.control(1 / 120, v, true, false, false, () => shots++);
  assert.equal(shots, 12, '12 rounds per second');
  let rockets = 0; const fire = k => { if (k !== 'cannon') rockets++; };
  w.control(.01, v, false, true, false, fire);
  for (let i = 0; i < 300; i++) w.control(.01, v, false, true, false, fire);
  assert.equal(rockets, 1, 'hold Q does not repeat');
  w.control(.01, v, false, false, false, fire); w.control(.01, v, false, true, false, fire);
  assert.equal(rockets, 2);
  w.control(.01, v, false, false, false, fire); w.control(.01, v, false, true, false, fire);
  assert.equal(rockets, 2, 'cooldown rejects early press');
  for (const type of ['blackbird', 'airliner', 'prop', 'stunt']) { assert.equal(armed({ kind: 'jet', type }), false); w.control(1, { kind: 'jet', type }, true, true, false, () => assert.fail(type)); }
  for (const kind of ['car', 'bike']) w.control(1, { kind, type: 'fighter' }, true, true, false, () => assert.fail(kind));
  for (const state of ['countdown', 'running', 'finished', 'loading', 'menu']) w.control(1, v, true, true, state !== 'idle', () => assert.fail(state));
  for (const type of ['fighter', 'stealth', 'heli']) assert(armed({ kind: 'jet', type }));
}
{
  const { w, hits } = fixture(); w.spawn('cannon', p(0, 3), p(0, -1000, 0)); w.step(.01);
  assert.equal(hits[0].type, 'terrain'); assert(Math.abs(hits[0].y) < .03);
}
{
  const { w, hits, breaks } = fixture([[0, 5, 20]]); w.spawn('cannon', p(), p(0, 0, 1000)); w.step(.01);
  assert.equal(hits[0].type, 'tree'); assert.equal(breaks.broken.size, 1);
}
{
  const { w, breaks } = fixture([[0, 0, 20], [11, 0, 20], [13, 0, 20], [0, 0, 2]]);
  w.onHit({ type: 'air' }, p(), 'missile'); assert.equal(breaks.broken.size, 3, '3D radius includes trunks within 12m');
  assert(!breaks.broken.has(treeId(0, 0, 2)), 'outside 12m preserved');
}
{
  const { w, hits, breaks } = fixture([[0, 5, 20]], [{ pts: [[-2, 1], [2, 1], [2, 1.1], [-2, 1.1]], top: 15 }]);
  w.spawn('cannon', p(), p(0, 0, 1000)); w.step(.01); assert.equal(hits[0].type, 'building'); assert.equal(breaks.broken.size, 0);
}
{
  const { w, breaks } = fixture([[0, 5, 20]]); w.spawn('missile', p(), p(0, 0, 1000), true); w.step(.01); assert.equal(breaks.broken.size, 0, 'remote replay never applies damage');
  const storage = w.pool.slice();
  for (let i = 0; i < 10000; i++) w.spawn(i % 2 ? 'cannon' : 'rocket', p(), p(0, 0, 1000));
  assert.equal(w.pool.length, ROUND_CAP + MISSILE_CAP); w.pool.forEach((s, i) => assert.equal(s, storage[i]));
  w.clear(); assert(w.pool.every(s => !s.active));
}
{
  const msg = encodeShot('cannon', 34, p(), p(0, 0, 1000)); assert(validShot(JSON.parse(JSON.stringify(msg))));
  for (const patch of [{ k: 'player-damage' }, { p: [Infinity, 0, 0] }, { v: [0, 0, 0] }, { n: 65536 }]) assert(!validShot({ ...msg, ...patch }));
}
// Tapping cannot bypass the cannon interval; frame rate does not change sustained fire.
for (const fps of [30, 60, 120]) {
  const { w } = fixture(); let count = 0;
  for (let i = 0; i < fps * 3; i++) w.control(1 / fps, v, true, false, false, () => count++);
  assert.equal(count, 36);
}
{
  const { w } = fixture(); let count = 0;
  for (let i = 0; i < 120; i++) w.control(1 / 120, v, i % 2 === 0, false, false, () => count++);
  assert(count <= 12);
}
// Fixed-wing anchors belong only to armed models; built once, in model-local coordinates.
{
  const { buildVehicleTypeModel } = await import('../game/src/vehicletypes.js');
  for (const type of ['fighter', 'stealth', 'heli', 'blackbird', 'airliner', 'prop', 'stunt']) {
    const model = buildVehicleTypeModel('jet', type);
    assert.equal(!!model.userData.guns, armed({ kind: 'jet', type }));
    if (model.userData.guns) for (const anchor of [...model.userData.guns, ...model.userData.missiles]) assert(anchor.isVector3 && anchor.toArray().every(Number.isFinite));
  }
}
{
  const { w, hits } = fixture();
  w.spawn('rocket', p(0, 500), p(0, 0, 280));
  for (let i = 0; i < 61; i++) w.step(.1);
  assert.equal(hits.length, 1); assert.equal(hits[0].type, 'air', 'six second fuse');
  let kind;
  w.control(.01, { kind: 'jet', type: 'heli' }, false, true, false, k => { kind = k; });
  assert.equal(kind, 'rocket');
}
{
  const { weaponBuffer, WeaponAudio } = await import('../game/src/audio/weapons.js');
  const sources = [], ctx = { sampleRate: 8000,
    createBuffer(c, size) { const data = new Float32Array(size); return { getChannelData: () => data }; },
    createBufferSource() { const s = { connect(n) { return n; }, start() {}, stop() { this.onended?.(); }, disconnect() {} }; sources.push(s); return s; },
    createGain() { return { gain: { value: 0 }, connect(n) { return n; }, disconnect() {} }; } };
  for (const kind of ['cannon', 'missile', 'rocket', 'explosion']) {
    const b = weaponBuffer(ctx, kind); assert.equal(b, weaponBuffer(ctx, kind));
    assert(b.getChannelData(0).every(Number.isFinite)); assert(b.getChannelData(0).some(x => x !== 0));
  }
  const audio = new WeaponAudio(ctx, {});
  for (let i = 0; i < 100; i++) audio.shot('cannon', 1);
  assert.equal(sources.length, 24); audio.stop(); assert.equal(audio.voices.size, 0);
}
console.log('PASS weapons: firing, lockouts, sweeps, blasts, remote isolation, pools, wire');
