import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
// distractodog stale-host regression: production lifecycle, fake time and delayed close transport.
const root = new URL('../', import.meta.url).pathname.replace(/\/$/, '');
const {Net} = await import(pathToFileURL(`${root}/game/src/mp/net.js`));
const {RelayRoom} = await import(pathToFileURL(`${root}/server/worker.js`));
const {Lobby} = await import(pathToFileURL(`${root}/server/lobby.mjs`));
class Time {
 t=0; next=0; jobs=new Map();
 setTimeout=(fn,ms)=>this.add(fn,ms,false); setInterval=(fn,ms)=>this.add(fn,ms,true);
 clearTimeout=id=>this.jobs.delete(id); clearInterval=this.clearTimeout;
 add(fn,ms,repeat){const id=++this.next;this.jobs.set(id,{fn,ms,repeat,at:this.t+ms});return id;}
 async advance(ms){const end=this.t+ms;for(;;){const e=[...this.jobs].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!e)break;const[id,j]=e;this.t=j.at;if(j.repeat)j.at+=j.ms;else this.jobs.delete(id);j.fn();await flush();}this.t=end;await flush();}
}
let queue=[];
async function flush(){while(queue.length){const work=queue;queue=[];await Promise.all(work);}await Promise.resolve();}
function context(sockets=[],data=new Map()) {let ready;return {get ready(){return ready;},getWebSockets:()=>sockets,blockConcurrencyWhile(fn){ready=fn();},waitUntil:p=>p,storage:{get:async k=>data.get(k),put:async(k,v)=>data.set(k,structuredClone(v)),delete:async k=>data.delete(k),setAlarm:async at=>data.set('alarm',at),deleteAlarm:async()=>data.delete('alarm')},data};}
async function fixture(){
 const time=new Time();const oldNow=Date.now;Date.now=()=>time.t;
 const lc=context(),lobby=new Lobby(lc);await lc.ready;
 const env={LOBBY:{idFromName:()=> 'public',get:()=>lobby}};
 const servers=[],ctx=context(servers);let relay=new RelayRoom(ctx,env);await ctx.ready;
 relay.room.code='ABCDE';const sockets=[];
 class Socket {
  readyState=0;bufferedAmount=0;
  constructor(url){this.url=new URL(url);sockets.push(this);this.server={send:text=>{time.setTimeout(()=>this.onmessage?.({data:text}),0);},close:()=>{time.setTimeout(()=>{this.readyState=3;this.onclose?.();},0);},serializeAttachment:a=>{this.attachment=structuredClone(a);},deserializeAttachment:()=>this.attachment};servers.push(this.server);time.setTimeout(()=>{this.readyState=1;relay.room.connect(this.url.searchParams.get('id'),this.server);relay.saveSession(this.server);this.onopen?.();},0);}
  send(text){queue.push(relay.webSocketMessage(this.server,text));}
  // Model a local close/error whose server-side close event has not arrived.
  close(){this.readyState=3;}
  error(){this.onerror?.();}
 }
 const values=new Map([['yr-mp-id-1','Host00000001'],['yr-mp-code-1','ABCDE'],['yr-mp-name-1','distractodog']]);
 const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
 const make=(clientStorage=storage)=>new Net({storage:clientStorage,WebSocketImpl:Socket,timers:time,clock:()=>time.t,fetchImpl:async()=>Response.json({games:lobby.state.list()})});
 const host=make();const p=host.host();await time.advance(0);await p;
 const log=label=>console.log(JSON.stringify({case:label,t:time.t,clientInGame:host.inGame,listed:lobby.state.list().map(g=>g.name),roomHost:!!relay.room.host}));
 return {time,lobby,host,make,sockets,ctx,env,log,get relay(){return relay;},async hibernate(){const next=context(servers,ctx.data);relay=new RelayRoom(next,env);await next.ready;},async cleanup(){for(const s of sockets)s.onopen=s.onmessage=s.onclose=s.onerror=null;host.leave();await flush();Date.now=oldNow;}};
}const peer = () => ({ messages: [], send(text) { this.messages.push(JSON.parse(text)); }, close() {},
 serializeAttachment(a) { this.a = structuredClone(a); }, deserializeAttachment() { return this.a; } });
const joinMessage = { t: 'join-request', name: 'Guest', code: 'FGHJK', host: false, skin: { vehicle: 'car' } };
async function guest(f, id = 'Guest0000001', admit = true) {
 const ws = peer(); f.ctx.getWebSockets().push(ws); f.relay.room.connect(id, ws);
 await f.relay.webSocketMessage(ws, JSON.stringify(joinMessage));
 if (admit) await f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'join-accept', id }));
 return ws;
}
async function rehost(f) { const p = f.host.host(); await f.time.advance(0); await p; }
{
 const f = await fixture();
 try {
  const g = await guest(f), pending = await guest(f, 'Guest0000002', false);
  await f.relay.webSocketMessage(g, JSON.stringify({ t: 'leave', id: f.host.me.id }));
  assert.ok(f.relay.room.host, 'Leave cannot exercise authority over an arbitrary ID');
  f.host.leave(); await f.time.advance(0);
  assert.equal(f.relay.room.host, undefined, 'application Leave releases membership without any transport close');
  assert.deepEqual(f.lobby.state.list(), []);
  assert.equal(g.a.session, null); assert.equal(pending.a.session, null);
  assert.equal(f.lobby.state.requests.get('Guest0000002').until, 0);
  await rehost(f);
  const current = f.relay.room.host;
  await f.relay.webSocketClose(f.sockets[0].server);
  await f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'leave', id: current.id }));
  assert.equal(f.relay.room.host, current, 'old socket close/message cannot remove a new host');
  const second = f.make();
  const duplicate = second.host().then(() => 'connected', e => e.reason); await f.time.advance(0);
  assert.equal(await duplicate, 'duplicate-id'); assert.equal(f.relay.room.host, current);
  second.leave();
 } finally { await f.cleanup(); }
}
{
 const f = await fixture();
 try {
  const g = await guest(f); f.host._clearConnection(); // refresh/lost tab: no application Leave or close delivery
  await f.time.advance(29999); await f.relay.alarm();
  assert.ok(f.relay.room.host); assert.equal(f.lobby.state.list().length, 1);
  await f.time.advance(1);
  // Enforced before guest-driven publication, even when the alarm has not been delivered.
  await f.relay.webSocketClose(g);
  assert.equal(f.relay.room.host, undefined); assert.deepEqual(f.lobby.state.list(), []);
  await f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'heartbeat' }));
  assert.equal(f.relay.room.host, undefined, 'late heartbeat cannot resurrect');
  await rehost(f); assert.ok(f.relay.room.host);
 } finally { await f.cleanup(); }
}
{
 const f = await fixture();
 try {
  const g = await guest(f), pending = await guest(f, 'Guest0000002', false);
  f.host._clearConnection();
  await f.time.advance(10000);
  await f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'heartbeat' }));
  assert.equal(f.ctx.data.get('alarm'), 30000, 'pending guest deadline precedes renewed host deadline');
  await f.time.advance(19999); assert.ok(f.relay.room.host);
  await f.time.advance(1); await f.relay.alarm();
  assert.ok(f.relay.room.host); assert.equal(pending.a.session, null);
  assert.equal(f.ctx.data.get('alarm'), 40000, 'fresh heartbeat extends the host lease');
  for (const t of ['ping', 'state', 'skin']) await f.relay.webSocketMessage(g, JSON.stringify({ t, skin: { vehicle: 'bike' } }));
  await f.time.advance(9999); assert.equal(f.lobby.state.list().length, 1);
  await f.time.advance(1); await f.relay.alarm();
  assert.equal(f.relay.room.host, undefined); assert.deepEqual(f.lobby.state.list(), []);
  assert.equal(f.sockets[0].attachment.session, null); assert.equal(g.a.session, null);
  await rehost(f);
 } finally { await f.cleanup(); }
}
{
 const f = await fixture();
 try {
  const g = await guest(f), pending = await guest(f, 'Guest0000002', false);
  await f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'world', mode: 'host', settings: {} }));
  f.host._clearConnection(); await f.time.advance(30000); await f.hibernate();
  assert.equal(f.relay.room.host, undefined, 'hibernation restore enforces persisted deadline before traffic');
  assert.equal(f.relay.room.world, null); assert.equal(f.ctx.data.has('world'), false);
  assert.deepEqual(f.lobby.state.list(), []); assert.equal(g.a.session, null); assert.equal(pending.a.session, null);
  await rehost(f); await f.hibernate(); assert.ok(f.relay.room.host, 'removed old attachments cannot resurrect on second restore');
 } finally { await f.cleanup(); }
}
// An earlier discovery write waiting in flight cannot land after a fresh generation's publication.
{
 const f = await fixture();
 try {
  const call = f.relay.lobby.call.bind(f.relay.lobby); let unblock, begun;
  const started = new Promise(resolve => { begun = resolve; }); let hold = true;
  f.relay.lobby.call = async (path, body) => {
   if (path === 'update' && hold) { hold = false; begun(); await new Promise(resolve => { unblock = resolve; }); }
   return call(path, body);
  };
  const heartbeat = f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'heartbeat' }));
  await started;
  const leaving = f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'leave' }));
  // Wait for Leave's synchronous mutation without awaiting its queued discovery write.
  for (let i = 0; i < 20 && f.relay.room.host; i++) await Promise.resolve();
  assert.equal(f.relay.room.host, undefined);
  const next = peer(); f.relay.room.connect(f.host.me.id, next);
  const hosting = f.relay.webSocketMessage(next, JSON.stringify({ t: 'hello', name: 'New Host', code: 'ABCDE', host: true, skin: { vehicle: 'car' } }));
  unblock(); await Promise.all([heartbeat, leaving, hosting]);
  await f.relay.webSocketClose(f.sockets[0].server);
  assert.equal(f.lobby.state.list()[0].name, 'New Host');
 } finally { await f.cleanup(); }
}
console.log('PASS distractodog lifecycle: explicit Leave, missing closes, 29999/30000 boundary, heartbeat lease, guests, alarms, hibernation, rehost, duplicate tab, old callbacks and ordered publication');

// Real race core + Net + DO lifecycle: finish -> exit stays connected; refresh then expires/rehosts.
{
 const { createRaceCore } = await import('../game/src/mp/racecore.js');
 const f = await fixture(); const g = f.make(null); g.setName('Guest');
 const cores = [];
 try {
  f.host.send({ t: 'join-policy', anyone: true }); await f.time.advance(0);
  const joining = g.join('ABCDE'); await f.time.advance(0); await joining;
  const race = mp => {
   let core;
   const challenges = { list: [{ id: 'race', name: 'Race' }], state: 'idle',
    start() { this.state = 'running'; }, quit() { core.hook.onQuit(); this.state = 'idle'; },
    runInfo: () => null };
   core = createRaceCore({ mp, challenges, timers: f.time, ui: {} }); cores.push(core);
   return { core, challenges };
  };
  const h = race(f.host), guestRace = race(g);
  assert.equal(h.core.invite('race', [g.me.id]), true);
  for (let turn = 0; turn < 5; turn++) await f.time.advance(0);
  assert.ok(guestRace.core.incoming);
  guestRace.core.accept();
  for (let turn = 0; turn < 5; turn++) await f.time.advance(0);
  assert.ok(h.core.active);
  await f.time.advance(5000);
  h.core.hook.onFinish(); h.challenges.state = 'finished';
  guestRace.core.hook.onFinish(); guestRace.challenges.state = 'finished'; await f.time.advance(0);
  h.challenges.quit(); guestRace.challenges.quit();
  assert.equal(h.core.active, null); assert.equal(guestRace.core.active, null);
  assert.ok(f.host.inGame && g.inGame); assert.equal(f.relay.room.players.length, 2);
  assert.equal((await f.host.listGames())[0].players, 2);
  f.host._clearConnection(); // Browser refresh with the server close callback withheld.
  await f.time.advance(30000); await f.relay.alarm(); await f.time.advance(0);
  assert.deepEqual(await g.listGames(), []); assert.equal(g.inGame, false);
  const refreshed = f.make(); const hosting = refreshed.host(); await f.time.advance(0); await hosting;
  assert.ok(refreshed.inGame); refreshed.leave(); await f.time.advance(0);
  assert.deepEqual(f.lobby.state.list(), []);
 } finally { for (const core of cores) core.dispose(); g.leave(); await f.cleanup(); }
}
console.log('PASS distractodog: finish -> quit retains network membership; lost-refresh expiry and fresh same-identity hosting');

// A closing generation's slow layout deletion must finish before the new host's persisted layout.
{
 const f = await fixture();
 try {
  await f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'layout', revision: 'old', index: 0, total: 1, data: '{}' }));
  const remove = f.ctx.storage.delete; let unblock, begun, hold = true;
  const started = new Promise(resolve => { begun = resolve; });
  f.ctx.storage.delete = async key => {
   if (key === 'layout' && hold) { hold = false; begun(); await new Promise(resolve => { unblock = resolve; }); }
   return remove(key);
  };
  const leaving = f.relay.webSocketMessage(f.sockets[0].server, JSON.stringify({ t: 'leave' })); await started;
  const next = peer(); f.ctx.getWebSockets().push(next); f.relay.room.connect(f.host.me.id, next);
  await f.relay.webSocketMessage(next, JSON.stringify({ t: 'hello', host: true, name: 'New Host', code: 'ABCDE', skin: { vehicle: 'car' } }));
  const layout = f.relay.webSocketMessage(next, JSON.stringify({ t: 'layout', revision: 'new', index: 0, total: 1, data: '{"new":true}' }));
  unblock(); await Promise.all([leaving, layout]);
  await f.relay.webSocketClose(f.sockets[0].server); await f.hibernate();
  assert.equal(f.relay.room.layout[0].revision, 'new'); assert.equal(f.relay.room.host.player.name, 'New Host');
 } finally { await f.cleanup(); }
}
console.log('PASS distractodog: overlapping old-host layout cleanup cannot erase a new host layout on restore');
