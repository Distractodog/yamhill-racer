import assert from 'node:assert/strict';
import { createWeaponsCore, ROUND_CAP, MISSILE_CAP, armed, SHELL_SPEED, SHELL_RELOAD, SHELL_GRAVITY } from '../game/src/weaponscore.js';
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
  const { w, hits, breaks } = fixture([[0, 10, 20]], [{ pts: [[-2, 4], [2, 4], [2, 4.1], [-2, 4.1]], top: 15 }]);
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
  for (const kind of ['cannon', 'missile', 'rocket', 'shell', 'explosion']) {
    const b = weaponBuffer(ctx, kind); assert.equal(b, weaponBuffer(ctx, kind));
    assert(b.getChannelData(0).every(Number.isFinite)); assert(b.getChannelData(0).some(x => x !== 0));
  }
  const audio = new WeaponAudio(ctx, {});
  for (let i = 0; i < 100; i++) audio.shot('cannon', 1);
  assert.equal(sources.length, 24); audio.stop(); assert.equal(audio.voices.size, 0);
}
// Off-axis chase/cockpit views must project the gun direction, including a tilted helicopter.
{
  const THREE = await import('three');
  const { projectWeaponAim } = await import('../game/src/weapons.js');
  const mesh = new THREE.Object3D(), out = new THREE.Vector3();
  mesh.userData.guns = [new THREE.Vector3(0, -.55, 2.65)];
  mesh.position.set(10, 30, 20); mesh.rotation.set(-.2, .1, .3); mesh.updateMatrixWorld();
  const camera = new THREE.PerspectiveCamera(65, 1.6, .1, 2000);
  const expected = mesh.userData.guns[0].clone().applyMatrix4(mesh.matrixWorld)
    .addScaledVector(new THREE.Vector3(0, 0, 1).transformDirection(mesh.matrixWorld), 600);
  for (const eye of [[15, 38, -15], [10, 31, 22]]) {
    camera.position.fromArray(eye); camera.lookAt(10, 30, 200); camera.updateMatrixWorld();
    assert(projectWeaponAim(mesh, camera, out));
    assert(out.distanceTo(expected.clone().project(camera)) < 1e-9);
    assert(Math.abs(out.y) > .1, 'tilted nose does not aim at screen centre');
  }
  camera.lookAt(10, 30, -200); camera.updateMatrixWorld();
  assert.equal(projectWeaponAim(mesh, camera, out), false, 'hide a target behind the camera');
}
// Tank controls use the production readInput function, including the original non-tank mapping.
{
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const { editingInput } = await import('../game/src/mp/chat.js');
  const { isTank, tankDriveKey, updateTankGun, tankGunRay, TURRET_RATE, PITCH_MIN, PITCH_MAX } = await import('../game/src/tankgun.js');
  const { buildVehicleTypeModel } = await import('../game/src/vehicletypes.js');
  const THREE = await import('three');
  const keys = new Set(), tank = { kind: 'car', type: 'tank', mesh: buildVehicleTypeModel('car', 'tank') };
  const input = { jet: {} }, context = { input, isTank, tankDriveKey, editingInput, document: { activeElement: null }, vehicles: { current: tank },
    builder: {}, settings: {}, garage: {}, held: c => keys.has(c), activePad: () => null };
  const source = readFileSync(new URL('../game/src/main.js', import.meta.url), 'utf8');
  runInNewContext(source.slice(source.indexOf('function readInput()'), source.indexOf('\nweapons = createWeapons')), context);
  for (const type of ['tank', 'sports', 'race', 'suv']) {
    tank.type = type;
    for (const [key, field, expected] of [['ArrowUp', 'throttle', 1], ['ArrowDown', 'brake', 1], ['ArrowLeft', 'steer', -1], ['ArrowRight', 'steer', 1]]) {
      keys.clear(); keys.add(key); context.readInput();
      assert.equal(input[field], type === 'tank' ? 0 : expected, `${type} ${key}`);
    }
  }
  tank.type = 'tank';
  keys.clear(); keys.add('KeyW'); keys.add('KeyD'); context.readInput();
  assert.equal(input.throttle, 1); assert.equal(input.steer, 1);
  keys.clear(); context.activePad = () => ({ axes: [.6, 0, -.8, -.4], buttons: Array.from({ length: 8 }, (_, i) => ({ value: i === 7 ? .8 : i === 6 ? .3 : 0 })) });
  context.readInput(); assert.equal(input.steer, .6); assert.equal(input.throttle, .8); assert.equal(input.brake, .3);
  context.document.activeElement = { matches: () => true };
  context.readInput(); assert.equal(input.throttle, 0); assert.equal(input.brake, 0); assert.equal(input.steer, 0);
  assert.ok(Object.values(input.jet).every(v => v === 0), 'typing blocks keyboard and pad flight controls');
  context.document.activeElement = null;
  tank.mesh.updateMatrixWorld(true);
  keys.add('ArrowLeft'); keys.add('ArrowUp'); updateTankGun(tank, 1, keys, null, false);
  assert(Math.abs(tank.mesh.userData.turret.rotation.y - TURRET_RATE) < 1e-9);
  assert.equal(-tank.mesh.userData.barrel.rotation.x, PITCH_MAX);
  const yaw = tank.mesh.userData.turret.rotation.y;
  updateTankGun(tank, 1, keys, null, true); assert.equal(tank.mesh.userData.turret.rotation.y, yaw, 'menu/race locks aiming');
  keys.clear(); keys.add('ArrowDown'); updateTankGun(tank, 1, keys, null, false);
  assert.equal(-tank.mesh.userData.barrel.rotation.x, PITCH_MIN);
  keys.clear(); updateTankGun(tank, .1, keys, { axes: [0, 0, 1, -1] }, false);
  assert(tank.mesh.userData.turret.rotation.y < yaw); assert(-tank.mesh.userData.barrel.rotation.x > PITCH_MIN);
  for (let i = 0; i < 1000; i++) updateTankGun(tank, .1, new Set(['ArrowLeft']), null, false);
  assert(Math.abs(tank.mesh.userData.turret.rotation.y) <= Math.PI, 'unlimited traversal wraps for wire precision');
  const origin = new THREE.Vector3(), direction = new THREE.Vector3();
  assert(tankGunRay(tank.mesh, origin, direction));
  assert(origin.distanceTo(tank.mesh.userData.muzzle.getWorldPosition(new THREE.Vector3())) < 1e-9);
  assert(Math.abs(direction.length() - 1) < 1e-9);
  const rest = tank.mesh.userData.barrel.position.z; tank.mesh.userData.gunRecoil = .22;
  updateTankGun(tank, .02, keys, null, false); assert(tank.mesh.userData.barrel.position.z < rest);
  updateTankGun(tank, .3, keys, null, false); assert.equal(tank.mesh.userData.barrel.position.z, rest);
}
for (const fps of [30, 60, 120]) {
  const { w } = fixture(), tank = { kind: 'car', type: 'tank' }; let shots = 0;
  assert(armed(tank));
  const fire = kind => { assert.equal(kind, 'shell'); shots++; };
  w.control(1 / fps, tank, false, true, false, () => assert.fail('tank secondary disabled'));
  w.control(1 / fps, tank, true, false, false, fire); assert.equal(w.shellCooldown, SHELL_RELOAD);
  for (let i = 0; i < fps * 2.5 - 1; i++) w.control(1 / fps, tank, true, false, false, fire);
  assert.equal(shots, 1, 'reload rejects sustained or repeated fire');
  w.control(1 / fps, tank, true, false, false, fire); assert.equal(shots, 2);
  for (const state of ['countdown', 'running', 'finished', 'loading', 'menu']) {
    w.control(3, tank, true, true, true, () => assert.fail(state));
  }
  w.control(.01, { ...tank, mode: 'crashed' }, true, true, false, () => assert.fail('crashed'));
}
{
  const { w, hits } = fixture(), origin = p(0, 3), velocity = p(0, 0, SHELL_SPEED), predicted = p();
  w.aimShell(origin, velocity, predicted);
  assert(Math.abs(predicted.y) < .02); assert(predicted.z > 340 && predicted.z < 360, 'ballistic aim reaches the ground');
  const shell = w.spawn('shell', origin, velocity);
  for (let i = 0; i < 10; i++) w.step(.01);
  assert(Math.abs(shell.p.y - (3 - SHELL_GRAVITY * .1 ** 2 / 2)) < 1e-9, 'gravity arc');
  for (let i = 0; i < 100 && shell.active; i++) w.step(.01);
  assert.equal(hits.length, 1); assert.equal(hits[0].type, 'terrain');
  assert(Math.abs(shell.p.z - predicted.z) < .2, 'reticle and flight agree');
  assert(validShot(encodeShot('shell', 1, origin, velocity)));
}
for (const remote of [false, true]) {
  const { w, hits, breaks } = fixture([[0, 5, 20], [10, 5, 20], [20, 5, 20]]);
  w.spawn('shell', p(), p(0, 0, SHELL_SPEED), remote); w.step(.05);
  assert.equal(hits[0].type, 'tree'); assert.equal(breaks.broken.size, remote ? 0 : 2, '12m shell blast, local authority only');
}
{
  const { w, hits } = fixture([], [{ pts: [[-2, 4], [2, 4], [2, 4.1], [-2, 4.1]], top: 15 }]);
  w.spawn('shell', p(), p(0, 0, SHELL_SPEED)); w.step(.01); assert.equal(hits[0].type, 'building');
  w.spawn('shell', p(0, 1000), p(0, 0, SHELL_SPEED));
  for (let i = 0; i < 61; i++) w.step(.1);
  assert.equal(hits[1].type, 'air', 'shell six second fuse');
}
console.log('PASS weapons: firing, lockouts, sweeps, blasts, remote isolation, pools, wire');
