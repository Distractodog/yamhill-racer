// Settings → Graphics: Auto (default), Low, Medium, High. Pure data and rules, no three.js or DOM (Node tests import
// it: tools/graphics_unit_test.mjs). graphicsapply.js puts a level on the renderer, sun, fog, camera, world and effects.
// High is the game as it was before this setting existed.
export const GRAPHICS_KEY = 'yr-graphics-2';
export const LEVELS = ['low', 'medium', 'high'];
export const MODES = ['auto', ...LEVELS];
export const LEVEL_NAMES = { auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High' };

// view: fog near/far and camera far; load: tile load radius; terrain: terrain detail-level distances;
// treeNear: full trees inside (m), treeFar: no trees past (m); props / scenery / campusItems: radius factors;
// townNear / townFar: town building ranges; campusNear: detailed campus buildings inside (m);
// shadow: sun shadow map size (0 = no shadows); water: animated ripples; particles: smoke / dust / spray pool size; effectCaps: GPU pools and skid ribbon;
// headlights: beam reach and strength factors (the light itself always stays: removing it recompiles every material)
export const GRAPHICS = {
  high: { pixelCap: 1.5, view: 1, load: 1, terrain: 1, treeNear: 420, treeFar: Infinity, props: 1, scenery: 1, campusItems: 1,
    townNear: 1, townFar: 1, campusNear: 250, shadow: 2048, water: true, particles: 900, effectCaps: { puffs: 900, chips: 420, marks: 12000, discs: 64 }, headlights: { range: 1, power: 1 } },
  medium: { pixelCap: 1.25, view: 0.8, load: 1, terrain: 1, treeNear: 300, treeFar: Infinity, props: 1, scenery: 1, campusItems: 1,
    townNear: 1, townFar: 0.8, campusNear: 250, shadow: 1024, water: true, particles: 600, effectCaps: { puffs: 600, chips: 280, marks: 8000, discs: 48 }, headlights: { range: 1, power: 1 } },
  low: { pixelCap: 1, view: 0.6, load: 0.7, terrain: 0.75, treeNear: 250, treeFar: 600, props: 0.6, scenery: 0.5, campusItems: 0.6,
    townNear: 0.65, townFar: 0.6, campusNear: 150, shadow: 0, water: false, particles: 300, effectCaps: { puffs: 300, chips: 140, marks: 4000, discs: 32 }, headlights: { range: 0.8, power: 0.9 } },
};
export const WEAK_PIXEL_RATIO = 0.85;     // Low on a very weak device
export const MIN_CAMERA_FAR = 1600;       // the sun / moon discs sit 1500 m out (atmosphere.js)

// one level's numbers for this screen: pixelRatio from the device's devicePixelRatio
export function graphicsFor(level, { dpr = 1, weak = false } = {}) {
  const p = GRAPHICS[LEVELS.includes(level) ? level : 'high'];
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const pixelRatio = level === 'low' ? (weak ? WEAK_PIXEL_RATIO : 1) : Math.min(ratio, p.pixelCap);
  return { level: LEVELS.includes(level) ? level : 'high', ...p, pixelRatio };
}

// before anything is measured: a guess from the CPU cores (and a phone / tablet)
export function hardwareGuess({ cores = 0, mobile = false } = {}) {
  if (cores > 0 && cores <= 2) return 'low';
  if ((cores > 0 && cores <= 4) || mobile) return 'medium';
  return 'high';
}

// Auto's pick after ~5 s of play at `level` (fps = 1000 / median frame ms): far too slow → Low; slow → one level
// down; smooth with the display's full rate → one level up; else stay. weak = Low at a pixel ratio under 1.
export const AUTO_FPS = { low: 30, down: 48, up: 57, weak: 24 };
export function autoPick({ level, fps, cores = 0, mobile = false } = {}) {
  const start = LEVELS.includes(level) ? level : hardwareGuess({ cores, mobile });
  if (!(fps > 0) || !Number.isFinite(fps)) return { level: start, weak: false };
  let i = LEVELS.indexOf(start);
  if (fps < AUTO_FPS.low) i = 0;
  else if (fps < AUTO_FPS.down) i = Math.max(0, i - 1);
  else if (fps >= AUTO_FPS.up && i < LEVELS.length - 1 && !mobile) i++;
  const weak = i === 0 && (fps < AUTO_FPS.weak || (cores > 0 && cores <= 2));
  return { level: LEVELS[i], weak };
}

// Frame intervals while playing; done after `seconds` of them. Gaps over maxGap (a held frame, a hidden tab) and
// frames while not playing are left out. fps = 1000 / median interval.
export function createFpsMeter({ seconds = 5, maxGap = 250 } = {}) {
  const samples = []; let total = 0;
  return {
    add(ms) {
      if (!(ms > 0) || ms > maxGap) return false;
      samples.push(ms); total += ms;
      return total >= seconds * 1000;
    },
    get done() { return total >= seconds * 1000; },
    get seconds() { return total / 1000; },
    result() {
      if (!samples.length) return { fps: 0, median: 0, p90: 0, n: 0 };
      const s = samples.slice().sort((a, b) => a - b), at = p => s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
      const median = at(0.5);
      return { fps: 1000 / median, median, p90: at(0.9), n: s.length };
    },
  };
}

// saved per browser: { mode, auto: { level, weak, fps } | null } (auto = Auto's last measured pick)
export function cleanGraphics(raw) {
  const mode = MODES.includes(raw?.mode) ? raw.mode : 'auto';
  const a = raw?.auto;
  const auto = a && LEVELS.includes(a.level) ? { level: a.level, weak: a.weak === true, fps: Number.isFinite(a.fps) ? Math.round(a.fps) : 0 } : null;
  return { mode, auto };
}
export function loadGraphics(storage) {
  try { return cleanGraphics(JSON.parse(storage?.getItem(GRAPHICS_KEY) || 'null')); } catch { return cleanGraphics(null); }
}
export function saveGraphics(storage, state) {
  try { storage?.setItem(GRAPHICS_KEY, JSON.stringify(cleanGraphics(state))); } catch {}
}
