// Recorded tyre squeal/impact/rain with procedural fallback. Other effects remain
// procedural; all buffers are shared by voices on the same AudioContext.
import { recordedEffect } from './recordings.js';
const clamp = (v, max = 1) => Math.min(max, Math.max(0, Number.isFinite(v) ? v : 0));
const caches = new WeakMap();
const DRY = Object.freeze({});
export function effectBuffer(ctx, name) {
  let cache = caches.get(ctx);
  if (!cache) caches.set(ctx, cache = new Map());
  if (cache.has(name)) return cache.get(name);
  const seconds = name === 'shift' ? .12 : name === 'noise' || name === 'pebbles' || name === 'drops' ? 1 : .45;
  const buffer = ctx.createBuffer(1, Math.round(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let seed = 17, low = 0;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let i = 0; i < data.length; i++) {
    const t = i / ctx.sampleRate, n = random(); low += .08 * (n - low);
    const edge = Math.min(1, i / 100, (data.length - 1 - i) / 100);
    if (name === 'noise') data[i] = n * edge;
    else if (name === 'pebbles' || name === 'drops') {
      const period = name === 'pebbles' ? .071 : .113;
      const phase = t % period;
      data[i] = (n * .6 + Math.sin(t * 2 * Math.PI * (name === 'drops' ? 1700 : 2900)) * .4) * Math.exp(-phase * 650) * edge;
    } else if (name === 'splash') data[i] = (n * .5 + low * 2) * Math.exp(-t * 10) * edge;
    else if (name === 'metal') data[i] = (n * .4 + Math.sin(t * 2400) * .25 + Math.sin(t * 3871) * .2) * Math.exp(-t * 15) * edge;
    else data[i] = (low * 2 + Math.sin(2 * Math.PI * (name === 'landing' ? 65 : name === 'shift' ? 140 : 90) * t) * .6) * Math.exp(-t * (name === 'shift' ? 60 : 18)) * edge;
  }
  cache.set(name, buffer); return buffer;
}

// Slip is an angle in radians. Reuse `out` in the audio voice to avoid per-frame garbage.
export function effectLevels(v, weather = DRY, out = {}) {
  const speed = clamp(v.vel?.length?.() ?? Math.hypot(v.vel?.x || 0, v.vel?.y || 0, v.vel?.z || 0), 1000);
  const moving = clamp(speed / 18), wet = !!v.onWater || v.waterDepth > .03;
  const ground = v.grounded && !v.glide?.active && !wet && v.mode !== 'crashed';
  const hard = (v.surface === 3 || v.surface === 6 || v.surface === 7), loose = (v.surface === 1 || v.surface === 2 || v.surface === 4);
  const slide = ground ? clamp((Math.abs(v.slip || 0) - .04) / .5) * moving : 0;
  out.squeal = hard ? slide * .25 : loose ? slide * .055 : 0;
  out.pitch = (hard ? 1150 : 650) + slide * (hard ? 1600 : 550);
  out.crunch = ground && loose ? moving * (.10 + slide * .15) : 0;
  out.pebbles = out.crunch * (v.surface === 4 ? 1 : .55);
  out.grass = ground && v.surface === 0 ? moving * .08 : 0;
  const open = v.glide?.active || (v.kind === 'jet' && v.mode === 'air');
  out.wind = clamp((speed / (open ? 100 : 150)) ** 2, open ? .42 : .20);
  // Use the current shower/wetness, never the road moisture that remains during drying.
  // atmosphere.rain is the cycle scheduler; fixed presets instead set look.wetness.
  const rain = clamp(weather.wetness ?? weather.rain);
  out.rain = rain * .085; out.drops = rain * (v.kind === 'car' ? .10 : .035);
  out.spray = wet ? clamp(speed / 18) * .22 : 0;
  out.speed = speed; out.wet = wet;
  return out;
}

export class EffectsAudio {
  constructor(ctx, out, { remote = false, volume = 1 } = {}) {
    this.ctx = ctx; this.remote = remote; this.sources = []; this.nodes = []; this.shots = new Map(); this.levels = {};
    this.output = ctx.createGain(); this.output.gain.value = clamp(volume); this.output.connect(out);
    this.channels = {};
    // Prepare transients at voice startup, so the first crash/landing never synthesizes samples in update().
    for (const name of ['impact', 'metal', 'landing', 'splash', 'shift']) effectBuffer(ctx, name);
    for (const [name, type, frequency, q, buffer] of [
      ['squeal', 'bandpass', 1500, 7], ['crunch', 'lowpass', 550, .7], ['grass', 'bandpass', 2600, .6],
      ['wind', 'lowpass', 750, .5], ['rain', 'highpass', 1100, .5], ['drops', 'bandpass', 1800, 1, 'drops'],
      ['spray', 'bandpass', 1000, .6], ['pebbles', 'highpass', 1600, .7, 'pebbles'],
    ]) {
      const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
      const fallback = name === 'squeal' || name === 'rain' ? ctx.createGain() : null;
      source.buffer = effectBuffer(ctx, buffer || 'noise'); source.loop = true;
      filter.type = type; filter.frequency.value = frequency; filter.Q.value = q; gain.gain.value = 0;
      if (fallback) { fallback.gain.value = 1; filter.connect(fallback).connect(gain); this.nodes.push(fallback); }
      else filter.connect(gain);
      source.connect(filter); gain.connect(this.output); source.start(0, Math.random() * source.buffer.duration);
      this.sources.push(source); this.nodes.push(source, filter, gain); this.channels[name] = { source, filter, fallback, gain };
    }
    this.reset();
  }
  reset() { this.vehicle = null; this.hit = this.landing = 0; this.wet = false; this.mode = null; this.lastImpact = -Infinity; }
  shift() { this.shot('shift', .13); }
  setVolume(volume) { this.output.gain.setTargetAtTime(clamp(volume), this.ctx.currentTime, .04); }
  loadLoop(name) {
    const channel = this.channels[name];
    if (channel.requested || this.stopped) return;
    channel.requested = true;
    recordedEffect(this.ctx, name).ready.then(buffer => {
      if (!buffer || this.stopped) return;
      const source = this.ctx.createBufferSource(), blend = this.ctx.createGain();
      source.buffer = buffer; source.loop = true; blend.gain.value = 0;
      // Recordings already contain the desired spectrum; bypass the synthetic
      // filters. Both branches still use the same effect bus.
      source.connect(blend).connect(channel.gain); source.start();
      blend.gain.setTargetAtTime(1, this.ctx.currentTime, .08);
      channel.fallback.gain.setTargetAtTime(0, this.ctx.currentTime, .08);
      this.sources.push(source); this.nodes.push(source, blend);
    });
  }
  shot(name, level) {
    if (this.stopped || level <= 0 || this.shots.size >= 6) return;
    const source = this.ctx.createBufferSource(), gain = this.ctx.createGain();
    // First event plays immediately using synthesis while loading. Never replay
    // an old impact when a download finishes; subsequent events use the sample.
    source.buffer = recordedEffect(this.ctx, name)?.buffer || effectBuffer(this.ctx, name); gain.gain.value = clamp(level);
    source.connect(gain).connect(this.output); this.shots.set(source, gain);
    source.onended = () => { source.disconnect(); gain.disconnect(); this.shots.delete(source); };
    source.start();
  }
  update(v, dt, weather = DRY) {
    if (this.stopped) return;
    const t = this.ctx.currentTime, levels = effectLevels(v, this.remote ? DRY : weather, this.levels);
    if (levels.squeal > 0) this.loadLoop('squeal');
    if (levels.rain > 0) this.loadLoop('rain');
    if (this.vehicle !== v || this.type !== v.type) { this.reset(); this.vehicle = v; this.type = v.type; this.wet = levels.wet; this.mode = v.mode; }
    for (const name in this.channels) this.channels[name].gain.gain.setTargetAtTime(levels[name], t, name === 'wind' ? .15 : .05);
    this.channels.squeal.filter.frequency.setTargetAtTime(levels.pitch, t, .05);
    this.channels.pebbles.source.playbackRate.setTargetAtTime(.6 + clamp(levels.speed / 30, 2), t, .1);
    const hit = clamp(v.hit, 1000), landing = clamp(v.landing);
    const wreck = v.mode === 'crashed' && this.mode !== 'crashed';
    if ((hit > 3 && hit > this.hit + 1 || wreck) && t - this.lastImpact > .10) {
      const strength = wreck ? Math.max(.6, clamp(hit / 35)) : clamp(hit / 30);
      this.shot('impact', strength * .7); this.shot('metal', strength * (v.kind === 'jet' ? .65 : .35)); this.lastImpact = t;
    } else if (landing > .12 && landing > this.landing + .08 && t - this.lastImpact > .10) {
      this.shot('landing', landing * .65); this.lastImpact = t;
    }
    if (levels.wet && !this.wet) this.shot('splash', .15 + clamp(levels.speed / 35) * .65);
    this.hit = hit; this.landing = landing; this.wet = levels.wet; this.mode = v.mode;
  }
  stop() {
    this.stopped = true;
    for (const source of [...this.sources, ...this.shots.keys()]) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    for (const gain of this.shots.values()) gain.disconnect();
    for (const node of this.nodes) node.disconnect();
    // Disconnect short-lived gains even when stopped before their ended callback.
    this.output.disconnect(); this.sources = []; this.nodes = []; this.shots.clear();
  }
}
