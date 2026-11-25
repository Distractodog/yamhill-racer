import assert from 'node:assert/strict';
import { DAMAGE, createCombatState, damageFor, sphereEntry, killFeedText } from '../game/src/combatcore.js';
import { validHit } from '../game/src/weaponswire.js';
import { createWeaponsCore } from '../game/src/weaponscore.js';
const id = '000000000001', from = '000000000002';
let n = 0;
const hit = (k = 'missile', extra = {}) => ({ t: 'hit', to: id, from, k, n: n++, d: DAMAGE[k], p: [0, 0, 0], ...extra });
const vehicle = { kind: 'car', type: 'race', pos: { x: 0, y: 0, z: 0 } };
assert.deepEqual(DAMAGE, { cannon: 6, missile: 70, rocket: 55, shell: 80 });
for (const [kind, damage] of Object.entries(DAMAGE)) {
  assert.equal(damageFor(kind), damage); assert.equal(damageFor(kind, 0, true), damage / 2);
  assert.equal(damageFor(kind, 12), 0); assert.equal(damageFor(kind, 30), 0);
  if (kind !== 'cannon') assert.equal(damageFor(kind, 6), damage / 2);
}
const s = createCombatState();
assert.equal(s.health, 100); assert.equal(s.hit(hit(), vehicle), false);
s.update(4.99); assert.equal(s.protected, true); s.update(.01); assert.equal(s.protected, false);
assert.equal(s.hit(hit(), vehicle, false), false); assert.equal(s.hit(hit(), vehicle, true, true), false);
assert.equal(s.hit(hit('cannon', { p: [25.01, 0, 0] }), vehicle), false);
assert.equal(s.hit(hit('cannon', { p: [0, 0, NaN] }), vehicle), false);
const shot = hit('cannon', { p: [25, 0, 0] });
assert.equal(s.hit(shot, vehicle), true); assert.equal(s.hit(shot, vehicle), false); assert.equal(s.health, 94);
s.update(8); assert.equal(s.health, 94); s.update(.3); assert.ok(Math.abs(s.health - 97) < 1e-9);
s.update(10); assert.equal(s.health, 100);
s.spawn(); assert.equal(s.protected, true); s.fired(); assert.equal(s.protected, false);
s.hit(hit('shell'), { ...vehicle, type: 'tank' }); assert.equal(s.health, 60);
s.spawn(); s.fired(); s.hit(hit(), vehicle); s.update(8.5); assert.equal(s.health, 35);
let killer, respawns = 0;
const w = createCombatState({ onWreck: id => killer = id, onRespawn: () => respawns++ }); w.fired();
w.hit(hit(), vehicle); w.hit(hit(), vehicle); assert.equal(w.health, 0); assert.equal(killer, from); assert.equal(w.wrecked, true);
assert.equal(w.hit(hit(), vehicle), false); w.update(2.99); assert.equal(respawns, 0); w.update(.01);
assert.equal(respawns, 1); assert.equal(w.health, 100); assert.equal(w.wrecked, false); assert.equal(w.protected, true);
w.fired(); w.hit(hit('shell'), { ...vehicle, kind: 'jet' }); w.hit(hit('shell'), { ...vehicle, kind: 'jet' });
w.update(6); assert.equal(w.wrecked, true, 'aircraft reset is owned by existing crash path'); assert.equal(respawns, 1);
w.spawn(); assert.equal(w.protected, true);
assert.equal(killFeedText('Ace', 'Driver'), 'Ace wrecked Driver'); assert.equal(killFeedText(null, null), 'A player wrecked A player');
for (const kind of Object.keys(DAMAGE)) assert.equal(validHit(hit(kind)), true);
for (const extra of [{ k: 'blast' }, { k: '__proto__' }, { to: 'x' }, { n: -1 }, { n: 65536 }, { n: 1.5 }, { d: 71 }, { d: 0 }, { d: NaN }, { p: [0, 0] }, { p: [0, 0, Infinity] }, { p: [100001, 0, 0] }]) assert.equal(validHit(hit('missile', extra)), false, JSON.stringify(extra));
assert.equal(sphereEntry(0, 0, -10, 0, 0, 20, vehicle.pos, 2), .4);
assert.equal(sphereEntry(0, 0, 0, 0, 0, 0, vehicle.pos, 2), 0);
assert.equal(sphereEntry(10, 0, -10, 0, 0, 20, vehicle.pos, 2), Infinity);
assert.equal(sphereEntry(0, 0, -10, 0, 0, -20, vehicle.pos, 2), Infinity);
// Sweeps select the nearest world/player contact; remote replays and tank aim predictions cannot hit players.
let sweeps = 0, contacts = [], breaks = 0;
const core = createWeaponsCore({ world: { heightAt: () => -100, treesNear() {}, breakTree() { breaks++; } } });
core.sweepPlayers = (x,y,z,dx,dy,dz,best,target) => { sweeps++; const t = sphereEntry(x,y,z,dx,dy,dz,{ x: 0, y: 0, z: 5 },1); if (t < best) { target.type = 'player'; target.id = id; return t; } return best; };
core.onHit = (target, p, kind, n) => contacts.push({ ...target, p: { ...p }, kind, n });
core.spawn('missile', { x:0,y:0,z:0 }, { x:0,y:0,z:1000 }, false, '', 42); core.step(.01);
assert.equal(contacts[0].id, id); assert.equal(contacts[0].n, 42); assert.ok(Math.abs(contacts[0].p.z - 4) < 1e-9);
const count = sweeps; core.spawn('missile', { x:0,y:0,z:0 }, { x:0,y:0,z:1000 }, true); core.step(.01);
core.aimShell({x:0,y:0,z:0}, {x:0,y:0,z:450}, {}); assert.equal(sweeps, count); assert.equal(breaks, 0);
const wall = createWeaponsCore({ world: { heightAt: () => -100, terrainAt: () => -100,
  buildingsNear: () => [{ pts: [[-2,2],[2,2],[2,3],[-2,3]], top: 10 }] } });
wall.sweepPlayers = core.sweepPlayers; wall.onHit = target => contacts.push({ ...target });
wall.spawn('cannon', {x:0,y:0,z:0}, {x:0,y:0,z:1000}); wall.step(.01);
assert.equal(contacts.at(-1).type, 'building', 'walls block remote hits and are never damaged');
console.log('PASS combat: damage, armour, splash, regen, protection, rejection, replay, respawn, feed, wire, swept players/world ordering');
const { missilePose, localURL } = await import('./lib/mp-combat-browser.mjs');
const pose = missilePose([10,20,30]);
const [qx,,,qw] = pose.quaternion, c = 1 - 2*qx*qx, sn = 2*qx*qw;
const muzzle = [pose.position[0]+2, pose.position[1]-.4*c-sn, pose.position[2]-.4*sn+c];
assert.ok(Math.abs(muzzle[0]-10) < 1e-9);
const t = (30-muzzle[2])/c; assert.ok(Math.abs(muzzle[1]-sn*t-20) < 1e-9);
assert.equal(localURL('ws://127.0.0.1:8787', ['ws:']).port, '8787');
assert.throws(() => localURL('wss://example.com', ['wss:']));
console.log('PASS browser helpers: pylon-compensated aim and local-server enforcement');
// Exercise the real browser glue with a tiny DOM and Three meshes, including car.reset (no afterReset hook).
const THREE = await import('three');
const elements = [];
globalThis.document = {
  head: { append() {} }, body: { append() {} },
  createElement(tag) { const e = { tag, style: {}, hidden: false, append() {}, setAttribute() {}, remove() {} }; elements.push(e); return e; },
};
const makeVehicle = kind => {
  const v = { kind, type: kind === 'jet' ? 'fighter' : 'race', pos: new THREE.Vector3(), vel: new THREE.Vector3(), ang: new THREE.Vector3(),
    mesh: new THREE.Group(), safe: [], resets: 0, afterReset() {}, savePrev() {}, heading: () => 0,
    reset() { this.resets++; this.mode = 'ground'; }, resetToSafe() { this.reset(); },
    crash(reason) { assert.equal(this.grace, 0); this.reason = reason; this.mode = 'crashed'; },
  }; v.mesh.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ color: 0xff0000 }))); return v;
};
const car = makeVehicle('car'), bike = makeVehicle('bike'), jet = makeVehicle('jet');
const vehicles = { car, bike, aircraft: [jet], current: car, onSwitch(fn) { this.switched = fn; } };
const listeners = new Map(), sent = [], near = '000000000003', far = '000000000004';
const mp = { inGame: true, weaponsEnabled: true, me: { id, name: 'Driver' }, players: new Map([[from,{name:'Ace'}],[id,{name:'Driver'}]]),
  on(t, fn) { listeners.set(t, fn); }, send(m) { sent.push(m); } };
const remotes = { forEachCombat(fn) { fn(from, {x:0,y:0,z:0}, 'car', 'race'); fn(near,{x:6,y:0,z:0},'bike','dirt'); fn(far,{x:20,y:0,z:0},'jet','fighter'); } };
let racing = false;
const { createCombat } = await import('../game/src/combat.js');
const combat = createCombat({ mp, vehicles, remotes, racing: () => racing });
combat.update(5.1);
combat.impact({type:'player',id:from}, {x:0,y:0,z:0}, 'missile', 9);
assert.deepEqual(sent.map(m => [m.to,m.d]), [[from,70],[near,35]], 'one direct hit, linear splash, no distant hit'); sent.length = 0;
combat.impact({type:'building',id:{}}, {x:0,y:0,z:0}, 'shell', 10);
assert.equal(sent.length, 2); assert.ok(sent.every(m => m.t === 'hit')); sent.length = 0;
racing = true; combat.impact({type:'player',id:from}, car.pos, 'missile', 11); listeners.get('hit')(hit()); assert.equal(combat.state.health,100); assert.equal(sent.length,0);
racing = false; mp.weaponsEnabled = false; listeners.get('hit')(hit()); assert.equal(combat.state.health,100); mp.weaponsEnabled = true;
listeners.get('hit')(hit('missile',{from:'not-a-player'})); assert.equal(combat.state.health,100);
listeners.get('hit')(hit()); assert.equal(combat.state.health,30);
car.reset(); assert.equal(combat.state.health,100); assert.equal(combat.state.protected,true);
combat.fired(); assert.equal(combat.state.protected,false);
const material = car.mesh.children[0].material;
listeners.get('hit')(hit()); listeners.get('hit')(hit());
assert.equal(combat.stopped,true); assert.equal(car.combatWreck,true); assert.notEqual(car.mesh.children[0].material,material);
assert.equal(sent.at(-1).t,'wrecked'); assert.equal(sent.at(-1).by,from);
assert.equal(elements.find(e => e.id === 'combat-feed').textContent,'Ace wrecked Driver');
const resets = car.resets; car.reset(); assert.equal(car.resets,resets,'manual reset waits out ground wreck');
combat.update(3); assert.equal(car.resets,resets+1); assert.equal(car.mesh.children[0].material,material); assert.equal(combat.state.protected,true);
combat.update(.13); combat.draw(); assert.equal(car.mesh.visible,false,'protection blinks');
combat.fired(); combat.draw(); assert.equal(car.mesh.visible,true);
vehicles.current = jet; vehicles.switched(); assert.equal(combat.state.protected,true);
combat.fired(); jet.grace = 2; listeners.get('hit')(hit('shell')); listeners.get('hit')(hit('shell'));
assert.equal(jet.reason,'shot'); assert.equal(combat.stopped,false); assert.equal(combat.state.wrecked,true);
jet.reset(); assert.equal(combat.state.wrecked,false); assert.equal(combat.state.protected,true);
mp.inGame = false; combat.update(0); assert.equal(elements.find(e => e.id === 'combat-health').hidden,true);
combat.draw(); jet.mesh.visible = false; combat.draw(); assert.equal(jet.mesh.visible,false,'ordinary rendering visibility remains caller-owned');
const { animState, Net } = await import('../game/src/mp/net.js');
const { parseAnim } = await import('../game/src/mp/remotes.js');
const anim = animState({kind:'car',combatProtected:true,combatWreck:true,wheels:[{comp:0,contact:true}]});
assert.equal(parseAnim(anim).cp,true); assert.equal(parseAnim(anim).cw,true);
const net = new Net({ storage: null });
net._receive({t:'roster',players:[],weapons:false}); assert.equal(net.weaponsEnabled,false);
net._receive({t:'weapons-policy',enabled:true}); assert.equal(net.weaponsEnabled,true);
net._receive({t:'roster',players:[]}); assert.equal(net.weaponsEnabled,true,'old relay defaults on');
console.log('PASS combat integration: target authority, reset/switch hooks, wreck materials, aircraft crash dispatch, blink, HUD, policy, wire animation');
delete globalThis.document;
const { makeRemotes } = await import('../game/src/mp/remotes.js');
let now = 1000;
const remoteMP = { me: { id }, inGame: true, players: new Map(), on() {}, off() {}, now: () => now };
const remote = makeRemotes({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), mp: remoteMP, fx: false });
remote.receive({t:'roster', players:[{id:from,name:'Ace',skin:{vehicle:'car',type:'tank'}}]});
const packet = { t:'state',from,srvT:now,p:[0,0,10],q:[0,0,0,1],vel:[0,0,0],v:'car',w:[0,0,0,0],cw:1,cp:0 };
remote.receive(packet); remote.update(.01);
let targetCount = 0; remote.forEachCombat((id,p,kind,type) => { targetCount++; assert.equal(id,from); assert.equal(kind,'car'); assert.equal(type,'tank'); assert.equal(p.z,10); });
assert.equal(targetCount,1);
const remoteModel = remote.model(from);
assert.ok(remoteModel); let black = false; remoteModel.traverse(o => { if(o.material?.color?.getHex() === 0x24211f) black = true; }); assert.equal(black,true);
now += 100; remote.receive({...packet,srvT:now,cw:0,cp:1}); remote.update(.15); assert.equal(remoteModel.visible,false);
now += 5000; remote.update(.1); targetCount = 0; remote.forEachCombat(() => targetCount++); assert.equal(targetCount,0,'stale remotes are not targets');
remote.receive({t:'left',id:from}); remote.dispose();
console.log('PASS real remote puppets: tank bounds source, wreck blackening, protection blink, stale/leave cleanup');
