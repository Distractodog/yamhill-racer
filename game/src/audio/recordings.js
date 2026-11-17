// Optional recordings. Failed loads retain procedural audio; each file is fetched
// and decoded at most once per context, shared by local and remote voices.
export const EFFECT_RECORDINGS = {
  squeal: 'recordings/tyre_squeal.wav',
  impact: 'recordings/impact.wav',
};
export const effectSoundLog = [];
const contexts = new WeakMap();

export function recordedEffect(ctx, name) {
  const file = EFFECT_RECORDINGS[name];
  if (!file) return null;
  let cache = contexts.get(ctx);
  if (!cache) contexts.set(ctx, cache = new Map());
  if (!cache.has(name)) {
    const entry = { buffer: null, ready: null };
    cache.set(name, entry);
    entry.ready = (async () => {
      try {
        const response = await fetch(new URL(`../../assets/audio/${file}`, import.meta.url));
        if (response.ok === false) throw new Error(`HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        entry.buffer = await ctx.decodeAudioData(bytes);
        effectSoundLog.push({ effect: name, file, bytes: bytes.byteLength, seconds: entry.buffer.duration, rate: entry.buffer.sampleRate });
      } catch (error) {
        effectSoundLog.push({ effect: name, file, error: String(error?.message || error), fallback: 'procedural' });
      }
      return entry.buffer;
    })();
  }
  return cache.get(name);
}
