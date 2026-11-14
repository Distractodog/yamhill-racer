// Art-directed lighting presets. No simulation or vehicle handling changes.
import * as THREE from 'three';
import { createRain } from './weatherfx.js';
export const ATMOSPHERE_PRESETS = [
  { id: 'midday', name: 'Clear midday', sky: '#a9cbe3', fog: '#b4cfe0', near: 250, far: 1500, sun: '#fff1d6', power: 2.4, hemi: '#dfefff', ground: '#4a5a3a', ambient: 1.4, direction: [-0.45, .8, .35], night: 0 },
  { id: 'golden', name: 'Golden hour', sky: '#e7b99b', fog: '#d9b59f', near: 320, far: 1800, sun: '#ffbd79', power: 2.5, hemi: '#e6c6af', ground: '#5d5143', ambient: 1.2, direction: [-.8, .32, .4], night: 0 },
  { id: 'morning', name: 'Misty morning', sky: '#c6d4cd', fog: '#c6d4cd', near: 70, far: 850, sun: '#ffe8c4', power: 1.3, hemi: '#dae4e0', ground: '#657064', ambient: 1.5, direction: [.72, .4, -.4], night: 0 },
  { id: 'dusk', name: 'Rose dusk', sky: '#887f9e', fog: '#9d8eaa', near: 220, far: 1300, sun: '#ffaf96', power: 1.1, hemi: '#b7bddc', ground: '#49495a', ambient: 1.25, direction: [-.9, .22, .3], night: .6 },
  { id: 'rain', name: 'Valley rain', sky: '#889b9e', fog: '#9eafb0', near: 70, far: 950, sun: '#dae5e8', power: .8, hemi: '#d3e0df', ground: '#46534a', ambient: 1.5, direction: [-.4, .8, .4], night: 0, wetness: .8 },
  { id: 'night', name: 'Moonlit night', sky: '#141e36', fog: '#253149', near: 180, far: 1050, sun: '#c4d7ff', power: .7, hemi: '#a4b9e3', ground: '#343b48', ambient: .95, direction: [.4, .7, -.5], night: 1 },
];
const KEY = 'yr-atmosphere-1';
function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
export function createAtmosphere({ scene, sun, sunDirection, world, storage = browserStorage() }) {
  const hemi = scene.children.find(o => o.isHemisphereLight);
  let current = ATMOSPHERE_PRESETS[0], disposed = false;
  const rain = createRain({ scene });
  const starsGeometry = new THREE.BufferGeometry(), starsPos = [];
  // Deterministic hemisphere; a single draw call, visible only at night.
  let seed = 913; const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 160; i++) { const a = random() * Math.PI * 2, y = .16 + random() * .84, r = Math.sqrt(1 - y * y); starsPos.push(Math.cos(a) * r * 1200, y * 1200, Math.sin(a) * r * 1200); }
  starsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starsPos, 3));
  const starsMaterial = new THREE.PointsMaterial({ color: '#dbe7ff', size: 2, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false });
  const stars = new THREE.Points(starsGeometry, starsMaterial); stars.name = 'night-stars'; stars.frustumCulled = false; scene.add(stars);
  function setPreset(id, persist = true) {
    const next = ATMOSPHERE_PRESETS.find(p => p.id === id); if (!next || disposed) return false;
    current = next;
    scene.background.set(next.sky);
    if (scene.fog) { scene.fog.color.set(next.fog); scene.fog.near = next.near; scene.fog.far = next.far; }
    sun.color.set(next.sun); sun.intensity = next.power;
    if (hemi) { hemi.color.set(next.hemi); hemi.groundColor.set(next.ground); hemi.intensity = next.ambient; }
    sunDirection?.fromArray(next.direction).normalize();
    stars.visible = next.night >= .9; world.setNight?.(next.night);
    rain.setEnabled(next.id === 'rain');
    world.setWetness?.(next.wetness || 0);
    if (persist) { try { storage?.setItem(KEY, id); } catch {} }
    return true;
  }
  let saved; try { saved = storage?.getItem(KEY); } catch {}
  setPreset(ATMOSPHERE_PRESETS.some(p => p.id === saved) ? saved : 'midday', false);
  return {
    presets: ATMOSPHERE_PRESETS.map(({ id, name }) => ({ id, name })),
    get preset() { return current.id; }, get night() { return current.night; }, get wetness() { return current.wetness || 0; }, setPreset,
    update(dt, camera) { if (disposed) return; if (stars.visible && camera) stars.position.copy(camera.position || camera); rain.update(dt, camera); },
    dispose() { if (disposed) return; disposed = true; scene.remove(stars); starsGeometry.dispose(); starsMaterial.dispose(); rain.dispose(); },
  };
}
