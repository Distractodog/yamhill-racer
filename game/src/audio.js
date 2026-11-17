// Vehicle sounds. Engines: audio/engines.js (a voice per vehicle type: loops pitch-shifted by rpm through each type's
// gears, jet turbines, propellers, the helicopter's rotor), through the Engines volume. Tyre squeal, gravel crunch,
// wind and impacts here are synthesised from noise, through the Effects volume. Volumes: audio/mixer.js (Settings → Sound).
import { EngineVoice, engineKey } from './audio/engines.js';
import { mixerFor, loadSound, saveSound, sanitizeSound } from './audio/mixer.js';

const GLIDING = { throttle: 0, brake: 0 };
// wind on aircraft: [km/h scale, level at that speed, floor in the air, cap]
const AIR_WIND = { prop: [450, 0.3, 0.03, 0.3], stunt: [450, 0.3, 0.03, 0.3], heli: [300, 0.25, 0.03, 0.3] }, JET_WIND = [1200, 0.35, 0.04, 0.35];

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
    // noise source shared by tyres / gravel / wind
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); this.sources.push(s); return s; };
    const band = (type, f, q, out) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; noise().connect(b).connect(g).connect(out); return g; };
    this.squeal = band('bandpass', 1500, 6, master);
    this.crunch = band('lowpass', 420, 1, master);
    this.wind = band('lowpass', 700, 0.5, master);
    this.thud = band('lowpass', 160, 1, master);
  }

  // silence for good (another player's engine that is no longer needed); start() builds it again
  stop() {
    if (!this.ctx) return;
    for (const s of this.sources) try { s.stop(); } catch {}
    this.engine?.stop(); this.engine = null;
    this.master.disconnect(); this.engineOut.disconnect(); this.sources = []; this.ctx = null;
  }

  update(car, input, dt) {
    if (!this.ctx) return;
    if (car.glide?.active) input = GLIDING;            // flying: W/S pitch the wing, the engine just idles
    const t = this.ctx.currentTime, kmh = car.vel.length() * 3.6;
    this.engine.update(car, input, dt, kmh);
    if (car.kind === 'jet') { this.updateAir(car, t, kmh); return; }
    const onTarmac = car.surface === 3 || car.surface === 6 || car.surface === 7;
    const slide = car.grounded ? Math.min(1, Math.max(0, car.slip - 0.08) * 3) * Math.min(1, kmh / 30) : 0;
    this.squeal.gain.setTargetAtTime(onTarmac ? slide * 0.22 : 0, t, 0.05);
    const loose = car.grounded && !onTarmac ? Math.min(1, kmh / 90) * (0.12 + slide * 0.25) : 0;
    this.crunch.gain.setTargetAtTime(loose, t, 0.06);
    const wind = Math.min(0.25, (kmh / 260) ** 2 * 0.25);
    // under the wing: a steady rush of air that grows with airspeed
    this.wind.gain.setTargetAtTime(car.glide?.active ? Math.min(0.4, 0.07 + (kmh / 200) ** 2 * 0.3) : wind, t, 0.15);
    if (car.hit > 3 || car.landing > 0.3) {
      const v = Math.min(0.9, Math.max(car.hit / 25, car.landing));
      this.thud.gain.cancelScheduledValues(t); this.thud.gain.setValueAtTime(v, t); this.thud.gain.setTargetAtTime(0, t, 0.12);
    }
  }

  // aircraft (jets, prop planes, the helicopter): no tyre sounds; wind with airspeed; landing / crash thuds
  updateAir(plane, t, kmh) {
    this.squeal.gain.setTargetAtTime(0, t, 0.05); this.crunch.gain.setTargetAtTime(0, t, 0.05);
    const [k, level, floor, cap] = AIR_WIND[engineKey(plane)] || JET_WIND;
    this.wind.gain.setTargetAtTime(plane.mode === 'air' ? Math.min(cap, (kmh / k) ** 2 * level + floor) : 0, t, 0.2);
    if (plane.hit > 3 || plane.landing > 0.3) {
      const v = Math.min(0.9, Math.max(plane.hit / 25, plane.landing));
      this.thud.gain.cancelScheduledValues(t); this.thud.gain.setValueAtTime(v, t); this.thud.gain.setTargetAtTime(0, t, 0.2);
    }
  }
}
