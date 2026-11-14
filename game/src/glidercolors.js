// Glider appearance changes only when a picker changes; flight physics and vehicle paint are independent.
import * as THREE from 'three';
export const GLIDER_COLORS = Object.freeze({ wing: '#e8402f', stripe: '#e8402f', accent: '#faf6ea' });
const KEY = 'yr-glider-colors-1';
export function normalizeGliderColors(value = {}) {
  return Object.fromEntries(Object.entries(GLIDER_COLORS).map(([key, fallback]) =>
    [key, typeof value?.[key] === 'string' && /^#[0-9a-f]{6}$/i.test(value[key]) ? value[key].toLowerCase() : fallback]));
}
export function setGliderColors(model, value) {
  const palette = normalizeGliderColors(value);
  const sail = model.getObjectByName('glider-sail'), fin = model.getObjectByName('glider-fin');
  if (!sail || !fin) return;
  const colors = [palette.stripe, palette.wing, palette.accent].map(c => new THREE.Color(c));
  const attribute = sail.geometry.getAttribute('color'), panels = sail.geometry.userData.gliderPanels;
  for (let i = 0; i < attribute.count; i++) { const c = colors[panels[i]]; attribute.setXYZ(i, c.r, c.g, c.b); }
  attribute.needsUpdate = true;
  fin.material.color.set(palette.wing);
}
export function createGliderColors(gliders, storage) {
  let saved = {};
  try { storage ??= globalThis.localStorage; saved = JSON.parse(storage?.getItem(KEY) || '{}') || {}; } catch {}
  const palettes = {};
  for (const [kind, glider] of Object.entries(gliders)) {
    palettes[kind] = normalizeGliderColors(saved[kind]);
    setGliderColors(glider.mesh, palettes[kind]);
  }
  function set(kind, changes) {
    if (!gliders[kind]) return false;
    palettes[kind] = normalizeGliderColors({ ...palettes[kind], ...changes });
    setGliderColors(gliders[kind].mesh, palettes[kind]);
    try { if (!storage) return false; storage.setItem(KEY, JSON.stringify(palettes)); return true; } catch { return false; }
  }
  return {
    get: kind => palettes[kind] ? { ...palettes[kind] } : null,
    set,
    solid: kind => set(kind, { stripe: palettes[kind]?.wing, accent: palettes[kind]?.wing }),
    reset: kind => set(kind, GLIDER_COLORS),
  };
}
