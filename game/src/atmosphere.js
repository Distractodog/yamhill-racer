// Lighting, sky, fog, stars, sun/moon and rain from the day/night cycle (daycycle.js) or a fixed preset look.
// No simulation or vehicle handling changes. Only values change over time: the same lights, fog type and meshes stay
// in the scene for good (no shader recompiles).
import * as THREE from 'three';
import { createRain } from './weatherfx.js';
import { ATMOSPHERE_PRESETS, DEFAULT_SETTINGS, PHASES, cleanSettings, createDayCycle } from './daycycle.js';
export { ATMOSPHERE_PRESETS };
const KEY = 'yr-atmo-2', OLD_KEY = 'yr-atmosphere-1';
const SKY_DISTANCE = 1500;       // sun / moon discs (camera far is 2200)
function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
// Saved settings; a player who had picked a look other than the old default keeps it, with the cycle off
export function loadAtmosphereSettings(storage) {
  try { const saved = storage?.getItem(KEY); if (saved) return cleanSettings(JSON.parse(saved)); } catch {}
  let old; try { old = storage?.getItem(OLD_KEY); } catch {}
  if (old !== 'midday' && ATMOSPHERE_PRESETS.some(p => p.id === old)) return { ...DEFAULT_SETTINGS, cycle: false, look: old };
  return { ...DEFAULT_SETTINGS };
}
export function createAtmosphere({ scene, sun, sunDirection, world, storage = browserStorage(), speed = 1, seed = Date.now() }) {
  const hemi = scene.children.find(o => o.isHemisphereLight);
  let disposed = false, worldNight = -1, worldWet = -1;
  const cycle = createDayCycle({ settings: loadAtmosphereSettings(storage), seed, speed });
  const listeners = new Set();
  const changed = () => listeners.forEach(fn => { try { fn(); } catch (e) { console.warn('atmosphere:', e); } });
  const rain = createRain({ scene });
  const starsGeometry = new THREE.BufferGeometry(), starsPos = [];
  // Deterministic hemisphere; a single draw call, shown only at night.
  let starSeed = 913; const random = () => ((starSeed = (starSeed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 160; i++) { const a = random() * Math.PI * 2, y = .16 + random() * .84, r = Math.sqrt(1 - y * y); starsPos.push(Math.cos(a) * r * 1200, y * 1200, Math.sin(a) * r * 1200); }
  starsGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starsPos, 3));
  const starsMaterial = new THREE.PointsMaterial({ color: '#dbe7ff', size: 2, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false });
  const stars = new THREE.Points(starsGeometry, starsMaterial); stars.name = 'night-stars'; stars.frustumCulled = false; scene.add(stars);
  // Sun (disc + soft halo) and moon: flat discs turned to the camera, beyond the fog, behind any terrain
  const discGeometry = new THREE.CircleGeometry(1, 28), haloGeometry = new THREE.CircleGeometry(1, 28);
  // the halo fades out from its centre (vertex 0) to its rim: white with alpha 1 → 0
  haloGeometry.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: haloGeometry.attributes.position.count }, (_, i) => [1, 1, 1, i ? 0 : 1]).flat(), 4));
  const disc = (name, color, radius, geometry = discGeometry) => {
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, fog: false, vertexColors: geometry === haloGeometry });
    const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.scale.setScalar(radius); mesh.visible = false; mesh.renderOrder = -1;
    scene.add(mesh); return mesh;
  };
  const sunHalo = disc('sky-sun-halo', '#fff4dc', 190, haloGeometry), sunDisc = disc('sky-sun', '#fff6e2', 38), moonDisc = disc('sky-moon', '#e6ecf7', 30);
  const discs = [[sunHalo, 'sun', .45], [sunDisc, 'sun', 1], [moonDisc, 'moon', 1]];
  const _v = new THREE.Vector3();
  function apply() {
    const o = cycle.out, L = o.look;
    scene.background.setRGB(...L.sky);
    if (scene.fog) { scene.fog.color.setRGB(...L.fog); scene.fog.near = L.near; scene.fog.far = L.far; }
    sun.color.setRGB(...L.sun); sun.intensity = L.power;
    if (hemi) { hemi.color.setRGB(...L.hemi); hemi.groundColor.setRGB(...L.ground); hemi.intensity = L.ambient; }
    sunDirection?.fromArray(o.light);
    starsMaterial.opacity = o.stars; stars.visible = o.stars > .005;
    rain.setAmount(o.rain);
    // the world's lit windows and wet roads only change in 1% steps
    const night = Math.round(L.night * 100) / 100, wet = Math.round(L.wetness * 100) / 100;
    if (night !== worldNight) { worldNight = night; world.setNight?.(night); }
    if (wet !== worldWet) { worldWet = wet; world.setWetness?.(wet); }
    for (const [mesh, body, alpha] of discs) {
      const up = body === 'sun' ? o.sunUp : o.moonUp;
      mesh.material.opacity = up * alpha; mesh.visible = o.discs && up > .005;
    }
    if (o.sunUp > 0) sunDisc.material.color.setRGB(...L.sun).lerp(_white, .55);
  }
  const _white = new THREE.Color(1, 1, 1);
  function save() { try { storage?.setItem(KEY, JSON.stringify(cycle.own)); } catch {} }
  function set(next, persist = true) {
    if (disposed) return false;
    cycle.set(next); apply(); if (persist) save(); changed(); return true;
  }
  function setPreset(id, persist = true) {
    if (!ATMOSPHERE_PRESETS.some(p => p.id === id)) return false;
    return set({ cycle: false, look: id }, persist);
  }
  apply();
  const api = {
    presets: ATMOSPHERE_PRESETS.map(({ id, name }) => ({ id, name })),
    phases: PHASES.map(({ id, name }) => ({ id, name })),
    // what is shown now (the host's while a multiplayer guest follows it)
    get preset() { return cycle.settings.look; }, get settings() { return cycle.settings; }, get own() { return cycle.own; },
    get night() { return cycle.out.look.night; },
    get wetness() { return Math.round(cycle.out.look.wetness * 50) / 50; },     // vehicle finishes: 2% steps
    get time() { return cycle.time; }, get phase() { return cycle.phase; }, get rain() { return cycle.rain; },
    get raining() { return cycle.raining; }, get following() { return cycle.following; },
    get speed() { return cycle.speed; }, set speed(v) { cycle.speed = v; },
    cycle, setPreset, set,
    jump(to) { if (disposed || !cycle.jump(to)) return false; apply(); changed(); return true; },
    shared: () => cycle.shared(), clock: () => cycle.clock(),
    follow(state) { if (disposed) return; const was = JSON.stringify(cycle.settings); cycle.follow(state); apply(); if (JSON.stringify(cycle.settings) !== was || !state) changed(); },
    unfollow() { if (disposed || !cycle.following) return; cycle.unfollow(); apply(); changed(); },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    update(dt, camera) {
      if (disposed) return;
      cycle.update(dt); apply();
      const at = camera?.position || camera;
      if (!at) return;
      if (stars.visible) stars.position.copy(at);
      for (const [mesh, body] of discs) {
        if (!mesh.visible) continue;
        const d = body === 'sun' ? cycle.out.sun : cycle.out.moon;
        mesh.position.copy(at).add(_v.fromArray(d).multiplyScalar(SKY_DISTANCE)); mesh.lookAt(at);
      }
      rain.update(dt, camera);
    },
    dispose() {
      if (disposed) return; disposed = true; listeners.clear();
      scene.remove(stars, sunHalo, sunDisc, moonDisc); starsGeometry.dispose(); starsMaterial.dispose(); discGeometry.dispose(); haloGeometry.dispose();
      for (const [mesh] of discs) mesh.material.dispose();
      rain.dispose();
    },
  };
  return api;
}
