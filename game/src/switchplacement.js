const KEY = 'yr-switch-placement-1';
const MODES = ['open', 'paved', 'road'];
let current = 'open';
let initialized = false;
export function getSwitchPlacement() {
  if (initialized) return current;
  initialized = true;
  try {
    if (globalThis.localStorage) {
      const value = globalThis.localStorage.getItem(KEY);
      current = MODES.includes(value) ? value : 'open';
    }
  } catch {}
  return current;
}
export function setSwitchPlacement(value) {
  initialized = true;
  current = MODES.includes(value) ? value : 'open';
  try { globalThis.localStorage?.setItem(KEY, current); } catch {}
}
