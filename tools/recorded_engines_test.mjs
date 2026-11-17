import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadLoops, EngineVoice, soundLog, soundRpm, ENGINES } from '../game/src/audio/engines.js';
import { ENGINE_LOOPS } from '../game/src/audio/engineloops.js';
import { RECORDED_ENGINES } from '../game/src/audio/recordedengines.js';

const context = () => {
  const param = () => ({ value: 0, setTargetAtTime(v) { this.value = v; }, setValueAtTime(v) { this.value = v; }, cancelScheduledValues() {} });
  const node = () => ({ gain: param(), frequency: param(), Q: param(), playbackRate: param(),
    connect(n) { return n; }, disconnect() { this.disconnected = true; }, start() { this.started = true; }, stop() { this.stopped = true; } });
  return { currentTime: 0, sampleRate: 8000, decodes: 0, sources: [],
    createGain: node, createBiquadFilter: node, createWaveShaper: node,
    createBufferSource() { const n = node(); this.sources.push(n); return n; },
    createOscillator() { return this.createBufferSource(); },
    createBuffer(c, n, rate) { const data = new Float32Array(n); return { duration: n / rate, getChannelData: () => data }; },
    async decodeAudioData(bytes) { this.decodes++; return { duration: 1, sampleRate: 44100, file: bytes.file }; },
  };
  };
let requests = [], failFile = null;
const response = file => ({ ok: file !== failFile, status: 404, arrayBuffer: async () => ({ file }) });
const fetchFile = async url => { const file = String(url).split('/assets/audio/')[1]; requests.push(file); return response(file); };
globalThis.fetch = fetchFile;

const ctx = context();
assert.equal(requests.length, 0);
const first = loadLoops(ctx, 'race'); assert.equal(first, loadLoops(ctx, 'race'));
const race = await first;
assert.deepEqual(race.map(l => l.buf.file), RECORDED_ENGINES.race.map(l => l.file));
assert.equal(ctx.decodes, 3); assert.equal(requests.length, 3);
assert.equal(await loadLoops(ctx, 'race'), race);
await loadLoops(context(), 'race'); assert.equal(requests.length, 6, 'contexts have independent decodes');

// Reject one layer: all layers fall back together, rather than mixing timbres.
failFile = RECORDED_ENGINES.race[1].file;
const fallbackContext = context(), fallback = await loadLoops(fallbackContext, 'race');
assert.deepEqual(fallback.map(l => l.buf.file), ENGINE_LOOPS.race.map(l => l.file));
assert(soundLog.some(l => l.file === failFile && l.fallback === 'original audio'));
const count = requests.length; await loadLoops(fallbackContext, 'race');
assert.equal(requests.length, count, 'failed recording is not repeatedly fetched');

failFile = null;
const badDecode = context(); badDecode.decodeAudioData = async bytes => {
  if (bytes.file === RECORDED_ENGINES.hatch[0].file) throw new Error('corrupt WAV');
  return { duration: 1, sampleRate: 44100, file: bytes.file };
};
assert.deepEqual((await loadLoops(badDecode, 'hatch')).map(l => l.buf.file), ENGINE_LOOPS.hatch.map(l => l.file));
assert.deepEqual((await loadLoops(context(), 'sports')).map(l => l.buf.file), ENGINE_LOOPS.sports.map(l => l.file), 'rejected LFA keeps synthesis');

const hctx = context(), heli = new EngineVoice(hctx, hctx.createGain());
heli.setEngine('heli'); await loadLoops(hctx, 'heli');
assert(heli.part.recordedRotor.source.started);
assert.equal(heli.part.rotorFallback.gain.value, 0);
heli.updateRotor({ throttle: 1, mode: 'air' }, heli.part, 0);
assert(heli.part.recordedRotor.gain.gain.value > 0);
heli.updateRotor({ throttle: 1, mode: 'crashed' }, heli.part, 1);
assert.equal(heli.part.recordedRotor.gain.gain.value, 0, 'crashed rotor recording silenced');
heli.stop(); assert(hctx.sources.every(s => s.stopped));

failFile = RECORDED_ENGINES.heli[0].file;
const hc = context(), failedHeli = new EngineVoice(hc, hc.createGain());
failedHeli.setEngine('heli'); await loadLoops(hc, 'heli');
assert.equal(failedHeli.part.recordedRotor, undefined);
assert.equal(failedHeli.part.rotorFallback.gain.value, 1, 'failed rotor recording retains synthesis');
failedHeli.stop(); failFile = null;

// Delayed loads must not create sources in a stopped/switched engine voice.
for (const type of ['race', 'heli']) {
  const pending = [];
  globalThis.fetch = url => new Promise(resolve => pending.push(() => resolve(response(String(url).split('/assets/audio/')[1]))));
  const c = context(), voice = new EngineVoice(c, c.createGain()); voice.setEngine(type);
  const loading = loadLoops(c, type); voice.stop(); const n = c.sources.length;
  pending.forEach(resolve => resolve()); await loading;
  assert.equal(c.sources.length, n, `${type}: late load did not resurrect voice`);
}
globalThis.fetch = fetchFile;

for (const [type, layers] of Object.entries(RECORDED_ENGINES)) {
  if (type !== 'heli') {
    assert.deepEqual(layers.map(l => l.rpm), ENGINE_LOOPS[type].map(l => l.rpm), `${type}: unchanged audio rpm anchors`);
    assert(soundRpm(ENGINES[type], ENGINES[type].idle) > 0);
  }
  for (const l of layers) {
    const bytes = fs.readFileSync(new URL(`../game/assets/audio/${l.file}`, import.meta.url));
    assert.equal(bytes.length, l.bytes); assert(bytes.length <= 150000);
    const samples = Array.from({ length: (bytes.length - 44) / 2 }, (_, i) => bytes.readInt16LE(44 + i * 2));
    assert(samples.every(x => Math.abs(x) <= 26215), `${l.file}: peak headroom`);
    const steps = samples.slice(1).map((x, i) => Math.abs(x - samples[i])).sort((a, b) => a - b);
    assert(Math.abs(samples[0] - samples.at(-1)) <= steps[Math.floor(steps.length * .99)], `${l.file}: wrap below normal 99th percentile sample step`);
  }
}
console.log('PASS: recorded engine selection/sharing, unchanged rpm anchors, whole-set HTTP/decode fallback, rotor power/fallback, late-load disposal, asset headroom and seams');
