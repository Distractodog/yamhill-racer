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
const BIKE_GEARS = [0, 35, 65, 95, 130, 170, 260];   // dirt bike: shorter gears, revs higher

// decoded recordings per audio context, so other players' engines (mp/remotes.js) share them with yours
const recordings = new WeakMap();
function recording(ctx, name) {
  let m = recordings.get(ctx); if (!m) recordings.set(ctx, m = new Map());
  if (!m.has(name)) m.set(name, fetch(new URL(`../assets/audio/engine_${name}.wav`, import.meta.url)).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)));
  return m.get(name);
}

export class CarAudio {
  // opts (another player's engine, mp/remotes.js): ctx = an existing AudioContext, out = node to play into, volume
  constructor(opts = {}) { this.ctx = null; this.gear = 1; this.opts = opts; this.sources = []; }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    let ctx;
    try { ctx = this.opts.ctx || new AudioContext(); } catch { return; }
    this.ctx = ctx;
    const master = ctx.createGain(); master.gain.value = this.opts.volume ?? 0.55; master.connect(this.opts.out || ctx.destination);
    this.master = master;
    // engine: recorded loops -> per-layer gain -> tone filter -> engine gain
    this.engFilter = ctx.createBiquadFilter(); this.engFilter.type = 'lowpass'; this.engFilter.frequency.value = 2500; this.engFilter.Q.value = 0.7;
    const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 160; body.gain.value = 4; body.Q.value = 0.8;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    this.engFilter.connect(body).connect(this.engGain).connect(master);
    this.layers = [];
    for (const [name, hz] of LAYERS) {
      const layer = { hz, src: null, gain: ctx.createGain() };
      layer.gain.gain.value = 0; layer.gain.connect(this.engFilter);
      this.layers.push(layer);
      recording(ctx, name).then(buf => {
        if (this.ctx !== ctx) return;                    // stopped meanwhile
        const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
        src.connect(layer.gain); src.start(0, Math.random() * buf.duration); layer.src = src; this.sources.push(src);
      }).catch(e => console.warn('engine sound', name, e));
    }
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
    // jet: low roar of the exhaust + a turbine whine that follows the throttle
    this.jetRoar = band('lowpass', 260, 0.7, master);
    this.jetHiss = band('bandpass', 2400, 1.2, master);
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 400;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 8; bp.frequency.value = 1200;
    this.whine = ctx.createGain(); this.whine.gain.value = 0; this.whineOsc = o; this.whineBand = bp;
    o.connect(bp).connect(this.whine).connect(master); o.start(); this.sources.push(o);
  }

  // silence for good (another player's engine that is no longer needed); start() builds it again
  stop() {
    if (!this.ctx) return;
    for (const s of this.sources) try { s.stop(); } catch {}
    this.master.disconnect(); this.sources = []; this.ctx = null; this.rotorGain = null;
  }

  // helicopter rotor: low noise and a low tone gated by a pulse at the blade-pass rate (the "chop"). Built the first time
  // a helicopter is heard, so the car's engine (and other players' engine voices) keep their source count.
  rotorSound() {
    if (this.rotorGain) return;
    const ctx = this.ctx, noise = ctx.createBufferSource(); noise.buffer = this.noiseBuf; noise.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 240; lp.Q.value = 0.9;
    const tone = ctx.createOscillator(); tone.type = 'triangle'; tone.frequency.value = 62;
    const chop = ctx.createGain(); chop.gain.value = 0;                 // opened by the pulse below
    this.rotorGain = ctx.createGain(); this.rotorGain.gain.value = 0;
    noise.connect(lp).connect(chop); tone.connect(chop); chop.connect(this.rotorGain).connect(this.master);
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 4;
    const pulse = ctx.createWaveShaper(), curve = new Float32Array(256);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.max(0, i / 127.5 - 1) ** 3;   // a short thump once per cycle
    pulse.curve = curve;
    lfo.connect(pulse).connect(chop.gain);
    for (const src of [noise, tone, lfo]) { src.start(); this.sources.push(src); }
    this.rotorLfo = lfo;
  }

  update(car, input, dt) {
    if (!this.ctx) return;
    if (car.glide?.active) input = GLIDING;            // flying: W/S pitch the wing, the engine just idles
    const t = this.ctx.currentTime, kmh = car.vel.length() * 3.6;
    if (car.kind === 'jet') { if (car.mesh?.userData?.mainRotor) this.updateRotor(car, t, kmh); else this.updateJet(car, t, kmh); return; }
    this.rotorGain?.gain.setTargetAtTime(0, t, 0.1);
    this.jetRoar.gain.setTargetAtTime(0, t, 0.1); this.jetHiss.gain.setTargetAtTime(0, t, 0.1); this.whine.gain.setTargetAtTime(0, t, 0.1);
    const bike = car.kind === 'bike', G = bike ? BIKE_GEARS : GEARS;
    while (this.gear < G.length - 1 && kmh > G[this.gear]) this.gear++;
    while (this.gear > 1 && kmh < G[this.gear - 1] - 8) this.gear--;
    const lo = G[this.gear - 1], hi = G[this.gear];
    let frac = Math.min(1.05, Math.max(0, (kmh - lo) / (hi - lo)));
    if (!car.grounded || car.slip > 0.3 || car.wheelie) frac = Math.min(1.1, frac + 0.25 * input.throttle);   // spinning up: revs
    if (kmh < 8 && car.grounded) frac = Math.max(frac, 0.55 * input.throttle);   // revving on the spot
    const rpm = 950 + frac * 6300 * (0.8 + 0.2 * input.throttle);
    const hz = hzAt(rpm) * (bike ? 1.75 : 1);           // the bike: a small single revving high
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
    this.engFilter.frequency.setTargetAtTime((1400 + input.throttle * 4500 + frac * 1500) * (bike ? 1.4 : 1), t, 0.06);
    this.engGain.gain.setTargetAtTime((0.55 + input.throttle * 0.6 + frac * 0.2) * (bike ? 0.8 : 1), t, 0.06);
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

  updateJet(jet, t, kmh) {
    this.rotorGain?.gain.setTargetAtTime(0, t, 0.1);
    if (jet.typePhysics?.prop) { this.updateProp(jet, t, kmh); return; }
    this.whineBand.frequency.setTargetAtTime(1200, t, 0.1); this.whineBand.Q.setTargetAtTime(8, t, 0.1);
    for (const L of this.layers) L.gain.gain.setTargetAtTime(0, t, 0.05);
    this.squeal.gain.setTargetAtTime(0, t, 0.05); this.crunch.gain.setTargetAtTime(0, t, 0.05);
    const on = jet.mode === 'crashed' ? 0 : 1, th = jet.throttle * on;
    this.jetRoar.gain.setTargetAtTime(on * (0.12 + th * 0.55), t, 0.15);
    this.jetHiss.gain.setTargetAtTime(on * (0.02 + th * 0.06), t, 0.15);
    this.whine.gain.setTargetAtTime(on * (0.012 + th * 0.02), t, 0.2);
    this.whineOsc.frequency.setTargetAtTime(380 + th * 900, t, 0.4);
    this.wind.gain.setTargetAtTime(jet.mode === 'air' ? Math.min(0.35, (kmh / 1200) ** 2 * 0.35 + 0.04) : 0, t, 0.2);
    if (jet.hit > 3 || jet.landing > 0.3) {
      const v = Math.min(0.9, Math.max(jet.hit / 25, jet.landing));
      this.thud.gain.cancelScheduledValues(t); this.thud.gain.setValueAtTime(v, t); this.thud.gain.setTargetAtTime(0, t, 0.2);
    }
  }

  // propeller aircraft (vehicletypes.js physics.prop = engine pitch): the piston engine recordings, slowed to an
  // aircraft engine's rpm, which follows the throttle (a little windmilling with speed), plus the blades' buzz
  updateProp(plane, t, kmh) {
    const on = plane.mode === 'crashed' ? 0 : 1, th = plane.throttle * on, air = plane.mode === 'air';
    const rpm = on * (750 + 1950 * th + Math.min(250, kmh) * 0.8 * (1 - th));
    const hz = Math.max(8, rpm / 30 * plane.typePhysics.prop), L = this.layers;
    let i = 0; while (i < L.length - 2 && hz > L[i + 1].hz) i++;
    const k = Math.min(1, Math.max(0, (hz - L[i].hz) / (L[i + 1].hz - L[i].hz)));
    for (let j = 0; j < L.length; j++) {
      const w = j === i ? Math.cos(k * Math.PI / 2) : j === i + 1 ? Math.sin(k * Math.PI / 2) : 0;
      L[j].gain.gain.setTargetAtTime(w * on, t, 0.05);
      if (L[j].src) L[j].src.playbackRate.setTargetAtTime(hz / L[j].hz, t, 0.05);
    }
    this.engFilter.frequency.setTargetAtTime(900 + th * 1800, t, 0.08);
    this.engGain.gain.setTargetAtTime(on * (0.5 + th * 0.55), t, 0.08);
    // blade buzz: blade-pass frequency, a throaty band a few harmonics up
    this.whineOsc.frequency.setTargetAtTime(Math.max(10, rpm / 30), t, 0.08);
    this.whineBand.frequency.setTargetAtTime(Math.max(60, rpm / 30) * 3, t, 0.08); this.whineBand.Q.setTargetAtTime(2, t, 0.1);
    this.whine.gain.setTargetAtTime(on * (0.02 + th * 0.05), t, 0.1);
    this.jetRoar.gain.setTargetAtTime(on * (0.03 + th * 0.08), t, 0.15);                 // prop wash
    this.jetHiss.gain.setTargetAtTime(0, t, 0.1);
    this.squeal.gain.setTargetAtTime(0, t, 0.05); this.crunch.gain.setTargetAtTime(0, t, 0.05);
    this.wind.gain.setTargetAtTime(air ? Math.min(0.3, (kmh / 450) ** 2 * 0.3 + 0.03) : 0, t, 0.2);
    if (plane.hit > 3 || plane.landing > 0.3) {
      const v = Math.min(0.9, Math.max(plane.hit / 25, plane.landing));
      this.thud.gain.cancelScheduledValues(t); this.thud.gain.setValueAtTime(v, t); this.thud.gain.setTargetAtTime(0, t, 0.2);
    }
  }

  // helicopter (heli.js; also other players' helicopters): the chop speeds up and gets louder with rotor power and winds
  // down with it after a crash; a quiet turbine whine on top; wind with speed
  updateRotor(h, t, kmh) {
    this.rotorSound();
    for (const L of this.layers) L.gain.gain.setTargetAtTime(0, t, 0.05);
    this.squeal.gain.setTargetAtTime(0, t, 0.05); this.crunch.gain.setTargetAtTime(0, t, 0.05); this.jetRoar.gain.setTargetAtTime(0, t, 0.1);
    const on = h.mode === 'crashed' ? 0 : 1, p = Math.max(0, Math.min(1, h.throttle || 0));
    this.rotorLfo.frequency.setTargetAtTime(3 + 11 * p * p, t, 0.3);           // blade passes per second
    this.rotorGain.gain.setTargetAtTime(0.08 * Math.min(1, p * 10) + 0.8 * p * p, t, 0.2);   // silent once stopped
    this.jetHiss.gain.setTargetAtTime(on * (0.01 + p * 0.03), t, 0.15);
    this.whine.gain.setTargetAtTime(on * (0.006 + p * 0.014), t, 0.2);
    this.whineOsc.frequency.setTargetAtTime(520 + p * 680, t, 0.4);
    this.whineBand.frequency.setTargetAtTime(1200, t, 0.1); this.whineBand.Q.setTargetAtTime(8, t, 0.1);   // (a prop plane retunes it)
    this.wind.gain.setTargetAtTime(h.mode === 'air' ? Math.min(0.3, (kmh / 300) ** 2 * 0.25 + 0.03) : 0, t, 0.2);
    if (h.hit > 3 || h.landing > 0.3) {
      const v = Math.min(0.9, Math.max(h.hit / 25, h.landing));
      this.thud.gain.cancelScheduledValues(t); this.thud.gain.setValueAtTime(v, t); this.thud.gain.setTargetAtTime(0, t, 0.2);
    }
  }
}
