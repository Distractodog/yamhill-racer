// node tools/mp_bots.mjs [count=15] [--room CODE] [--relay ws://127.0.0.1:8787]
// With no --room, bot 1 hosts B2TS2; join B2TS2 in the game to observe the bots.
import { Net } from '../game/src/mp/net.js';
import fs from 'node:fs/promises';
import { makeWorld, makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';

const args = process.argv.slice(2);
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : undefined;
const count = Number(args[0]?.startsWith('--') ? 15 : args[0] ?? 15);
const relay = option('--relay') || process.env.YR_MP_RELAY || 'ws://127.0.0.1:8787';
const room = option('--room')?.toUpperCase() || 'B2TS2';
if (!Number.isInteger(count) || count < 1 || count > 16) throw new Error('Count must be 1–16 (leave a slot for your browser).');
// Node 22+ has a built-in WebSocket; older installs may use the local relay's ws dependency.
const WebSocketImpl = globalThis.WebSocket || (await import('ws')).WebSocket;
// Only the campus tile is needed; use the same ground queries as the game so bots are visible.
const asset = new URL('../game/assets/', import.meta.url);
const manifest = JSON.parse(await fs.readFile(new URL('world.json', asset), 'utf8'));
const world = makeWorld(manifest);
world.add(makeTileData(manifest, 0, 0, await readTileData(async file => {
  const data = await fs.readFile(new URL(`tiles/0_0/${file}`, asset));
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}, manifest.packed)));
const bots = [], start = Date.now();
const colors = ['#e8402f', '#279ae6', '#34b565', '#e2ca32', '#a448db', '#ed76a7'];
let motion;
function stop() {
  clearInterval(motion);
  for (const bot of bots) bot.net.leave();
}
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
try {
  for (let i = 0; i < count; i++) {
    const net = new Net({ WebSocketImpl, relay, storage: null });
    net.setName(`Bot ${String(i + 1).padStart(2, '0')}`);
    const kind = ['car', 'bike', 'jet'][i % 3];
    const vehicle = { pos: { x: -542, y: world.heightAt(-542, 440) + 1, z: 440 }, quat: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 0, y: 0, z: 0 }, glide: { active: false } };
    const paint = colors[i % colors.length];
    net.setVehicleSource(() => ({ vehicle, kind,
      colors: { body: paint, trim: '#ffffff', wheels: '#8a9099', helmet: paint, jacket: '#ffffff',
        gloves: '#20242a', livery: i % 2 ? 'stripes' : 'number', number: String(i + 1), wheelStyle: 'factory' },
      glider: kind === 'jet' ? {} : { wing: paint, stripe: '#ffffff', accent: '#faf6ea' } }));
    net.on('disconnected', ({ reason, retrying }) => console.log(`${net.me.name}: ${reason}${retrying ? ' (retrying)' : ''}`));
    bots.push({ net, vehicle, i });
    if (i === 0 && !option('--room')) { net.me.code = room; await net.host(); net.send({ t: 'join-policy', anyone: true }); }
    else await net.join(room);
  }
  motion = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    for (const { vehicle, i } of bots) {
      const radius = 25 + i * 5, speed = .18 + (i % 4) * .04;
      const angle = elapsed * speed + i * Math.PI * 2 / count, yaw = -angle;
      const x = -542 + radius * Math.cos(angle), z = 440 + radius * Math.sin(angle);
      Object.assign(vehicle.pos, { x, y: world.heightAt(x, z) + (i % 3 === 2 ? 40 : 1), z });
      Object.assign(vehicle.vel, { x: -radius * speed * Math.sin(angle), y: 0, z: radius * speed * Math.cos(angle) });
      Object.assign(vehicle.quat, { y: Math.sin(yaw / 2), w: Math.cos(yaw / 2) });
    }
  }, 1000 / 30);
  console.log(`${count} bots in ${room} via ${relay}. Ctrl-C to leave. Positions are synthetic, centred on campus.`);
} catch (e) {
  stop(); console.error(`Bots could not connect: ${e.message}`); process.exitCode = 1;
}
