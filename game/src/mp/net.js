// Transport only: importing this module never opens a socket or starts a timer.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
function storageDefault() { try { return globalThis.localStorage; } catch { return null; } }
function randomText(length) {
  const bytes = new Uint8Array(length);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
}
function error(reason) { return Object.assign(new Error(reason), { reason }); }
export const LOCAL_RELAY = 'ws://127.0.0.1:8787', DEPLOYED_RELAY = 'wss://yamhill-racer-relay.yamhill-racer.workers.dev';
// window.YR_MP_RELAY, else ?relay=ws(s)://… on the page URL (testing), else the local stand-in for a page served from
// 127.0.0.1 / localhost (or no page: Node tools) and the deployed Cloudflare relay everywhere else
export function defaultRelay(win = globalThis.window) {
  if (win?.YR_MP_RELAY) return win.YR_MP_RELAY;
  let query = null; try { query = new URLSearchParams(win?.location?.search || '').get('relay'); } catch {}
  if (query && /^wss?:\/\/[^\s]+$/i.test(query)) return query;
  const host = win?.location?.hostname;
  return !win?.location || host === '127.0.0.1' || host === 'localhost' ? LOCAL_RELAY : DEPLOYED_RELAY;
}

export class Net {
  constructor({ WebSocketImpl = globalThis.WebSocket, storage = storageDefault(), relay,
    clock = () => Date.now(), timers = globalThis } = {}) {
    this._WebSocket = WebSocketImpl; this._storage = storage; this._relay = relay;
    this._clock = clock; this._timers = timers; this._events = new Map();
    const read = (key, valid, fallback) => {
      let value; try { value = storage?.getItem(key); } catch {}
      if (!valid(value)) value = fallback();
      try { storage?.setItem(key, value); } catch {}
      return value;
    };
    this.me = {
      id: read('yr-mp-id-1', v => typeof v === 'string' && /^[A-Za-z0-9]{12}$/.test(v), () => randomText(12)),
      code: read('yr-mp-code-1', v => CODE.test(v), () => randomText(5)),
      name: read('yr-mp-name-1', v => typeof v === 'string' && !!v.trim(), () => `Racer${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`),
    };
    this.inGame = false; this.isHost = false; this.roomCode = null; this.players = new Map();
    this._offset = 0; this._pings = new Map(); this._socket = null; this._pending = null;
    this._stateTimer = null; this._pingTimer = null; this._timeout = null; this._retryTimer = null;
    this._source = () => null; this._skinSignature = ''; this._retried = false;
  }

  // Main supplies the live player proxy and the getters returned by cosmetics/glidercolors.
  // Read only at 15 Hz while connected, including colours changed without storage access.
  setVehicleSource(source) { this._source = source; }
  setName(name) {
    this.me.name = String(name ?? '').trim() || 'Racer';
    try { this._storage?.setItem('yr-mp-name-1', this.me.name); } catch {}
    // The wire protocol carries names in hello; the new name applies on the next connection.
  }
  on(type, fn) {
    if (!this._events.has(type)) this._events.set(type, new Set());
    this._events.get(type).add(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) { this._events.get(type)?.delete(fn); }
  _emit(type, message) {
    for (const fn of [...(this._events.get(type) || [])]) {
      try { fn(message); } catch (e) { console.error('Multiplayer event handler:', e); }
    }
  }
  now() { return this._clock() + this._offset; }
  host() { return this._start(this.me.code, true); }
  join(code) {
    code = String(code ?? '').trim().toUpperCase();
    if (!CODE.test(code)) return Promise.reject(error('invalid-code'));
    return this._start(code, false);
  }
  _start(code, host) {
    this.leave();
    this.roomCode = code; this.isHost = host; this._retried = false; this._offset = 0;
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject };
      this._connect();
    });
  }
  _connect() {
    let socket;
    try {
      const relay = this._relay ?? defaultRelay();
      socket = new this._WebSocket(`${relay.replace(/\/$/, '')}/room/${this.roomCode}?id=${encodeURIComponent(this.me.id)}`);
    } catch { this._end('connection-failed'); return; }
    this._socket = socket;
    this._timeout = this._timers.setTimeout(() => {
      if (this._socket === socket) this._end('timeout');
    }, 10000);
    socket.onopen = () => {
      if (socket !== this._socket) return;
      const skin = this._skin();
      this._skinSignature = JSON.stringify(skin);
      this._write({ t: 'hello', name: this.me.name, code: this.me.code, host: this.isHost, skin });
    };
    socket.onmessage = event => {
      if (socket !== this._socket) return;
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || typeof msg.t !== 'string') return;
      this._receive(msg);
    };
    socket.onerror = () => {
      // Browsers also close failed sockets; handle fakes/platforms that only report error.
      if (socket === this._socket) this._drop('connection-failed');
    };
    socket.onclose = () => { if (socket === this._socket) this._drop('connection-lost'); };
  }
  _receive(msg) {
    if (msg.t === 'closed' || msg.t === 'kicked') {
      this._emit(msg.t, msg);
      this._end(msg.reason || msg.t);
      return;
    }
    if (msg.t === 'roster' && Array.isArray(msg.players)) {
      this.players.clear();
      for (const p of msg.players) if (p && typeof p.id === 'string') this.players.set(p.id, p);
      if (!this.inGame && this.players.has(this.me.id)) {
        this.inGame = true;
        this._timers.clearTimeout(this._timeout); this._timeout = null;
        this._pending?.resolve(); this._pending = null;
        this._stateTimer = this._timers.setInterval(() => this._tick(), 1000 / 15);
        this._pingTimer = this._timers.setInterval(() => this._ping(), 5000);
        this._ping();
        this._emit('connected', { roomCode: this.roomCode, isHost: this.isHost });
      }
    } else if (msg.t === 'joined' && msg.player) this.players.set(msg.player.id, msg.player);
    else if (msg.t === 'left') this.players.delete(msg.id);
    else if (msg.t === 'pong' && this._pings.has(msg.c) && Number.isFinite(msg.srvT)) {
      this._offset = msg.srvT - (this._pings.get(msg.c) + this._clock()) / 2;
      this._pings.delete(msg.c);
    } else if (msg.t === 'ping') this.send({ t: 'pong', c: msg.c });
    this._emit(msg.t, msg);
  }
  _ping() {
    const c = this._clock();
    this._pings.clear(); this._pings.set(c, c);
    this.send({ t: 'ping', c });
  }
  _skin(sample = this._source()) {
    const kind = sample?.kind || sample?.vehicle?.kind || 'car';
    return { vehicle: kind, colors: sample?.colors || {}, glider: sample?.glider || {} };
  }
  _tick() {
    if (!this.inGame) return;
    const sample = this._source(), vehicle = sample?.vehicle;
    const skin = this._skin(sample), signature = JSON.stringify(skin);
    if (signature !== this._skinSignature && this.send({ t: 'skin', skin })) this._skinSignature = signature;
    if (!vehicle) return;
    const p = vehicle.pos, q = vehicle.quat, vel = vehicle.vel;
    if (!p || !q || !vel) return;
    const state = { t: 'state', v: skin.vehicle, p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w],
      grounded: !!vehicle.grounded, mode: vehicle.kind === 'jet' ? vehicle.mode : undefined,
      ghostUntil: Number.isFinite(vehicle.ghostUntil) ? vehicle.ghostUntil : 0,
      vel: [vel.x, vel.y, vel.z], glide: !!vehicle.glide?.active, ts: this.now() };
    if ([...state.p, ...state.q, ...state.vel].every(Number.isFinite)) this.send(state);
  }
  _write(msg) {
    if (this._socket?.readyState !== 1) return false;
    // Drop stale state under back pressure rather than queueing minutes of old positions.
    if (msg.t === 'state' && this._socket.bufferedAmount > 65536) return false;
    try { this._socket.send(JSON.stringify(msg)); return true; } catch { return false; }
  }
  send(msg) { return this.inGame && this._write(msg); }
  _clearConnection() {
    this._timers.clearInterval(this._stateTimer); this._timers.clearInterval(this._pingTimer);
    this._timers.clearTimeout(this._timeout);
    this._stateTimer = this._pingTimer = this._timeout = null;
    this._pings.clear();
    const socket = this._socket; this._socket = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; socket.close(); }
  }
  _drop(reason) {
    const retry = this.inGame && !this._retried;
    if (!retry) { this._end(reason); return; }
    this._clearConnection(); this.inGame = false; this.players.clear(); this._retried = true;
    this._retryTimer = this._timers.setTimeout(() => { this._retryTimer = null; this._connect(); }, 500);
    this._emit('disconnected', { reason, retrying: true });
  }
  _end(reason) {
    const active = !!this.roomCode;
    this._timers.clearTimeout(this._retryTimer); this._retryTimer = null;
    this._clearConnection(); this.inGame = false; this.isHost = false; this.roomCode = null; this.players.clear();
    this._pending?.reject(error(reason)); this._pending = null;
    if (active) this._emit('disconnected', { reason, retrying: false });
  }
  leave() { this._end('left'); }
}

export const mp = new Net();
