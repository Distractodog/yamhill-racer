import assert from 'node:assert/strict';
import { effectLevels, effectBuffer, EffectsAudio } from '../game/src/audio/effects.js';
class Param {
  value = 0;
  setTargetAtTime(value) { assert(Number.isFinite(value)); this.value = value; }
}
class Node {
  gain = new Param(); frequency = new Param(); Q = new Param(); playbackRate = new Param();
  connect(out) { return out; }
  disconnect() { this.disconnected = true; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class Context {
  currentTime = 0; sampleRate = 44100; buffers = 0; sources = [];
  createBuffer(ch, length, rate) { this.buffers++; const samples = new Float32Array(length); return { duration: length / rate, getChannelData: () => samples }; }
  createGain() { return new Node(); }
  createBiquadFilter() { return new Node(); }
  createBufferSource() { const node = new Node(); this.sources.push(node); return node; }
}
const vehicle = (values = {}) => ({ kind: 'car', type: 'race', vel: { length: () => 30 }, grounded: true, surface: 3, slip: .2, hit: 0, landing: 0, ...values });
const car = vehicle(), slide = effectLevels(car), bigger = effectLevels(vehicle({ slip: .5 }));
assert(bigger.squeal > slide.squeal && bigger.pitch > slide.pitch);
const gravel = effectLevels(vehicle({ surface: 4 })), dirt = effectLevels(vehicle({ surface: 2 }));
assert(gravel.crunch > 0 && gravel.pebbles > dirt.pebbles && gravel.squeal < slide.squeal);
assert(effectLevels(vehicle({ surface: 0 })).grass > 0);
assert.equal(effectLevels(vehicle({ surface: 0 })).crunch, 0);
assert.equal(effectLevels(vehicle({ grounded: false })).squeal, 0);
assert.equal(effectLevels(vehicle({ onWater: true })).squeal, 0);
assert(effectLevels(vehicle({ onWater: true })).spray > 0);
assert(effectLevels(car, { rain: 1 }).rain > effectLevels(car, { rain: .5 }).rain);
assert(effectLevels(car, { rain: 0, wetness: .8 }).rain > 0, 'fixed rain preset uses current look wetness');
assert.equal(effectLevels(car, { rain: 1, wetness: 0, roadWetness: 1 }).rain, 0, 'clear look is silent even while roads dry');
assert(effectLevels(vehicle({ glide: { active: true } })).wind > slide.wind);
assert(effectLevels(vehicle({ vel: { length: () => 100 } })).wind > slide.wind);
const ctx = new Context(), local = new EffectsAudio(ctx, new Node()), remote = new EffectsAudio(ctx, new Node(), { remote: true });
assert.equal(ctx.buffers, 8, 'looping and transient buffers prepared once and shared by voices');
assert.equal(effectBuffer(ctx, 'impact'), effectBuffer(ctx, 'impact'));
assert.notEqual(effectBuffer(new Context(), 'impact'), effectBuffer(ctx, 'impact'));
local.update(car, 1 / 60, { rain: 1 }); remote.update(car, 1 / 60, { rain: 1 });
assert.equal(remote.channels.rain.gain.gain.value, 0);
assert(local.channels.rain.gain.gain.value > 0);
const events = []; local.shot = (name, level) => events.push([name, level]);
ctx.currentTime = 1; car.hit = 12; local.update(car, .016);
assert.deepEqual(events.map(e => e[0]), ['impact', 'metal']);
for (let i = 0; i < 30; i++) { ctx.currentTime += .016; local.update(car, .016); }
assert.equal(events.length, 2, 'held collision does not retrigger');
car.hit = 0; local.update(car, .016); ctx.currentTime += .2; car.hit = 24; local.update(car, .016);
assert(events[2][1] > events[0][1], 'harder impacts louder');
car.hit = 0; local.update(car, .016); ctx.currentTime += .2; car.landing = .8; local.update(car, .016);
assert.equal(events.at(-1)[0], 'landing');
car.onWater = true; local.update(car, .016); assert.equal(events.at(-1)[0], 'splash');
const count = events.length; local.update(car, .016); assert.equal(events.length, count);
ctx.currentTime += .2; car.kind = 'jet'; car.mode = 'crashed'; local.update(car, .016);
assert.equal(events.at(-1)[0], 'metal');
remote.shot('splash', .5); assert.equal(remote.shots.size, 1);
remote.shift(); assert.equal(remote.shots.size, 2);
assert.equal(ctx.buffers, 8, 'playing transients does not generate buffers during a frame');
remote.setVolume(0); assert.equal(remote.output.gain.value, 0);
const sources = [...ctx.sources]; local.stop(); remote.stop();
assert(sources.every(s => s.stopped && s.disconnected), 'all sources disposed');
assert.equal(remote.shots.size, 0);
console.log('PASS: surface/slip, weather, wind, water, impact onset/scaling, landing, wreck, buffer sharing, volume and disposal');

// Exercise the integration paths that return early for aircraft, using a real facade and fake audio graph.
const { CarAudio } = await import('../game/src/audio.js');
const integration = new Context(); integration.destination = new Node(); integration.resume = () => {};
integration.createOscillator = () => { const source = new Node(); integration.sources.push(source); return source; };
integration.createWaveShaper = () => new Node();
globalThis.fetch = async () => ({ arrayBuffer: async () => new ArrayBuffer(0) });
integration.decodeAudioData = async () => ({ duration: 1 });
const audio = new CarAudio({ ctx: integration, remote: true }); audio.start();
await new Promise(resolve => setTimeout(resolve, 0));
for (const state of [
  vehicle(), vehicle({ kind: 'bike' }), vehicle({ glide: { active: true } }),
  vehicle({ kind: 'jet', mode: 'air', throttle: .7 }),
  vehicle({ kind: 'jet', mode: 'air', throttle: .7, typePhysics: { prop: 1 } }),
  vehicle({ kind: 'jet', mode: 'air', throttle: .7, mesh: { userData: { mainRotor: {} } } }),
]) audio.update(state, { throttle: .6 }, .016, { rain: 1 });
audio.stop();
// (the engine's short one-shots — clunks, crackle — end by themselves; every loop and oscillator must be stopped)
assert(integration.sources.every(source => source.stopped || (source.buffer && !source.loop)), 'facade stops aircraft, engine and effect sources');
console.log('PASS: facade car/bike/glider/fighter/prop/helicopter paths and cleanup');
