// Display units: metric (km/h, m, km) or imperial (mph, ft, mi). Display only — physics, tuning and saved
// records stay metric; everything here converts at draw time. U toggles, or click the unit next to the speed.
const KEY = 'yr-units-1';
const MPH = 1 / 1.609344, FT = 3.28084, MI = 1609.344;

let units = 'metric';
try { if (globalThis.localStorage?.getItem(KEY) === 'imperial') units = 'imperial'; } catch {}
const listeners = new Set();

export const getUnits = () => units;
export const imperial = () => units === 'imperial';
export function setUnits(u) {
  units = u === 'imperial' ? 'imperial' : 'metric';
  try { globalThis.localStorage?.setItem(KEY, units); } catch {}
  for (const f of listeners) f(units);
}
export const toggleUnits = () => setUnits(imperial() ? 'metric' : 'imperial');
export const onUnits = f => { listeners.add(f); return () => listeners.delete(f); };

export const speedUnit = () => (imperial() ? 'mph' : 'km/h');
/** speed in m/s → whole number in the current unit */
export const speedValue = ms => Math.round(ms * 3.6 * (imperial() ? MPH : 1));
/** a km/h figure (e.g. "90 km/h" in a hint) → text in the current unit */
export const fmtKmh = kmh => imperial() ? `${Math.round(kmh * MPH)} mph` : `${kmh} km/h`;

/** distance in metres → short text: m/km or ft/mi. `fine` keeps 2 decimals under 10 km / 10 mi. */
export function fmtDist(m, { round = 1, fine = false } = {}) {
  if (imperial()) {
    const step = round > 1 ? 10 : 1;       // pin counter rounds to 10 m → 10 ft
    if (m < 0.1 * MI) return `${Math.round(m * FT / step) * step} ft`;
    const mi = m / MI;
    return `${mi.toFixed(fine && mi < 10 ? 2 : 1)} mi`;
  }
  if (m < 1000) return `${Math.round(m / round) * round} m`;
  const km = m / 1000;
  return `${km.toFixed(fine && km < 10 ? 2 : 1)} km`;
}
/** a height in metres → m or ft */
export const fmtHeight = m => imperial() ? `${Math.round(m * FT)} ft` : `${Math.round(m)} m`;
