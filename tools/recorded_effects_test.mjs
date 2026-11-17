import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EFFECT_RECORDINGS, recordedEffect, effectSoundLog } from '../game/src/audio/recordings.js';
import { EffectsAudio } from '../game/src/audio/effects.js';

class Node {
  constructor() {
    const param = () => ({ value: 1, setTargetAtTime(v) { this.value = v; } });
    this.gain = param(); this.frequency = param(); this.Q = param(); this.playbackRate = param();
  }
  connect(n) { return n; }
  disconnect() { this.disconnected = true; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
const context = () => ({
  currentTime: 0, sampleRate: 44100, sources: [], decodes: 0,
  createGain: () => new Node(), createBiquadFilter: () => new Node(),
  createBufferSource() { const n = new Node(); this.sources.push(n); return n; },
  createBuffer(c, n, rate) { const data = new Float32Array(n); return { duration: n / rate, getChannelData: () => data }; },
  async decodeAudioData() { this.decodes++; return { duration: 1.5, sampleRate: 44100 }; },
});
const car = { type: 'race', kind: 'car', vel: { length: () => 30 }, grounded: true, surface: 3, slip: .4 };
let fetches = 0;
globalThis.fetch = async () => { fetches++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(44) }; };
const ctx = context(), a = new EffectsAudio(ctx, new Node()), b = new EffectsAudio(ctx, new Node(), { remote: true });
assert.equal(fetches, 0, 'nothing loads before use');
a.update(car, .016); b.update(car, .016);
await recordedEffect(ctx, 'squeal').ready;
assert.equal(fetches, 1); assert.equal(ctx.decodes, 1);
assert.equal(a.sources.at(-1).buffer, b.sources.at(-1).buffer, 'voices share decoded recording');
assert.equal(a.channels.squeal.fallback.gain.value, 0, 'synthesis fades only after successful decode');
assert.equal(a.nodes.at(-1).gain.value, 1, 'recording fades in');
const shotIndex = ctx.sources.length;
a.shot('impact', .5);
assert.equal(ctx.sources[shotIndex].buffer.duration, .45, 'first impact uses immediate fallback');
await recordedEffect(ctx, 'impact').ready;
assert.equal(ctx.sources.length, shotIndex + 1, 'download never replays old impact');
b.shot('impact', .5);
assert.equal(ctx.sources.at(-1).buffer, recordedEffect(ctx, 'impact').buffer);
assert.equal(fetches, 2);
const second = context(); await recordedEffect(second, 'squeal').ready;
assert.equal(second.decodes, 1, 'another context decodes separately');
a.stop(); b.stop();
assert(ctx.sources.every(s => s.stopped && s.disconnected), 'recorded and fallback sources disposed');

for (const failure of ['http', 'decode']) {
  const c = context(), v = new EffectsAudio(c, new Node());
  globalThis.fetch = async () => { fetches++; return { ok: failure !== 'http', status: 404, arrayBuffer: async () => new ArrayBuffer(4) }; };
  if (failure === 'decode') c.decodeAudioData = async () => { throw new Error('bad WAV'); };
  v.update(car, .016); const entry = recordedEffect(c, 'squeal'); await entry.ready;
  assert.equal(entry.buffer, null); assert.equal(v.channels.squeal.fallback.gain.value, 1);
  const count = fetches; for (let i = 0; i < 60; i++) v.update(car, .016);
  assert.equal(fetches, count, 'failed download is not retried every frame');
  v.shot('impact', .7); await recordedEffect(c, 'impact').ready; v.shot('impact', .7);
  assert.equal(c.sources.at(-1).buffer.duration, .45, 'impact failure retains synthesis');
  v.stop();
}
const late = context(); let finish;
globalThis.fetch = () => new Promise(resolve => { finish = resolve; });
const v = new EffectsAudio(late, new Node()); v.update(car, .016); v.stop();
const count = late.sources.length;
finish({ ok: true, arrayBuffer: async () => new ArrayBuffer(44) });
await recordedEffect(late, 'squeal').ready;
assert.equal(late.sources.length, count, 'late download cannot resurrect stopped voice');
assert(effectSoundLog.some(l => l.fallback === 'procedural'));

for (const [name, file] of Object.entries(EFFECT_RECORDINGS)) {
  const wav = fs.readFileSync(new URL(`../game/assets/audio/${file}`, import.meta.url));
  assert(wav.length <= 150000); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt32LE(24), 44100); assert.equal(wav.readUInt16LE(34), 16);
  const samples = Array.from({ length: (wav.length - 44) / 2 }, (_, i) => wav.readInt16LE(44 + i * 2));
  assert(samples.every(x => Math.abs(x) < 32700), 'no clipped samples');
  if (name === 'squeal') {
    const steps = samples.slice(1).map((x, i) => Math.abs(x - samples[i])).sort((a, b) => a - b);
    assert(Math.abs(samples[0] - samples.at(-1)) <= steps[Math.floor(steps.length * .99)], 'wrap discontinuity below normal 99th percentile sample step');
  }
}
console.log('PASS: recording format/size/clipping/seam, lazy sharing, HTTP/decode fallback, immediate impact, late-load and source disposal');
