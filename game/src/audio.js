import { WeaponAudio } from './audio/weapons.js';
// Vehicle sounds. Engines: audio/engines.js (a voice per vehicle type: loops pitch-shifted by rpm through each type's
// gears, jet turbines, propellers, the helicopter's rotor), through the Engines volume. Tyre squeal, gravel, grass, rain,
// splash, wind and impacts: audio/effects.js, through the Effects volume. Volumes: audio/mixer.js (Settings → Sound).
import { EngineVoice } from './audio/engines.js';
import { EffectsAudio } from './audio/effects.js';
import { mixerFor, loadSound, saveSound, sanitizeSound } from './audio/mixer.js';

const GLIDING = { throttle: 0, brake: 0 };

export class CarAudio {
  // opts (another player's engine, mp/remotes.js): ctx = an existing AudioContext, out = node to play into, volume
  constructor(opts = {}) {
    this.ctx = null; this.opts = opts; this.sources = []; this.engine = null;
    this.volumes = opts.ctx ? null : loadSound();       // yours: the saved Settings → Sound levels
  }

  // current gear (1 = first), for the HUD / other players' voices (set 1 when a voice is handed to someone new)
  get gear() { return (this.engine?.st.gear ?? 0) + 1; }
  set gear(g) { if (this.engine) this.engine.st.gear = Math.max(0, g - 1); }

  // the bus other players' engine voices play into (Engines volume) — null before the first input
  get engineBus() { return this.mixer?.engines || null; }

  setVolumes(v) {
    this.volumes = sanitizeSound({ ...this.volumes, ...v }); saveSound(this.volumes);
    this.mixer?.set(this.volumes);
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    let ctx;
    try { ctx = this.opts.ctx || new AudioContext(); } catch { return; }
    this.ctx = ctx;
    let engOut = this.opts.out, fxOut = this.opts.out;
    if (!engOut) { this.mixer = mixerFor(ctx); this.mixer.set(this.volumes); engOut = this.mixer.engines; fxOut = this.mixer.effects; }
    const level = this.opts.volume ?? 0.55;
    const master = ctx.createGain(); master.gain.value = level; master.connect(fxOut);
    this.master = master;
    this.engineOut = ctx.createGain(); this.engineOut.gain.value = level; this.engineOut.connect(engOut);
    this.engine = new EngineVoice(ctx, this.engineOut);
    this.effects = new EffectsAudio(ctx, master, { remote: this.opts.remote, volume: this.opts.effectsVolume ?? 1 });
  }

  weapon(kind, level) {
    if (!this.ctx) return;
    this.weapons ||= new WeaponAudio(this.ctx, this.master);
    this.weapons.shot(kind, level);
  }

  // silence for good (another player's engine that is no longer needed); start() builds it again
  stop() {
    if (!this.ctx) return;
    for (const s of this.sources) try { s.stop(); } catch {}
    this.weapons?.stop(); this.weapons = null;
    this.engine?.stop(); this.engine = null;
    this.effects?.stop(); this.effects = null;
    this.master.disconnect(); this.engineOut.disconnect(); this.sources = []; this.ctx = null;
  }

  update(car, input, dt, weather = {}) {
    if (!this.ctx) return;
    this.effects.update(car, dt, weather);
    if (car.glide?.active) input = GLIDING;            // flying: W/S pitch the wing, the engine just idles
    this.engine.update(car, input, dt, car.vel.length() * 3.6);
  }
}
