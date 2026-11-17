// Engine sounds per vehicle type (audio.js plays one EngineVoice for your vehicle and one per nearby other player).
// Cars and bikes: each type's loops (engineloops.js: synthesised by tools/make_engine_sounds.py, the hatchback's are
// the recorded BMW set), loaded the first time that type is heard, decoded once per audio context and shared by every
// voice; the two loops either side of the rpm play pitch-shifted and crossfaded. The rpm comes from the speed through
// each type's gearbox (stepEngine), with shifts you hear (a short dip and a clunk), lift-off crackle (sports car,
// race car, sport bike) and a turbo whistle (truck). Aircraft: jets are a synthesised turbine (whine + roar, afterburner
// rumble and a boom when it lights); prop and stunt planes the piston loops with the propeller's beat at the
// blade-pass rate; the helicopter a rotor chop and blade slap over a turbine whine.
import { ENGINE_LOOPS } from './engineloops.js';

// idle / redline rpm; gears: count, spread (top gear's speed / first gear's at the same rpm), gearTop (km/h at redline
// in top gear, or the vehicle's top speed if lower); shift: seconds the drive is cut; dip: engine level during it;
// clunk: shift clunk level; crackle: lift-off pops; turbo: whistle level; gain / bright: level and tone
export const ENGINES = {
  race: { loops: 'race', idle: 4000, redline: 12500, gears: 8, spread: 2.9, gearTop: 400, shift: 0.05, dip: 0.55, clunk: 0.25, crackle: 0.45, gain: 1, bright: 1.7 },
  sports: { loops: 'sports', idle: 1000, redline: 8500, gears: 7, spread: 3.4, gearTop: 360, shift: 0.09, dip: 0.45, clunk: 0.3, crackle: 1, gain: 1, bright: 1.25 },
  // pitch: the recordings span only 840–2550 rpm, so game rpm -> recording rpm as the car engine always sounded
  hatch: { loops: 'hatch', idle: 900, redline: 6500, gears: 5, spread: 4, gearTop: 210, shift: 0.22, dip: 0.35, clunk: 0.45, gain: 0.9, bright: 1,
    pitch: [[900, 840], [2600, 1470], [4400, 2040], [6000, 2550]] },
  suv: { loops: 'suv', idle: 750, redline: 6200, gears: 6, spread: 4, gearTop: 230, shift: 0.18, dip: 0.55, clunk: 0.25, gain: 0.95, bright: 0.75 },
  truck: { loops: 'truck', idle: 650, redline: 3800, gears: 6, spread: 4.5, gearTop: 170, shift: 0.3, dip: 0.4, clunk: 0.6, turbo: 1, gain: 1.15, bright: 0.6 },
  dirt: { loops: 'dirt', idle: 1600, redline: 11000, gears: 5, spread: 3.3, gearTop: 160, shift: 0.07, dip: 0.4, clunk: 0.3, crackle: 0.15, gain: 0.85, bright: 1.4 },
  sport: { loops: 'sport', idle: 1300, redline: 14000, gears: 6, spread: 2.6, gearTop: 300, shift: 0.06, dip: 0.45, clunk: 0.25, crackle: 0.4, gain: 0.9, bright: 1.6 },
  fighter: { turbine: 1, whine: 1 },
  stealth: { turbine: 2, whine: 1.15 },                 // twin engines: two whines a little apart (a slow beat)
  prop: { loops: 'prop', idle: 800, redline: 2450, blades: 2, piston: true, gain: 1, bright: 1 },
  stunt: { loops: 'stunt', idle: 850, redline: 2700, blades: 3, piston: true, gain: 1.1, bright: 1.3 },
  heli: { rotor: true },
};
const BY_KIND = { car: ['race', 'sports', 'hatch', 'suv', 'truck'], bike: ['dirt', 'sport'], jet: ['fighter', 'stealth', 'prop', 'stunt', 'heli'] };

// which engine a vehicle (yours, or another player's puppet) has
export function engineKey(v) {
  const list = BY_KIND[v.kind] || BY_KIND.car;
  if (v.kind === 'jet') {
    if (v.type === 'heli' || v.mesh?.userData?.mainRotor) return 'heli';
    if (list.includes(v.type)) return v.type;
    return v.typePhysics?.prop ? (v.typePhysics.prop > 1.2 ? 'stunt' : 'prop') : 'fighter';
  }
  return list.includes(v.type) ? v.type : list[0];
}

// km/h at redline in each gear: geometric steps from first to top gear
export function gearTops(p, topKmh) {
  const top = Math.min(p.gearTop, topKmh > 0 ? topKmh : p.gearTop), n = p.gears;
  return Array.from({ length: n }, (_, i) => top / p.spread ** ((n - 1 - i) / (n - 1)));
}

export const newEngineState = () => ({ gear: 0, rpm: 0, shiftT: 0, since: 9, crackle: 0, boost: 0, spool: 0, ab: 0, lastThrottle: 0 });

// One step of a car / bike engine. s: { kmh, throttle, grounded, slip (0..1 wheelspin), topKmh }.
// Changes st.gear / st.rpm; returns 'up' / 'down' on a gear change, else null.
export function stepEngine(st, p, s, dt) {
  const tops = gearTops(p, s.topKmh), n = tops.length, red = p.redline, th = Math.max(0, Math.min(1, s.throttle));
  const wheel = g => red * s.kmh / tops[g];
  st.since += dt;
  let ev = null;
  if (s.grounded && st.since > 0.35) {
    // flat out: shift near the redline; cruising: early. Down when the revs sag (sooner under throttle), but only if
    // the lower gear stays well below the up-shift point (no hunting)
    const up = red * (0.62 + 0.35 * th), down = red * (0.3 + 0.28 * th);
    if (st.gear < n - 1 && wheel(st.gear) > up) { st.gear++; ev = 'up'; }
    else if (st.gear > 0 && wheel(st.gear) < down && wheel(st.gear - 1) < up * 0.92) { st.gear--; ev = 'down'; }
    if (ev) { st.since = 0; st.shiftT = p.shift; }
  }
  st.gear = Math.min(st.gear, n - 1);
  const top = tops[n - 1], vmax = s.topKmh > top ? s.topKmh : top * 1.15;
  let target = Math.min(wheel(st.gear), red * 1.02);
  // past the top gear's redline (the arcade top speeds): keep climbing a little, a scream rather than a limiter
  if (st.gear === n - 1 && s.kmh > top) target = red * (1 + 0.1 * Math.min(1, (s.kmh - top) / Math.max(1, vmax - top)));
  const rev = p.idle + th * (red - p.idle);             // what the engine revs to unloaded
  if (!s.grounded) target = rev;                         // in the air: free revs (gliding: idle)
  else if (s.slip > 0.3) target = Math.max(target, target + (rev - target) * Math.min(1, (s.slip - 0.3) * 2));
  if (st.gear === 0 && s.grounded) target = Math.max(target, p.idle + th * (0.5 * red - p.idle));   // clutch: launch revs
  target = Math.max(p.idle, target);
  const tau = st.shiftT > 0 ? 0.035 : target > st.rpm ? 0.07 : 0.14;
  st.rpm += (target - st.rpm) * Math.min(1, dt / tau);
  st.shiftT = Math.max(0, st.shiftT - dt);
  return ev;
}

// the rpm the loops are played at: the engine's own, or through the profile's pitch table (straight lines between its
// points, proportional below the first and above the last)
export function soundRpm(p, rpm) {
  const P = p.pitch; if (!P) return rpm;
  if (rpm <= P[0][0]) return P[0][1] * rpm / P[0][0];
  for (let i = 1; i < P.length; i++) if (rpm <= P[i][0]) {
    const [r0, s0] = P[i - 1], [r1, s1] = P[i];
    return s0 + (s1 - s0) * (rpm - r0) / (r1 - r0);
  }
  const [rl, sl] = P[P.length - 1]; return sl * rpm / rl;
}

// equal-power crossfade between the two loops either side of rpm: [[index, weight, playbackRate], ...]
export function loopMix(loops, rpm) {
  if (!loops.length) return [];
  if (loops.length === 1) return [[0, 1, rpm / loops[0].rpm]];
  let i = 0; while (i < loops.length - 2 && rpm > loops[i + 1].rpm) i++;
  const k = Math.min(1, Math.max(0, (rpm - loops[i].rpm) / (loops[i + 1].rpm - loops[i].rpm)));
  return [[i, Math.cos(k * Math.PI / 2), rpm / loops[i].rpm], [i + 1, Math.sin(k * Math.PI / 2), rpm / loops[i + 1].rpm]];
}

// ---------------------------------------------------------------- shared buffers (per audio context)
export const soundLog = [];                              // every loop fetched: { type, file, bytes, seconds, rate, ms } or error
const decoded = new WeakMap();                           // ctx -> Map(type -> Promise<[{ buf, rpm }]>)
export function loadLoops(ctx, type) {
  let m = decoded.get(ctx); if (!m) decoded.set(ctx, m = new Map());
  if (!m.has(type)) m.set(type, Promise.all((ENGINE_LOOPS[type] || []).map(async l => {
    const t0 = performance.now();
    try {
      const r = await fetch(new URL(`../../assets/audio/${l.file}`, import.meta.url));
      if (r.ok === false) throw new Error(`HTTP ${r.status}`);
      const bytes = await r.arrayBuffer(), buf = await ctx.decodeAudioData(bytes);
      soundLog.push({ type, file: l.file, bytes: bytes.byteLength, seconds: buf.duration, rate: buf.sampleRate, ms: Math.round(performance.now() - t0) });
      return { buf, rpm: l.rpm };
    } catch (e) {
      soundLog.push({ type, file: l.file, error: String(e?.message || e) }); throw e;
    }
  })));
  return m.get(type);
}

const made = new WeakMap();                              // ctx -> { name: AudioBuffer } (small synthesised one-shots)
function synth(ctx, name, seconds, fill) {
  let m = made.get(ctx); if (!m) made.set(ctx, m = {});
  if (!m[name]) {
    const n = Math.max(1, Math.round(ctx.sampleRate * seconds)), b = ctx.createBuffer(1, n, ctx.sampleRate);
    fill(b.getChannelData(0), ctx.sampleRate); m[name] = b;
  }
  return m[name];
}
const noiseBuf = ctx => synth(ctx, 'noise', 2, d => { for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; });
// exhaust pop: a sharp crack with a short low thump
const popBuf = ctx => synth(ctx, 'pop', 0.06, (d, sr) => {
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = (Math.random() * 2 - 1) * Math.exp(-t * 160) * 0.8 + Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t * 55) * 0.6; }
});
// gear clunk: the gearbox dogs meeting: a dull knock and a short metallic tick
const clunkBuf = ctx => synth(ctx, 'clunk', 0.12, (d, sr) => {
  for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.sin(2 * Math.PI * 70 * t) * Math.exp(-t * 40) * 0.8 + Math.sin(2 * Math.PI * 1900 * t) * Math.exp(-t * 300) * 0.2 + (Math.random() * 2 - 1) * Math.exp(-t * 400) * 0.25; }
});
// afterburner light-up: a low boom
const boomBuf = ctx => synth(ctx, 'boom', 0.7, (d, sr) => {
  let lp = 0;
  for (let i = 0; i < d.length; i++) { const t = i / sr; lp += ((Math.random() * 2 - 1) - lp) * 0.04; d[i] = (lp * 3 + Math.sin(2 * Math.PI * (48 - 20 * t) * t) * 0.7) * Math.min(1, t * 200) * Math.exp(-t * 5); }
});

// set an audio param only when it moved (keeps the per-frame cost and the audio thread's event list small)
function ease(param, v, t, tau) {
  if (param._v !== undefined && Math.abs(param._v - v) <= 1e-3 * Math.max(1e-3, Math.abs(param._v))) return;
  param._v = v; param.setTargetAtTime(v, t, tau);
}
const kick = (param, peak, t, tau) => { param._v = undefined; param.cancelScheduledValues(t); param.setValueAtTime(peak, t); param.setTargetAtTime(0, t, tau); };

// ---------------------------------------------------------------- one vehicle's engine
export class EngineVoice {
  constructor(ctx, out) { this.ctx = ctx; this.out = out; this.key = null; this.part = null; this.st = newEngineState(); }

  // build the nodes for an engine (the old one fades out and stops)
  setEngine(key) {
    if (key === this.key) return this.part;
    this.dropPart(); this.key = key; this.st = newEngineState();
    const ctx = this.ctx, p = ENGINES[key], part = this.part = { p, sources: [], out: ctx.createGain() };
    part.out.connect(this.out);
    const src = (node, start = true) => { if (start) node.start(); part.sources.push(node); return node; };
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const filter = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    let noise = null;
    const noiseNode = () => { if (!noise) { noise = ctx.createBufferSource(); noise.buffer = noiseBuf(ctx); noise.loop = true; src(noise); } return noise; };
    if (p.loops) {
      // loops -> layer gains -> tone low-pass -> body -> engine level
      part.filter = filter('lowpass', 2500, 0.7);
      const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 160; body.gain.value = 4; body.Q.value = 0.8;
      part.level = gain(); part.filter.connect(body).connect(part.level).connect(part.out);
      part.layers = [];
      loadLoops(ctx, p.loops).then(loops => {
        if (this.part !== part) return;                  // switched away meanwhile
        part.layers = loops.map(l => {
          const g = gain(); g.connect(part.filter);
          const s = ctx.createBufferSource(); s.buffer = l.buf; s.loop = true; s.connect(g); s.start(0, Math.random() * l.buf.duration);
          part.sources.push(s); return { rpm: l.rpm, src: s, gain: g };
        });
      }).catch(e => console.warn('engine sound', key, e));
      if (p.turbo) {                                     // turbo: a whistle with boost and a blow-off hiss on lift-off
        const o = src(ctx.createOscillator()); o.type = 'sine'; o.frequency.value = 2500;
        part.whistleOsc = o; part.whistle = gain(); o.connect(part.whistle).connect(part.out);
        part.bov = gain(); noiseNode().connect(filter('bandpass', 3800, 1.4)).connect(part.bov).connect(part.out);
      }
      if (p.piston) {                                    // propeller: blade-pass buzz + air chopped by the blades
        const o = src(ctx.createOscillator()); o.type = 'sawtooth'; o.frequency.value = 50;
        part.bladeOsc = o; part.bladeBand = filter('bandpass', 150, 2); part.blade = gain();
        o.connect(part.bladeBand).connect(part.blade).connect(part.out);
        const lfo = src(ctx.createOscillator()); lfo.type = 'sine'; lfo.frequency.value = 30; part.chopLfo = lfo;
        const gate = gain(), shaper = ctx.createWaveShaper(), curve = new Float32Array(256);
        for (let i = 0; i < 256; i++) curve[i] = Math.max(0, i / 127.5 - 1) ** 2;
        shaper.curve = curve; lfo.connect(shaper).connect(gate.gain);
        part.chop = gain(); noiseNode().connect(filter('bandpass', 900, 0.7)).connect(gate).connect(part.chop).connect(part.out);
      }
    } else if (p.turbine) {
      // jet: exhaust roar + hiss, compressor whine (two for the twin), afterburner rumble and tearing
      const n = noiseNode();
      part.roarBand = filter('lowpass', 260, 0.7); part.roar = gain(); n.connect(part.roarBand).connect(part.roar).connect(part.out);
      part.hiss = gain(); n.connect(filter('bandpass', 2400, 1.2)).connect(part.hiss).connect(part.out);
      part.whineBand = filter('bandpass', 1200, 6); part.whine = gain(); part.whineBand.connect(part.whine).connect(part.out);
      part.whineOsc = [];
      for (let i = 0; i < p.turbine; i++) { const o = src(ctx.createOscillator()); o.type = 'sawtooth'; o.frequency.value = 400; o.connect(part.whineBand); part.whineOsc.push(o); }
      part.abRumble = gain(); n.connect(filter('lowpass', 95, 1.2)).connect(part.abRumble).connect(part.out);
      part.abTear = gain(); n.connect(filter('bandpass', 480, 0.6)).connect(part.abTear).connect(part.out);
    } else if (p.rotor) {
      // helicopter: low noise + a low tone gated by a pulse at the blade-pass rate (the chop), blade slap gated by the
      // same pulse, tail rotor buzz, turbine whine and hiss under it
      const n = noiseNode(), chop = gain(), slapGate = gain();
      const tone = src(ctx.createOscillator()); tone.type = 'triangle'; tone.frequency.value = 62;
      n.connect(filter('lowpass', 240, 0.9)).connect(chop); tone.connect(chop);
      part.rotorGain = gain(); chop.connect(part.rotorGain).connect(part.out);
      part.slap = gain(); n.connect(filter('bandpass', 650, 1.1)).connect(slapGate).connect(part.slap).connect(part.out);
      const lfo = src(ctx.createOscillator()); lfo.type = 'sine'; lfo.frequency.value = 4; part.rotorLfo = lfo;
      const pulse = ctx.createWaveShaper(), curve = new Float32Array(256);
      for (let i = 0; i < curve.length; i++) curve[i] = Math.max(0, i / 127.5 - 1) ** 3;   // a short thump once per cycle
      pulse.curve = curve; lfo.connect(pulse); pulse.connect(chop.gain); pulse.connect(slapGate.gain);
      const tail = src(ctx.createOscillator()); tail.type = 'triangle'; tail.frequency.value = 20; part.tailOsc = tail;
      part.tail = gain(); tail.connect(part.tail).connect(part.out);
      part.hiss = gain(); n.connect(filter('bandpass', 2400, 1.2)).connect(part.hiss).connect(part.out);
      const w = src(ctx.createOscillator()); w.type = 'sawtooth'; w.frequency.value = 520; part.whineOsc = [w];
      part.whineBand = filter('bandpass', 1200, 8); part.whine = gain(); w.connect(part.whineBand).connect(part.whine).connect(part.out);
    }
    return part;
  }

  dropPart() {
    const part = this.part; if (!part) return;
    const t = this.ctx.currentTime;
    part.out.gain.setTargetAtTime(0, t, 0.03);           // fade, then stop (no click)
    for (const s of part.sources) try { s.stop(t + 0.15); } catch {}
    if (part.sources[0]) part.sources[0].onended = () => part.out.disconnect();
    this.part = null; this.key = null;
  }

  stop() {
    const part = this.part; this.part = null; this.key = null;
    if (part) { for (const s of part.sources) try { s.stop(); } catch {} part.out.disconnect(); }
  }

  oneShot(buf, level, rate = 1) {
    const ctx = this.ctx, s = ctx.createBufferSource(), g = ctx.createGain();
    s.buffer = buf; s.playbackRate.value = rate; g.gain.value = level;
    s.connect(g).connect(this.part.out); s.start();
  }

  update(v, input, dt, kmh) {
    const part = this.setEngine(engineKey(v)), p = part.p, t = this.ctx.currentTime;
    if (p.turbine) return this.updateTurbine(v, part, t, kmh, dt);
    if (p.rotor) return this.updateRotor(v, part, t);
    if (p.piston) return this.updatePiston(v, part, t, kmh, dt);
    const st = this.st, th = Math.max(0, Math.min(1, input?.throttle || 0));
    const ev = stepEngine(st, p, { kmh, throttle: th, grounded: v.grounded || (v.airTime || 0) < 0.2,
      slip: Math.max(v.slip || 0, v.wheelie ? 0.5 : 0), topKmh: v.t?.topSpeed }, dt);
    const frac = Math.max(0, Math.min(1.1, (st.rpm - p.idle) / (p.redline - p.idle)));
    this.mix(part, soundRpm(p, st.rpm), t);
    // on throttle louder and brighter; off throttle muffled and quieter (engine braking); dipped while shifting
    const dip = st.shiftT > 0 ? p.dip : 1;
    if (ev) {
      this.oneShot(clunkBuf(this.ctx), p.clunk * (ev === 'up' ? 0.4 + 0.6 * th : 0.35), 0.9 + Math.random() * 0.2);
      if (ev === 'up' && p.crackle && th > 0.7) st.crackle = Math.max(st.crackle, 0.12);        // a pop on the shift
    }
    ease(part.level.gain, p.gain * (0.5 + 0.6 * th + 0.25 * Math.min(1, frac)) * dip, t, st.shiftT > 0 ? 0.012 : 0.05);
    ease(part.filter.frequency, Math.min(16000, p.bright * (1200 + th * 4200 + frac * 2600) * (dip < 1 ? 0.6 : 1)), t, 0.06);
    // lift-off at high revs: crackle and pops for a while (sports car most)
    if (p.crackle && st.lastThrottle > 0.5 && th < 0.15 && frac > 0.45) st.crackle = 0.4 + 0.9 * frac * p.crackle;
    if (st.crackle > 0) {
      st.crackle -= dt;
      if (th < 0.3 || st.shiftT > 0) if (Math.random() < dt * 22 * Math.min(1, p.crackle + 0.3)) this.oneShot(popBuf(this.ctx), (0.15 + 0.4 * Math.random()) * p.crackle, 0.7 + Math.random() * 0.7);
    }
    if (p.turbo) {
      const want = th * Math.min(1, frac * 1.3);
      if (st.boost > 0.45 && st.lastThrottle > 0.5 && th < 0.15) kick(part.bov.gain, 0.12 * st.boost * p.turbo, t, 0.12);   // blow-off
      st.boost += (want - st.boost) * Math.min(1, dt / (want > st.boost ? 0.7 : 0.25));
      ease(part.whistle.gain, 0.022 * st.boost * p.turbo, t, 0.08);
      ease(part.whistleOsc.frequency, 2400 + 4200 * st.boost, t, 0.1);
    }
    st.lastThrottle = th;
  }

  mix(part, rpm, t, on = 1) {
    const L = part.layers; if (!L.length) return;
    const w = loopMix(L, rpm);
    for (let j = 0; j < L.length; j++) {
      const m = w[0][0] === j ? w[0] : w[1]?.[0] === j ? w[1] : null;
      ease(L[j].gain.gain, m ? m[1] * on : 0, t, 0.04);
      if (m) ease(L[j].src.playbackRate, m[2], t, 0.03);
    }
  }

  // propeller aircraft: the engine's rpm follows the throttle lever (spooling), windmills a little with airspeed
  updatePiston(plane, part, t, kmh, dt) {
    const p = part.p, st = this.st, on = plane.mode === 'crashed' ? 0 : 1, th = Math.max(0, Math.min(1, plane.throttle || 0)) * on;
    st.spool += (th - st.spool) * Math.min(1, dt / 0.5);
    const want = on * (p.idle + (p.redline - p.idle) * st.spool + Math.min(250, kmh) * 0.8 * (1 - st.spool));
    st.rpm += (want - st.rpm) * Math.min(1, dt / (on ? 0.25 : 0.8));
    const run = Math.min(1, st.rpm / p.idle);            // winding down after a crash
    this.mix(part, Math.max(st.rpm, p.idle * 0.5), t, run);
    ease(part.filter.frequency, p.bright * (1500 + st.spool * 4500), t, 0.08);
    ease(part.level.gain, run * p.gain * (0.5 + st.spool * 0.6), t, 0.08);
    const bp = Math.max(8, st.rpm / 60 * p.blades);     // blade passes per second
    ease(part.bladeOsc.frequency, bp, t, 0.08); ease(part.bladeBand.frequency, Math.max(60, bp * 3), t, 0.08);
    ease(part.blade.gain, run * (0.02 + st.spool * 0.05), t, 0.1);
    ease(part.chopLfo.frequency, bp, t, 0.08);
    ease(part.chop.gain, run * (0.04 + st.spool * 0.12) * (plane.mode === 'air' ? 1 : 0.7), t, 0.1);
  }

  // jets: the spool follows the lever with a lag; afterburner at full throttle (lights with a boom)
  updateTurbine(jet, part, t, kmh, dt) {
    const p = part.p, st = this.st, on = jet.mode === 'crashed' ? 0 : 1, th = Math.max(0, Math.min(1, jet.throttle || 0)) * on;
    st.spool += (th - st.spool) * Math.min(1, dt / (th > st.spool ? 1.4 : 1.0));
    const N = st.spool, ab = on && th > 0.97 && N > 0.85 ? 1 : 0;
    if (ab && st.ab < 0.2) this.oneShot(boomBuf(this.ctx), 0.9);
    st.ab += (ab - st.ab) * Math.min(1, dt / (ab ? 0.08 : 0.35));
    ease(part.roar.gain, on * (0.1 + N * 0.5) + st.ab * 0.15, t, 0.15);
    ease(part.roarBand.frequency, 220 + N * 500 + st.ab * 300, t, 0.2);
    ease(part.hiss.gain, on * (0.02 + N * 0.06), t, 0.15);
    const f = (380 + N * 950) * p.whine;
    part.whineOsc.forEach((o, i) => ease(o.frequency, f * (1 + i * 0.012), t, 0.3));
    ease(part.whineBand.frequency, f * 2.2, t, 0.3);
    ease(part.whine.gain, on * (0.012 + N * 0.026) * (1 - 0.4 * st.ab), t, 0.2);
    ease(part.abRumble.gain, st.ab * 0.85, t, 0.08);
    if (st.ab > 0.05) part.abTear.gain.setTargetAtTime(st.ab * 0.22 * (0.6 + 0.8 * Math.random()), t, 0.02);   // flutter
    else ease(part.abTear.gain, 0, t, 0.1);
    if (st.ab > 0.5 && Math.random() < dt * 7) this.oneShot(popBuf(this.ctx), 0.25 * st.ab, 0.35 + Math.random() * 0.2);
  }

  // helicopter: the chop speeds up and gets louder with rotor power, winds down after a crash; slap with power and speed
  updateRotor(h, part, t) {
    const on = h.mode === 'crashed' ? 0 : 1, pw = Math.max(0, Math.min(1, h.throttle || 0)), air = h.mode === 'air';
    const rate = 3 + 11 * pw * pw;                       // blade passes per second
    ease(part.rotorLfo.frequency, rate, t, 0.3);
    ease(part.rotorGain.gain, 0.08 * Math.min(1, pw * 10) + 0.8 * pw * pw, t, 0.2);   // silent once stopped
    const speed = Math.min(1, (h.vel?.length?.() || 0) / 50);
    ease(part.slap.gain, pw * pw * (0.08 + (air ? 0.25 * speed : 0)), t, 0.2);
    ease(part.tailOsc.frequency, rate * 5.3, t, 0.3); ease(part.tail.gain, 0.025 * pw * pw, t, 0.2);
    ease(part.hiss.gain, on * (0.01 + pw * 0.03), t, 0.15);
    ease(part.whine.gain, on * (0.008 + pw * 0.018), t, 0.2);
    ease(part.whineOsc[0].frequency, 520 + pw * 680, t, 0.4);
  }
}
