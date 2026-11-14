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
export function addGliderColorSettings(gui, gliders, storage) {
  let saved = {};
  try { storage ??= globalThis.localStorage; saved = JSON.parse(storage?.getItem(KEY) || '{}') || {}; } catch {}
  const palettes = {};
  const folder = gui.addFolder('Glider colors');
  const save = () => { try { storage?.setItem(KEY, JSON.stringify(palettes)); } catch {} };
  for (const [kind, glider] of Object.entries(gliders)) {
    const palette = palettes[kind] = normalizeGliderColors(saved[kind]);
    setGliderColors(glider.mesh, palette);
    const section = folder.addFolder(kind === 'car' ? 'Car glider' : 'Dirt bike glider');
    const apply = () => { setGliderColors(glider.mesh, palette); save(); };
    for (const [key, label] of [['wing', 'Wing + tail'], ['stripe', 'Center stripe'], ['accent', 'Accent panels']])
      section.addColor(palette, key).name(label).onChange(apply);
    section.add({ solid: () => { palette.stripe = palette.accent = palette.wing; apply(); section.controllersRecursive().forEach(c => c.updateDisplay()); } }, 'solid').name('Make wing one color');
    section.add({ reset: () => { Object.assign(palette, GLIDER_COLORS); apply(); section.controllersRecursive().forEach(c => c.updateDisplay()); } }, 'reset').name('Reset glider colors');
  }
  folder.close();
  return palettes;
}
