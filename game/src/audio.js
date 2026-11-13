// Car sounds. Engine: real recordings (BMW 120d from outside, CC0, see tools/make_engine_sound.py) at four steady rpms,
// all four looping at once, each pitch-shifted to the current rpm and crossfaded so the nearest recording dominates.
// Tyre squeal, gravel crunch, wind and impacts are still synthesised from noise.
const LAYERS = [['idle', 28], ['low', 49], ['med', 68], ['high', 85]];   // name, engine firing frequency (Hz) in the recording
const RPM_HZ = [[900, 28], [2600, 49], [4400, 68], [6000, 85]];          // game rpm -> firing frequency (above 6000: proportional)
const hzAt = rpm => {
  if (rpm <= RPM_HZ[0][0]) return RPM_HZ[0][1] * rpm / RPM_HZ[0][0];
  for (let i = 1; i < RPM_HZ.length; i++) if (rpm <= RPM_HZ[i][0]) {
    const [r0, h0] = RPM_HZ[i - 1], [r1, h1] = RPM_HZ[i];
    return h0 + (h1 - h0) * (rpm - r0) / (r1 - r0);
  }
  const [rl, hl] = RPM_HZ[RPM_HZ.length - 1]; return hl * rpm / rl;
};
const GLIDING = { throttle: 0, brake: 0 };
const GEARS = [0, 55, 100, 145, 190, 235, 300];   // km/h at the top of each gear

export class CarAudio {
  constructor() { this.ctx = null; this.gear = 1; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    let ctx;
    try { ctx = new AudioContext(); } catch { return; }
    this.ctx = ctx;
    const master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    // engine: recorded loops -> per-layer gain -> tone filter -> engine gain
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 2500; this.engFilter.Q.value = 0.7;
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 160; body.gain.value = 4; body.Q.value = 0.8;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilter.connect(body).connect(this.engGain).connect(master);
    this.layers = [];
    const base = new URL('../assets/audio/', import.meta.url);
    for (const [name, hz] of LAYERS) {
      const layer = { hz, src: null, gain: ctx.createGain() };
      layer.gain.gain.value = 0; layer.gain.connect(this.engFilter);
      this.layers.push(layer);
      fetch(new URL(`engine_${name}.wav`, base)).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).then(buf => {
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        src.connect(layer.gain); src.start(0, Math.random() * buf.duration); layer.src = src;
      }).catch(e => console.warn('engine sound', name, e));
    }
    // noise source shared by tyres / gravel / wind
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(); return s; };
    const band = (type, f, q, out) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; const g = ctx.createGain(); g.gain.value = 0; noise().connect(b).connect(g).connect(out); return g; };
    this.squeal = band('bandpass', 1500, 6, master);
    this.crunch = band('lowpass', 420, 1, master);
    this.wind = band('lowpass', 700, 0.5, master);
    this.thud = band('lowpass', 160, 1, master);
  }

  update(car, input, dt) {
    if (!this.ctx) return;
    if (car.glide?.active) input = GLIDING;            // flying: W/S pitch the wing, the engine just idles
    const t = this.ctx.currentTime, kmh = car.vel.length() * 3.6;
    while (this.gear < GEARS.length - 1 && kmh > GEARS[this.gear]) this.gear++;
    while (this.gear > 1 && kmh < GEARS[this.gear - 1] - 8) this.gear--;
    const lo = GEARS[this.gear - 1], hi = GEARS[this.gear];
    let frac = Math.min(1.05, Math.max(0, (kmh - lo) / (hi - lo)));
    if (!car.grounded || car.slip > 0.3) frac = Math.min(1.1, frac + 0.25 * input.throttle);
    if (kmh < 8 && car.grounded) frac = Math.max(frac, 0.55 * input.throttle);   // revving on the spot
    const rpm = 950 + frac * 6300 * (0.8 + 0.2 * input.throttle);
    const hz = hzAt(rpm);
    // crossfade between the two recordings either side of the current pitch (equal power), then pitch-shift each
    const L = this.layers;
    let i = 0; while (i < L.length - 2 && hz > L[i + 1].hz) i++;
    const k = Math.min(1, Math.max(0, (hz - L[i].hz) / (L[i + 1].hz - L[i].hz)));
    for (let j = 0; j < L.length; j++) {
      const w = j === i ? Math.cos(k * Math.PI / 2) : j === i + 1 ? Math.sin(k * Math.PI / 2) : 0;
      L[j].gain.gain.setTargetAtTime(w, t, 0.04);
      if (L[j].src) L[j].src.playbackRate.setTargetAtTime(hz / L[j].hz, t, 0.03);
    }
    // on throttle: louder and brighter; off throttle: muffled, quieter (engine braking)
    this.engFilter.frequency.setTargetAtTime(1400 + input.throttle * 4500 + frac * 1500, t, 0.06);
    this.engGain.gain.setTargetAtTime(0.55 + input.throttle * 0.6 + frac * 0.2, t, 0.06);
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
}
