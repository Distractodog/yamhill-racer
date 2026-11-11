// Synthesised car sounds (no audio files): engine with fake gears, tyre squeal, gravel crunch, wind, impacts.
const GEARS = [0, 55, 100, 145, 190, 235, 300];   // km/h at the top of each gear

export class CarAudio {
  constructor() { this.ctx = null; this.gear = 1; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    let ctx;
    try { ctx = new AudioContext(); } catch { return; }
    this.ctx = ctx;
    const master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    // engine: two detuned oscillators -> lowpass
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 900; this.engFilter.Q.value = 4;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator(); this.o2.type = 'square';
    const g2 = ctx.createGain(); g2.gain.value = 0.35;
    this.o1.connect(this.engFilter); this.o2.connect(g2).connect(this.engFilter);
    this.engFilter.connect(this.engGain).connect(master);
    this.o1.start(); this.o2.start();
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
    const t = this.ctx.currentTime, kmh = car.vel.length() * 3.6;
    while (this.gear < GEARS.length - 1 && kmh > GEARS[this.gear]) this.gear++;
    while (this.gear > 1 && kmh < GEARS[this.gear - 1] - 8) this.gear--;
    const lo = GEARS[this.gear - 1], hi = GEARS[this.gear];
    let frac = Math.min(1.05, Math.max(0, (kmh - lo) / (hi - lo)));
    if (!car.grounded || car.slip > 0.3) frac = Math.min(1.1, frac + 0.25 * input.throttle);
    const rpm = 1800 + frac * 6200 * (0.7 + 0.3 * input.throttle);
    const f = rpm / 60 * 1.5;
    this.o1.frequency.setTargetAtTime(f, t, 0.03); this.o2.frequency.setTargetAtTime(f * 0.501, t, 0.03);
    this.engFilter.frequency.setTargetAtTime(500 + input.throttle * 1500 + frac * 600, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.09 + input.throttle * 0.11, t, 0.05);
    const onTarmac = car.surface === 3 || car.surface === 6 || car.surface === 7;
    const slide = car.grounded ? Math.min(1, Math.max(0, car.slip - 0.08) * 3) * Math.min(1, kmh / 30) : 0;
    this.squeal.gain.setTargetAtTime(onTarmac ? slide * 0.22 : 0, t, 0.05);
    const loose = car.grounded && !onTarmac ? Math.min(1, kmh / 90) * (0.12 + slide * 0.25) : 0;
    this.crunch.gain.setTargetAtTime(loose, t, 0.06);
    this.wind.gain.setTargetAtTime(Math.min(0.25, (kmh / 260) ** 2 * 0.25), t, 0.1);
    if (car.hit > 3 || car.landing > 0.3) {
      const v = Math.min(0.9, Math.max(car.hit / 25, car.landing));
      this.thud.gain.cancelScheduledValues(t); this.thud.gain.setValueAtTime(v, t); this.thud.gain.setTargetAtTime(0, t, 0.12);
    }
  }
}
