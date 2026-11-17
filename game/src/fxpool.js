// Pools behind effects.js: soft sprites (tyre smoke, dust, spray, splash rings), flying chips (gravel, clods, grass
// clippings) and the tyre-mark ribbon. Plain typed arrays with a hard cap, no three.js / DOM (tools/tyrefx_test.mjs).
export const PUFF_A = 0, PUFF_B = 1, RING = 2, DROP = 3;   // sprite cells of the effects texture (RING lies flat)

const IN = 0.12;                                          // s: a sprite fades in this fast (no popping)

// Sprites: spawn(o) copies o's fields; when the pool is full the shortest-lived of a few live ones is reused.
export class PuffPool {
  constructor(cap) {
    this.cap = cap;
    const f = () => new Float32Array(cap);
    Object.assign(this, { x: f(), y: f(), z: f(), vx: f(), vy: f(), vz: f(), life: f(), max: f(), size: f(), grow: f(),
      rot: f(), spin: f(), a0: f(), r: f(), g: f(), b: f(), ground: f(), drag: f(), lift: f(), key: f() });
    this.kind = new Uint8Array(cap);
    this.alive = new Int32Array(cap); this.n = 0;          // live indices, back to front after sort()
    this.free = new Int32Array(cap); this.nFree = cap;
    for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i;
    this.reused = 0; this.seed = 1;
  }
  rand() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647; }
  spawn(o) {
    let i;
    if (this.nFree) { i = this.free[--this.nFree]; this.alive[this.n++] = i; }
    else {                                                  // full: take the live one nearest its end out of 6 tries
      i = this.alive[0];
      for (let k = 0; k < 6; k++) { const j = this.alive[(this.rand() * this.n) | 0]; if (this.life[j] < this.life[i]) i = j; }
      this.reused++;
    }
    this.x[i] = o.x; this.y[i] = o.y; this.z[i] = o.z; this.vx[i] = o.vx; this.vy[i] = o.vy; this.vz[i] = o.vz;
    this.life[i] = this.max[i] = o.life; this.size[i] = o.size; this.grow[i] = o.grow; this.rot[i] = o.rot; this.spin[i] = o.spin;
    this.a0[i] = o.alpha; this.r[i] = o.r; this.g[i] = o.g; this.b[i] = o.b; this.ground[i] = o.ground;
    this.drag[i] = o.drag; this.lift[i] = o.lift; this.kind[i] = o.kind;
    return i;
  }
  // move and age; onLand(i) for a falling drop that reaches its ground (water surface) before it dies
  step(dt, onLand = null) {
    for (let k = 0; k < this.n;) {
      const i = this.alive[k];
      if ((this.life[i] -= dt) <= 0) { this.alive[k] = this.alive[--this.n]; this.free[this.nFree++] = i; continue; }
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d; this.vy[i] = this.vy[i] * d + this.lift[i] * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      const kind = this.kind[i];
      if (kind === DROP) {
        if (this.vy[i] < 0 && this.y[i] < this.ground[i]) { onLand?.(i); this.life[i] = 0; }
      } else if (kind !== RING) {                           // a cloud never sinks into the ground it rose from
        const floor = this.ground[i] + this.size[i] * 0.2;
        if (this.y[i] < floor) { this.y[i] = floor; if (this.vy[i] < 0) this.vy[i] = 0; }
      }
      this.size[i] += this.grow[i] * dt * (this.life[i] / this.max[i]);   // billows fast, then hangs
      this.rot[i] += this.spin[i] * dt;
      k++;
    }
  }
  alpha(i) {
    const age = this.max[i] - this.life[i], t = age / this.max[i], kind = this.kind[i];
    if (kind === RING) return this.a0[i] * (1 - t) * Math.min(1, age / 0.06);
    if (kind === DROP) return this.a0[i] * Math.min(1, (1 - t) * 4);
    return this.a0[i] * Math.min(1, age / IN) * (1 - t) ** 1.6;
  }
  // back to front from the camera (nearly sorted from the last frame: insertion sort, full sort if it got shuffled)
  sort(cx, cy, cz) {
    const A = this.alive, K = this.key, n = this.n;
    for (let k = 0; k < n; k++) { const i = A[k], dx = this.x[i] - cx, dy = this.y[i] - cy, dz = this.z[i] - cz; K[i] = dx * dx + dy * dy + dz * dz; }
    let moves = 0;
    for (let k = 1; k < n; k++) {
      const i = A[k], v = K[i]; let j = k - 1;
      while (j >= 0 && K[A[j]] < v) { A[j + 1] = A[j]; j--; if (++moves > 16 * n + 64) break; }
      A[j + 1] = i;
      if (moves > 16 * n + 64) { const s = Array.from(A.subarray(0, n)).sort((a, b) => K[b] - K[a]); A.set(s); return; }
    }
  }
  clear() { this.n = 0; this.nFree = this.cap; for (let i = 0; i < this.cap; i++) { this.free[i] = this.cap - 1 - i; this.life[i] = 0; } }
}

// Chips: tiny tumbling bits with gravity that bounce once and settle, then shrink away
export class ChipPool {
  constructor(cap, gravity = 20) {
    this.cap = cap; this.gravity = gravity;
    const f = () => new Float32Array(cap);
    Object.assign(this, { x: f(), y: f(), z: f(), vx: f(), vy: f(), vz: f(), life: f(), max: f(), size: f(), flat: f(),
      ax: f(), ay: f(), wx: f(), wy: f(), r: f(), g: f(), b: f(), ground: f(), drag: f() });
    this.bounced = new Uint8Array(cap);
    this.alive = new Int32Array(cap); this.n = 0;
    this.free = new Int32Array(cap); this.nFree = cap;
    for (let i = 0; i < cap; i++) this.free[i] = cap - 1 - i;
    this.reused = 0; this.cursor = 0;
  }
  spawn(o) {
    let i;
    if (this.nFree) { i = this.free[--this.nFree]; this.alive[this.n++] = i; }
    else { i = this.alive[this.cursor++ % this.n]; this.reused++; }
    this.x[i] = o.x; this.y[i] = o.y; this.z[i] = o.z; this.vx[i] = o.vx; this.vy[i] = o.vy; this.vz[i] = o.vz;
    this.life[i] = this.max[i] = o.life; this.size[i] = o.size; this.flat[i] = o.flat; this.ax[i] = o.ax; this.ay[i] = o.ay;
    this.wx[i] = o.wx; this.wy[i] = o.wy; this.r[i] = o.r; this.g[i] = o.g; this.b[i] = o.b; this.ground[i] = o.ground;
    this.drag[i] = o.drag; this.bounced[i] = 0;
    return i;
  }
  step(dt) {
    for (let k = 0; k < this.n;) {
      const i = this.alive[k];
      if ((this.life[i] -= dt) <= 0) { this.alive[k] = this.alive[--this.n]; this.free[this.nFree++] = i; continue; }
      const d = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= d; this.vz[i] *= d; this.vy[i] = this.vy[i] * d - this.gravity * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      this.ax[i] += this.wx[i] * dt; this.ay[i] += this.wy[i] * dt;
      if (this.y[i] < this.ground[i]) {
        this.y[i] = this.ground[i];
        if (!this.bounced[i] && this.vy[i] < -2) { this.bounced[i] = 1; this.vy[i] *= -0.3; this.vx[i] *= 0.45; this.vz[i] *= 0.45; this.wx[i] *= 0.5; }
        else { this.vx[i] = this.vy[i] = this.vz[i] = this.wx[i] = this.wy[i] = 0; this.life[i] = Math.min(this.life[i], 0.35); }
      }
      k++;
    }
  }
  scale(i) { return this.size[i] * Math.min(1, this.life[i] / 0.3); }  // shrinks away at the end of its life
  clear() { this.n = 0; this.nFree = this.cap; for (let i = 0; i < this.cap; i++) { this.free[i] = this.cap - 1 - i; this.life[i] = 0; } }
}

// Tyre marks: one ring buffer of quads (4 vertices each). A tyre's trail joins its quads at shared, mitred corners, so
// a mark is one smooth ribbon at any speed: no gaps, no zig-zags. Per vertex: position, colour, (alpha, across 0/1,
// time laid, rut 0/1); the shader fades marks by age.
export class MarkStrip {
  constructor(maxSeg) {
    this.max = maxSeg;
    this.pos = new Float32Array(maxSeg * 12); this.col = new Float32Array(maxSeg * 12); this.info = new Float32Array(maxSeg * 16);
    this.i = 0; this.total = 0; this.lo = Infinity; this.hi = -1;
  }
  static trail() { return { has: false, started: false, x: 0, y: 0, z: 0, sx: 0, sz: 0, a: 0, seg: -1, segTotal: -1 }; }
  // t: one tyre's trail; (x, y, z) its contact point; minLen / maxLen: shorter steps wait, longer ones start a new mark
  add(t, x, y, z, halfW, alpha, r, g, b, time, rut, minLen = 0.35, maxLen = 3) {
    if (!t.has) { Object.assign(t, { has: true, started: false, x, y, z, a: alpha }); return false; }
    const dx = x - t.x, dz = z - t.z, d2 = dx * dx + dz * dz;
    if (d2 < minLen * minLen) return false;
    if (d2 > maxLen * maxLen || Math.abs(y - t.y) > 1.2) { Object.assign(t, { started: false, x, y, z, a: alpha }); return false; }
    const len = Math.sqrt(d2), sx = dz / len, sz = -dx / len;
    let jx = sx, jz = sz;
    const prevLive = t.started && t.segTotal > this.total - this.max;
    if (prevLive) {                                         // mitre the shared corner: half way between both sides
      jx = t.sx + sx; jz = t.sz + sz; const l = Math.hypot(jx, jz);
      if (l < 0.5) { jx = sx; jz = sz; } else { jx /= l; jz /= l; }
      const o = t.seg * 12 + 6, P = this.pos;
      P[o] = t.x + jx * halfW; P[o + 2] = t.z + jz * halfW; P[o + 3] = t.x - jx * halfW; P[o + 5] = t.z - jz * halfW;
      this.dirty(t.seg);
    }
    const s = this.i, o = s * 12, P = this.pos, C = this.col, I = this.info;
    P[o] = t.x + jx * halfW; P[o + 1] = t.y; P[o + 2] = t.z + jz * halfW;
    P[o + 3] = t.x - jx * halfW; P[o + 4] = t.y; P[o + 5] = t.z - jz * halfW;
    P[o + 6] = x + sx * halfW; P[o + 7] = y; P[o + 8] = z + sz * halfW;
    P[o + 9] = x - sx * halfW; P[o + 10] = y; P[o + 11] = z - sz * halfW;
    for (let v = 0; v < 4; v++) {
      C[o + v * 3] = r; C[o + v * 3 + 1] = g; C[o + v * 3 + 2] = b;
      const q = s * 16 + v * 4;
      I[q] = v < 2 ? (t.started ? t.a : 0) : alpha; I[q + 1] = v & 1; I[q + 2] = time; I[q + 3] = rut;
    }
    this.dirty(s);
    Object.assign(t, { started: true, x, y, z, sx, sz, a: alpha, seg: s, segTotal: this.total });
    this.i = (this.i + 1) % this.max; this.total++;
    return true;
  }
  dirty(s) { if (s < this.lo) this.lo = s; if (s > this.hi) this.hi = s; }
  // the changed segments since the last call: [first, count] or null
  takeDirty() {
    if (this.hi < 0) return null;
    const r = [this.lo, this.hi - this.lo + 1]; this.lo = Infinity; this.hi = -1; return r;
  }
}

// 0..1 between edges a and b (GLSL smoothstep)
export const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
