// Boundary regressions use the real tile manifest, without loading terrain assets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeWorld } from '../game/src/data.js';
import { Jet } from '../game/src/jet.js';
const manifest = JSON.parse(fs.readFileSync('game/assets/world.json'));
const W = makeWorld(manifest), T = manifest.tile;
const jet = new Jet(W);
const keys = new Set(manifest.tiles.map(t => t.join(',')));
let edges = 0, seams = 0;
const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function prepare(x, z, dx, dz) {
  jet.pos.set(x, 1200, z); jet.vel.set(dx * 1733 / 3.6, 7, dz * 1733 / 3.6);
  jet.quat.identity(); jet._acc.set(1, 2, 3); jet.msg = '';
}
for (const [tx, tz] of manifest.tiles) for (const [dx, dz] of dirs) {
  const neighbor = keys.has([tx + dx, tz + dz].join(','));
  if (neighbor) {
    prepare(tx * T + dx * (T / 2 - 10), tz * T + dz * (T / 2 - 10), dx, dz);
    jet.edgeTurn(); assert.equal(jet.msg, '', 'shared seam must not turn jet');
    assert.equal(W.loadedAt(jet.pos.x, jet.pos.z), false);
    seams++; continue;
  }
  // Mid-edge plus positions near both endpoints exercise convex and concave corners.
  for (const tangent of [-950, 0, 950]) {
    prepare(tx * T + dx * (T / 2 - 50) + dz * tangent, tz * T + dz * (T / 2 - 50) + dx * tangent, dx, dz);
    let turns = 0;
    const speed = jet.vel.length();
    for (let i = 0; i < 120; i++) {
      jet.pos.addScaledVector(jet.vel, 1 / 120); jet.msg = ''; jet.edgeTurn();
      if (jet.msg) turns++;
      assert.ok(W.mapContains(jet.pos.x, jet.pos.z, 8), `outside at ${tx},${tz} edge ${dx},${dz}`);
      assert.ok(Math.abs(jet.vel.length() - speed) < 1e-8);
      assert.equal(jet.vel.y, 7);
    }
    assert.equal(turns, 1, 'one turn, no repeated flips at edge');
    edges++;
  }
}
// Diagonal approaches to every tile corner cover concave joins and diagonal-only contacts.
let corners = 0;
for (const [tx, tz] of manifest.tiles) for (const dx of [-1, 1]) for (const dz of [-1, 1]) {
  prepare(tx * T + dx * (T / 2 - 50), tz * T + dz * (T / 2 - 50), dx / Math.SQRT2, dz / Math.SQRT2);
  let previousTurn = -100;
  for (let i = 0; i < 120; i++) {
    jet.pos.addScaledVector(jet.vel, 1 / 120); jet.msg = ''; jet.edgeTurn();
    assert.ok(W.mapContains(jet.pos.x, jet.pos.z, 8));
    if (jet.msg) { assert.ok(i - previousTurn > 30, 'no repeated corner flips'); previousTurn = i; }
  }
  corners++;
}
// Existing out-of-map saves/teleports recover inside and remain stable, regardless of heading.
for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
  prepare(9000, 3000, Math.sin(yaw), Math.cos(yaw));
  jet.edgeTurn(); assert.ok(W.mapContains(jet.pos.x, jet.pos.z, 8));
  for (let i = 0; i < 60; i++) {
    jet.pos.addScaledVector(jet.vel, 1 / 120); jet.msg = ''; jet.edgeTurn();
    assert.equal(jet.msg, ''); assert.ok(W.mapContains(jet.pos.x, jet.pos.z, 8));
  }
}
console.log(`PASS: ${edges} exposed-edge flights at 1733 km/h, ${seams} unloaded shared seams, ${corners} diagonal corner flights, four off-map recoveries; speed/vertical velocity preserved, no repeated flips.`);
