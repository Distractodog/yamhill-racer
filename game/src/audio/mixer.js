// Volume buses (Settings → Sound): master <- engines (yours and other players') + effects (tyres, wind, impacts...).
// One mixer per audio context, so other players' engine voices (mp/remotes.js) go through the same sliders.
export const SOUND_KEY = 'yr-sound-1';
export const SOUND_DEFAULTS = Object.freeze({ master: 1, engines: 1, effects: 1 });
export const SOUND_CHANNELS = ['master', 'engines', 'effects'];

// only known channels with real numbers, clamped to 0..1 (a saved null / NaN must not mute the game for good)
export function sanitizeSound(v) {
  const out = { ...SOUND_DEFAULTS };
  for (const k of SOUND_CHANNELS) if (typeof v?.[k] === 'number' && Number.isFinite(v[k])) out[k] = Math.min(1, Math.max(0, v[k]));
  return out;
}
export function loadSound(storage = globalThis.localStorage) {
  try { return sanitizeSound(JSON.parse(storage?.getItem(SOUND_KEY) || 'null')); } catch { return { ...SOUND_DEFAULTS }; }
}
export function saveSound(v, storage = globalThis.localStorage) {
  try { storage?.setItem(SOUND_KEY, JSON.stringify(sanitizeSound(v))); } catch {}
}
// slider position (0..1) -> gain: squared, so the slider feels even to the ear; 100% = the game's normal level
export const sliderGain = v => Math.max(0, Math.min(1, v)) ** 2;

const mixers = new WeakMap();
export function mixerFor(ctx, out = ctx.destination) {
  let m = mixers.get(ctx);
  if (!m) {
    const bus = () => { const g = ctx.createGain(); g.gain.value = 1; return g; };
    const master = bus(), engines = bus(), effects = bus();
    engines.connect(master); effects.connect(master); master.connect(out);
    m = { master, engines, effects, values: { ...SOUND_DEFAULTS },
      set(v) {
        this.values = sanitizeSound({ ...this.values, ...v });
        for (const k of SOUND_CHANNELS) this[k].gain.setTargetAtTime(sliderGain(this.values[k]), ctx.currentTime, 0.03);
      } };
    mixers.set(ctx, m);
  }
  return m;
}
