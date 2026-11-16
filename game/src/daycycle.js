// Day/night clock, look keyframes and random showers: pure numbers, no three.js or DOM (tools/daynight_test.mjs).
// atmosphere.js applies the result to the scene. Times are seconds into the cycle; every game starts at morning (0).
export const ATMOSPHERE_PRESETS = [
  { id: 'midday', name: 'Clear midday', sky: '#a9cbe3', fog: '#b4cfe0', near: 250, far: 1500, sun: '#fff1d6', power: 2.4, hemi: '#dfefff', ground: '#4a5a3a', ambient: 1.4, direction: [-0.45, .8, .35], night: 0 },
  { id: 'golden', name: 'Golden hour', sky: '#e7b99b', fog: '#d9b59f', near: 320, far: 1800, sun: '#ffbd79', power: 2.5, hemi: '#e6c6af', ground: '#5d5143', ambient: 1.2, direction: [-.8, .32, .4], night: 0 },
  { id: 'morning', name: 'Misty morning', sky: '#c6d4cd', fog: '#c6d4cd', near: 70, far: 850, sun: '#ffe8c4', power: 1.3, hemi: '#dae4e0', ground: '#657064', ambient: 1.5, direction: [.72, .4, -.4], night: 0 },
  { id: 'dusk', name: 'Rose dusk', sky: '#887f9e', fog: '#9d8eaa', near: 220, far: 1300, sun: '#ffaf96', power: 1.1, hemi: '#b7bddc', ground: '#49495a', ambient: 1.25, direction: [-.9, .22, .3], night: .6 },
  { id: 'rain', name: 'Valley rain', sky: '#889b9e', fog: '#9eafb0', near: 70, far: 950, sun: '#dae5e8', power: .8, hemi: '#d3e0df', ground: '#46534a', ambient: 1.5, direction: [-.4, .8, .4], night: 0, wetness: .8 },
  { id: 'night', name: 'Moonlit night', sky: '#141e36', fog: '#253149', near: 180, far: 1050, sun: '#c4d7ff', power: .7, hemi: '#a4b9e3', ground: '#343b48', ambient: .95, direction: [.4, .7, -.5], night: 1 },
];

// ---- every timing constant of the cycle (minutes of real time at speed 1)
export const MINUTE = 60;
export const PHASES = [
  { id: 'morning', name: 'Morning', minutes: 5 },
  { id: 'day', name: 'Day', minutes: 20 },
  { id: 'dusk', name: 'Dusk', minutes: 5 },
  { id: 'night', name: 'Night', minutes: 20 },
];
export const CYCLE = PHASES.reduce((s, p) => s + p.minutes, 0) * MINUTE;      // 50 min
// Looks along the cycle; between two keys the look blends with a smoothstep (no jumps). The last key blends back
// into the first (night → morning).
export const LOOK_KEYS = [
  [0, 'morning'], [3, 'morning'],          // morning: misty
  [9, 'midday'], [21, 'midday'],           // day
  [25, 'golden'], [26.5, 'golden'],        // dusk: golden hour into rose dusk
  [29, 'dusk'], [30.5, 'dusk'],
  [33, 'night'], [46.5, 'night'],          // night, then dawn into the next morning
];
// "Time now" in Settings jumps here (where that phase's look is at its fullest)
export const JUMPS = { morning: 0, day: 9, dusk: 25, night: 33 };
// Sun and moon arcs: rise in the east (+x) at `rise`, highest leaning south (+z) by `tilt`, set in the west at `set`
export const SUN = { rise: -4, set: 31, tilt: .52 };
export const MOON = { rise: 28, set: 49, tilt: .7 };
// how much the directional light comes from the moon rather than the sun (blended like the looks)
export const MOON_LIGHT = [[30.5, 0], [33, 1], [46.5, 1], [49.5, 0]];
export const LIGHT_MIN_Y = .22;            // the light never comes lower than this (long shadows stay readable)
// Random showers (cycle-clock time): the next starts 30–60 min after the last ended and lasts 3–8 min
export const WEATHER = { gap: [30, 60], length: [3, 8], fade: 30 };
export const WEATHER_MODES = ['random', 'clear', 'rain'];

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = f => f * f * (3 - 2 * f);
export const wrapTime = t => ((t % CYCLE) + CYCLE) % CYCLE;

// sRGB hex → linear rgb, as three.js Color.set does with colour management on
function linear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map(c => { c /= 255; return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4); });
}
const COLORS = ['sky', 'fog', 'sun', 'hemi', 'ground'], NUMBERS = ['near', 'far', 'power', 'ambient', 'night', 'wetness'];
export function makeLook() { const o = {}; for (const k of COLORS) o[k] = [0, 0, 0]; for (const k of NUMBERS) o[k] = 0; return o; }
const LOOKS = {};
for (const p of ATMOSPHERE_PRESETS) { const o = makeLook(); for (const k of COLORS) o[k] = linear(p[k]); for (const k of NUMBERS) o[k] = p[k] || 0; LOOKS[p.id] = o; }
const lum = c => c[0] * .2126 + c[1] * .7152 + c[2] * .0722;

export function blendLook(a, b, f, out) {
  for (const k of COLORS) { const x = a[k], y = b[k], o = out[k]; o[0] = x[0] + (y[0] - x[0]) * f; o[1] = x[1] + (y[1] - x[1]) * f; o[2] = x[2] + (y[2] - x[2]) * f; }
  for (const k of NUMBERS) out[k] = a[k] + (b[k] - a[k]) * f;
  return out;
}
export function fixedLook(id, out = makeLook()) { return blendLook(LOOKS[id] || LOOKS.midday, LOOKS[id] || LOOKS.midday, 0, out); }

// piecewise smoothstep through [minute, value] keys that wrap around the cycle; returns [i, j, f]
const seg = [0, 0, 0];
function segment(keys, t) {
  const m = wrapTime(t) / MINUTE, n = keys.length;
  for (let i = 0; i < n; i++) {
    const a = keys[i][0], b = i + 1 < n ? keys[i + 1][0] : keys[0][0] + CYCLE / MINUTE;
    const mm = m < keys[0][0] ? m + CYCLE / MINUTE : m;
    if (mm >= a && mm < b) { seg[0] = i; seg[1] = (i + 1) % n; seg[2] = smooth((mm - a) / (b - a)); return seg; }
  }
  seg[0] = seg[1] = 0; seg[2] = 0; return seg;
}
export function lookAt(t, out = makeLook()) {
  const [i, j, f] = segment(LOOK_KEYS, t);
  return blendLook(LOOKS[LOOK_KEYS[i][1]], LOOKS[LOOK_KEYS[j][1]], f, out);
}
// Valley rain over whatever time it is: at full rain in daylight the look is the rain preset; at night its colours
// and light are dimmed as much as the time's own are below midday's.
export function rainOver(look, r, out = look) {
  const rain = LOOKS.rain, day = LOOKS.midday;
  for (const k of COLORS) {
    const s = Math.min(1, lum(look[k]) / lum(day[k])) * r, c = look[k], w = rain[k], o = out[k];
    o[0] = c[0] + (w[0] * s - c[0] * r); o[1] = c[1] + (w[1] * s - c[1] * r); o[2] = c[2] + (w[2] * s - c[2] * r);
  }
  out.near = look.near + (rain.near - look.near) * r; out.far = look.far + (rain.far - look.far) * r;
  out.power = look.power + (rain.power * Math.min(1, look.power / day.power) - look.power) * r;
  out.ambient = look.ambient + (rain.ambient * Math.min(1, look.ambient / day.ambient) - look.ambient) * r;
  out.night = look.night; out.wetness = rain.wetness * r;
  return out;
}

// unit direction toward a sun / moon body at time t (below the horizon outside rise..set)
export function arcDir(t, body, out = [0, 0, 0]) {
  const span = (body.set - body.rise) * MINUTE, u = wrapTime(t - body.rise * MINUTE) / span;
  const a = u <= 1 ? u * Math.PI : Math.PI + (u - 1) / (CYCLE / span - 1) * Math.PI;
  const s = Math.sin(a);
  out[0] = Math.cos(a); out[1] = s * Math.cos(body.tilt); out[2] = s * Math.sin(body.tilt);
  return out;
}
function liftTo(d, minY) {
  if (d[1] >= minY) return d;
  const h = Math.hypot(d[0], d[2]) || 1, k = Math.sqrt(1 - minY * minY) / h;
  d[0] *= k; d[1] = minY; d[2] *= k; return d;
}
const _sun = [0, 0, 0], _moon = [0, 0, 0];
export function moonWeight(t) { const [i, j, f] = segment(MOON_LIGHT, t); return MOON_LIGHT[i][1] + (MOON_LIGHT[j][1] - MOON_LIGHT[i][1]) * f; }
// while the light swings from the sun to the moon (or back) it fades to this much, so shadows don't sweep visibly
export const HANDOFF_DIM = .35;
export const handoffDim = t => { const w = moonWeight(t); return 1 - (1 - HANDOFF_DIM) * 4 * w * (1 - w); };
// the directional light: the sun by day, the moon by night, never below LIGHT_MIN_Y
export function lightDir(t, out = [0, 0, 0]) {
  liftTo(arcDir(t, SUN, _sun), LIGHT_MIN_Y); liftTo(arcDir(t, MOON, _moon), LIGHT_MIN_Y);
  const w = moonWeight(t);
  for (let k = 0; k < 3; k++) out[k] = _sun[k] + (_moon[k] - _sun[k]) * w;
  const l = Math.hypot(out[0], out[1], out[2]); out[0] /= l; out[1] /= l; out[2] /= l;
  return out;
}
export function phaseAt(t) {
  let m = wrapTime(t) / MINUTE;
  for (const p of PHASES) { if (m < p.minutes) return p.id; m -= p.minutes; }
  return PHASES[0].id;
}

// Park–Miller generator: the same seed gives the same showers
export function createRng(seed = 1) {
  let s = Math.floor(Math.abs(seed)) % 2147483646 + 1;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}
// Shower scheduler on the cycle clock (seconds). level fades toward the target over WEATHER.fade seconds.
export function createShowers({ seed = 1 } = {}) {
  const rng = createRng(seed), pick = ([a, b]) => (a + (b - a) * rng()) * MINUTE;
  let elapsed = 0, start = pick(WEATHER.gap), end = start + pick(WEATHER.length);
  return {
    get raining() { return elapsed >= start && elapsed < end; },
    get next() { return { start, end }; },
    get elapsed() { return elapsed; },
    update(dt) {
      elapsed += dt;
      while (elapsed >= end) { start = end + pick(WEATHER.gap); end = start + pick(WEATHER.length); }
    },
  };
}

// The whole state: player settings (cycle on/off, the fixed look, weather), the clock, showers, and while a guest
// follows the multiplayer host, the host's settings and clock. update(dt) fills `out` for atmosphere.js.
export const DEFAULT_SETTINGS = { cycle: true, look: 'midday', weather: 'random' };
export function cleanSettings(s, base = DEFAULT_SETTINGS) {
  return {
    cycle: typeof s?.cycle === 'boolean' ? s.cycle : base.cycle,
    look: LOOKS[s?.look] ? s.look : base.look,
    weather: WEATHER_MODES.includes(s?.weather) ? s.weather : base.weather,
  };
}
export function createDayCycle({ settings = DEFAULT_SETTINGS, seed = 1, speed = 1 } = {}) {
  let own = cleanSettings(settings), host = null, time = 0, level = 0, jumps = 0, correction = 0, hostRaining = false, ownSpeed = speed;
  const showers = createShowers({ seed });
  const out = { look: makeLook(), light: [0, 0, 0], sun: [0, 0, 0], moon: [0, 0, 0], sunUp: 0, moonUp: 0, stars: 0, rain: 0, discs: false };
  const current = () => host || own;
  const target = () => { const s = current(); return s.weather === 'rain' ? 1 : s.weather === 'clear' ? 0 : host ? (hostRaining ? 1 : 0) : (showers.raining ? 1 : 0); };
  function compute() {
    const s = current(), o = out;
    if (!s.cycle) {
      const p = ATMOSPHERE_PRESETS.find(q => q.id === s.look);
      fixedLook(s.look, o.look);
      const d = p.direction, l = Math.hypot(d[0], d[1], d[2]);
      o.light[0] = d[0] / l; o.light[1] = d[1] / l; o.light[2] = d[2] / l;
      o.sunUp = o.moonUp = 0; o.discs = false; o.stars = p.night >= .9 ? 1 : 0; o.rain = s.look === 'rain' ? 1 : 0;
      return o;
    }
    rainOver(lookAt(time, o.look), level);
    o.look.power *= handoffDim(time);
    lightDir(time, o.light); arcDir(time, SUN, o.sun); arcDir(time, MOON, o.moon);
    const clear = 1 - level;
    o.sunUp = clamp01((o.sun[1] + .04) / .1) * (1 - .9 * level);
    o.moonUp = clamp01((o.moon[1] + .04) / .1) * (.25 + .75 * clamp01(o.look.night / .6)) * (1 - .8 * level);
    o.stars = clamp01((o.look.night - .6) / .4) * clear; o.rain = level; o.discs = true;
    return o;
  }
  const api = {
    out,
    get time() { return time; },
    get speed() { return speed; },
    set speed(v) { speed = Number.isFinite(v) && v >= 0 ? Math.min(3600, v) : 1; },
    get phase() { return phaseAt(time); },
    get rain() { return level; },
    get raining() { return target() > 0; },
    get settings() { return { ...current() }; },
    get own() { return { ...own }; },
    get following() { return !!host; },
    get showers() { return showers; },
    // player settings; a new weather choice shows at once, a shower from the scheduler fades
    set(next) {
      const weather = own.weather; own = cleanSettings(next, own);
      if (!host && own.weather !== weather) level = target();
      compute(); return api.settings;
    },
    // "Time now": a phase id from JUMPS, or seconds into the cycle (tests, tools/daynight_shots.mjs)
    jump(to) {
      const t = typeof to === 'number' ? to : Object.hasOwn(JUMPS, to) ? JUMPS[to] * MINUTE : NaN;
      if (!Number.isFinite(t)) return false;
      time = wrapTime(t); correction = 0; jumps++; compute(); return true;
    },
    update(dt) {
      dt = Number.isFinite(dt) ? Math.max(0, Math.min(1, dt)) : 0;
      const step = dt * speed;
      let fix = 0;
      if (host && correction) { fix = correction * Math.min(1, dt / 4); correction -= fix; }      // ease into the host's clock
      time = wrapTime(time + step + fix);
      showers.update(step);
      const want = target(), rate = step / WEATHER.fade;
      level = want > level ? Math.min(want, level + rate) : Math.max(want, level - rate);
      return compute();
    },
    // multiplayer: what a host shares (changes trigger a send) and its clock (sent with it, and every so often)
    shared() { const s = current(); return { preset: s.look, cycle: s.cycle, weather: s.weather, raining: target() > 0, jumps }; },
    clock() { return { time: Math.round(time * 100) / 100, rain: Math.round(level * 1000) / 1000, speed }; },
    follow(state) {
      if (!state || typeof state !== 'object') return;
      const first = !host;
      if (first) ownSpeed = speed;
      // a host without the cycle (older build) sends just its preset: that fixed look
      host = cleanSettings({ cycle: state.cycle ?? false, look: state.preset, weather: state.weather }, host || own);
      hostRaining = state.raining === true;
      if (Number.isFinite(state.speed)) api.speed = state.speed;
      if (Number.isFinite(state.time)) {
        let d = wrapTime(state.time - time); if (d > CYCLE / 2) d -= CYCLE;
        if (first || Math.abs(d) > 2 * MINUTE) { time = wrapTime(state.time); correction = 0; } else correction = d;
      }
      if (Number.isFinite(state.rain) && (first || Math.abs(state.rain - level) > .5)) level = clamp01(state.rain);
      else if (!Number.isFinite(state.rain)) level = target();
      compute();
    },
    // back to the player's own settings; the clock carries on from the host's time and rain fades to the own weather
    unfollow() { if (!host) return; host = null; correction = 0; api.speed = ownSpeed; compute(); },
  };
  api.speed = speed; ownSpeed = api.speed; level = target();
  compute();
  return api;
}
