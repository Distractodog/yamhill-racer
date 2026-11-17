// Ring buffers behind effects.js: soft sprites (tyre smoke, dust, spray, splash rings), flying chips (gravel, clods,
// grass clippings) and the tyre-mark ribbon. Plain typed arrays with a hard cap, no three.js / DOM (tools/tyrefx_test.mjs).
// Sprites and chips are written once, when they are thrown: start, velocity, drag, lift, birth time and life. The GPU
// moves and fades them from those numbers and the clock alone (effects.js shaders), so nothing is updated per particle
// per frame on the CPU; puffAt / chipAt below are the same formulas, for tests. A full ring reuses its oldest slot.
export const PUFF_A = 0, PUFF_B = 1, RING = 2, DROP = 3;   // sprite cells of the effects texture (RING lies flat)
export const STRIDE = 20;                                   // floats per slot (5 × vec4 in the shaders)
export const CHIP_G = 20;                                   // m/s² on chips (game gravity is 24; bits flutter a little)
const NONE = -1e9;

// distance moved after `a` s from speed v0 with drag k (1/s) and a steady acceleration g: dv/dt = g - k v
export const fly = (k, g, v0, a) => { k = Math.max(k, 0.05); return (g / k) * a + (v0 - g / k) * (1 - Math.exp(-k * a)) / k; };

class Ring {
  constructor(cap) {
    this.cap = cap; this.data = new Float32Array(cap * STRIDE); this.death = new Float32Array(cap).fill(NONE);
    this.cursor = 0; this.total = 0; this.reused = 0; this.until = NONE; this.n = 0; this.first = 0; this.fresh = 0;
  }
  slot(now, birth, life) {
    const i = this.cursor;
    this.cursor = (i + 1) % this.cap; this.total++;
    if (this.death[i] > now) this.reused++;
    this.death[i] = birth + life; if (birth + life > this.until) this.until = birth + life;
    if (!this.fresh) this.first = i;
    this.fresh = Math.min(this.cap, this.fresh + 1);
    return i;
  }
  // slots not yet faded at `now` (a slot born later, e.g. a ring where a drop will land, counts too)
  live(now, pred = null) { let n = 0; for (let i = 0; i < this.cap; i++) if (this.death[i] > now && (!pred || pred(i))) n++; return n; }
  count(now) { return (this.n = this.live(now)); }
  get drawn() { return Math.min(this.total, this.cap); }
  // the slots written since the last call, in floats: [[start, count], …] (two when it wrapped)
  takeDirty() {
    if (!this.fresh) return [];
    const a = this.first, n = this.fresh, end = Math.min(this.cap, a + n), r = [[a * STRIDE, (end - a) * STRIDE]];
    if (a + n > this.cap) r.push([0, (a + n - this.cap) * STRIDE]);
    this.fresh = 0; return r;
  }
  clear() { this.death.fill(NONE); this.until = NONE; this.n = 0; }
}

// slot: x y z birth | vx vy vz life | size grow rot spin | r g b alpha | ground drag lift kind
export class PuffRing extends Ring {
  spawn(o, now) {
    const birth = o.birth ?? now, i = this.slot(now, birth, o.life), d = this.data, k = i * STRIDE;
    d[k] = o.x; d[k + 1] = o.y; d[k + 2] = o.z; d[k + 3] = birth;
    d[k + 4] = o.vx; d[k + 5] = o.vy; d[k + 6] = o.vz; d[k + 7] = o.life;
    d[k + 8] = o.size; d[k + 9] = o.grow; d[k + 10] = o.rot; d[k + 11] = o.spin;
    d[k + 12] = o.r; d[k + 13] = o.g; d[k + 14] = o.b; d[k + 15] = o.alpha;
    d[k + 16] = o.ground; d[k + 17] = o.drag; d[k + 18] = o.lift; d[k + 19] = o.kind;
    return i;
  }
  kind(i) { return this.data[i * STRIDE + 19]; }
}
// where a sprite is at `now` and how it looks (the vertex shader in effects.js does exactly this); null = not drawn
export function puffAt(R, i, now, out = {}) {
  const d = R.data, k = i * STRIDE, age = now - d[k + 3], life = d[k + 7], kind = d[k + 19];
  if (age < 0 || age >= life) return null;
  const drag = d[k + 17], lift = d[k + 18], t = age / life;
  out.x = d[k] + fly(drag, 0, d[k + 4], age); out.y = d[k + 1] + fly(drag, lift, d[k + 5], age); out.z = d[k + 2] + fly(drag, 0, d[k + 6], age);
  out.size = d[k + 8] + d[k + 9] * (age - age * age / (2 * life));          // billows fast, then hangs
  out.rot = d[k + 10] + d[k + 11] * age;
  if (kind === RING) out.alpha = d[k + 15] * (1 - t) * Math.min(1, age / 0.06);
  else if (kind === DROP) out.alpha = out.y < d[k + 16] - 0.02 ? 0 : d[k + 15] * Math.min(1, (1 - t) * 4);
  else { out.alpha = d[k + 15] * Math.min(1, age / 0.12) * (1 - t) ** 1.6; out.y = Math.max(out.y, d[k + 16] + out.size * 0.2); }
  return out;
}

// slot: x y z birth | vx vy vz life | size flat ax ay | wx wy tLand drag | r g b ground
export class ChipRing extends Ring {
  spawn(o, now) {
    let land = o.life;                                     // when it reaches the ground: from then on it lies still
    for (let a = 0.02; a < o.life; a += 0.02) if (o.y + fly(o.drag, -CHIP_G, o.vy, a) < o.ground) { land = a; break; }
    const life = Math.min(o.life, land + 0.35), i = this.slot(now, now, life), d = this.data, k = i * STRIDE;
    d[k] = o.x; d[k + 1] = o.y; d[k + 2] = o.z; d[k + 3] = now;
    d[k + 4] = o.vx; d[k + 5] = o.vy; d[k + 6] = o.vz; d[k + 7] = life;
    d[k + 8] = o.size; d[k + 9] = o.flat; d[k + 10] = o.ax; d[k + 11] = o.ay;
    d[k + 12] = o.wx; d[k + 13] = o.wy; d[k + 14] = land; d[k + 15] = o.drag;
    d[k + 16] = o.r; d[k + 17] = o.g; d[k + 18] = o.b; d[k + 19] = o.ground;
    return i;
  }
}
export function chipAt(R, i, now, out = {}) {
  const d = R.data, k = i * STRIDE, age = now - d[k + 3], life = d[k + 7];
  if (age < 0 || age >= life) return null;
  const a = Math.min(age, d[k + 14]), drag = d[k + 15];
  out.x = d[k] + fly(drag, 0, d[k + 4], a); out.z = d[k + 2] + fly(drag, 0, d[k + 6], a);
  out.y = Math.max(d[k + 1] + fly(drag, -CHIP_G, d[k + 5], a), d[k + 19]);
  out.scale = d[k + 8] * Math.min(1, (life - age) / 0.3); out.landed = age >= d[k + 14];
  return out;
}

// Tyre marks: one ring buffer of quads (4 vertices each). A tyre's trail joins its quads at shared, mitred corners, so
// a mark is one smooth ribbon at any speed: no gaps, no zig-zags. Per vertex: position, colour, (alpha, across 0/1,
// time laid, rut 0/1); the shader fades marks by age. Only the quads written since the last upload are sent.
export class MarkStrip {
  constructor(maxSeg) {
    this.max = maxSeg;
    this.pos = new Float32Array(maxSeg * 12); this.col = new Float32Array(maxSeg * 12); this.info = new Float32Array(maxSeg * 16);
    this.i = 0; this.total = 0; this.changed = [];
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
    if (t.started && t.segTotal > this.total - this.max) {   // mitre the shared corner: half way between both sides
      jx = t.sx + sx; jz = t.sz + sz; const l = Math.hypot(jx, jz);
      if (l < 0.5) { jx = sx; jz = sz; } else { jx /= l; jz /= l; }
      const o = t.seg * 12 + 6, P = this.pos;
      P[o] = t.x + jx * halfW; P[o + 2] = t.z + jz * halfW; P[o + 3] = t.x - jx * halfW; P[o + 5] = t.z - jz * halfW;
      this.changed.push(t.seg);
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
    this.changed.push(s);
    Object.assign(t, { started: true, x, y, z, sx, sz, a: alpha, seg: s, segTotal: this.total });
    this.i = (this.i + 1) % this.max; this.total++;
    return true;
  }
  // the quads changed since the last call, as runs of neighbours: [[first, count], …] (a few small runs, never the whole)
  takeDirty() {
    const c = this.changed; if (!c.length) return [];
    c.sort((a, b) => a - b);
    const runs = [[c[0], 1]];
    for (let k = 1; k < c.length; k++) {
      const r = runs[runs.length - 1], end = r[0] + r[1];
      if (c[k] < end) continue;
      if (c[k] <= end + 8) r[1] = c[k] - r[0] + 1; else runs.push([c[k], 1]);   // small holes: one upload
    }
    c.length = 0; return runs;
  }
}

// 0..1 between edges a and b (GLSL smoothstep)
export const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
