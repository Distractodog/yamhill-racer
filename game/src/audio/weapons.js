// Cached procedural buffers, bounded one-shot voices, through the existing Effects volume bus.
const caches = new WeakMap();
export function weaponBuffer(ctx, kind) {
  let cache = caches.get(ctx); if (!cache) caches.set(ctx, cache = new Map());
  const name = kind === 'cannon' ? 'cannon' : kind === 'explosion' ? 'explosion' : 'launch';
  if (cache.has(name)) return cache.get(name);
  const life = name === 'cannon' ? .09 : name === 'launch' ? .5 : 1.1;
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * life), ctx.sampleRate), data = buffer.getChannelData(0);
  let seed = 31, low = 0;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const t = i / ctx.sampleRate, noise = seed / 2147483648 - 1; low += .07 * (noise - low);
    const fade = Math.min(1, t * 1000) * Math.exp(-t * (name === 'cannon' ? 45 : name === 'launch' ? 8 : 5));
    data[i] = (name === 'cannon' ? noise * .45 + Math.sin(t * 650) * .4 : name === 'launch' ? noise * .65 : low * 2 + Math.sin(t * 240 - t * t * 90) * .5) * fade;
  }
  cache.set(name, buffer); return buffer;
}
export class WeaponAudio {
  constructor(ctx, out) { this.ctx = ctx; this.out = out; this.voices = new Set(); }
  shot(kind, level) {
    if (this.voices.size >= 24 || level < .003) return;
    const s = this.ctx.createBufferSource(), g = this.ctx.createGain();
    s.buffer = weaponBuffer(this.ctx, kind); g.gain.value = Math.min(1, level) * (kind === 'explosion' ? .85 : .35);
    s.connect(g).connect(this.out); this.voices.add(s);
    s.onended = () => { this.voices.delete(s); s.disconnect(); g.disconnect(); }; s.start();
  }
  stop() { for (const s of this.voices) s.stop(); this.voices.clear(); }
}
