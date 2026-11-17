// Puts the Settings → Graphics level (graphics.js) on the game: pixel ratio, sun shadows, fog and camera far, the
// world's drawing distances (world.setDetail), the GPU effect pools (effects.setCaps) and the headlight beam
// (lights.setDetail). Everything changes in
// one go, so turning shadows on / off costs one round of shader compiles, not a stream of them. Auto measures ~5 s of
// play once (or when asked again) and remembers its pick (graphics.js: yr-graphics-2).
import { MIN_CAMERA_FAR, MODES, autoPick, createFpsMeter, graphicsFor, hardwareGuess, loadGraphics, saveGraphics } from './graphics.js';

function browserEnv() {
  const nav = globalThis.navigator || {};
  return {
    dpr: globalThis.devicePixelRatio || 1,
    cores: nav.hardwareConcurrency || 0,
    mobile: nav.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(nav.userAgent || ''),
  };
}
function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }

export function createGraphics({ renderer, scene, camera, sun, storage = browserStorage(), env = browserEnv() }) {
  let state = loadGraphics(storage);
  let world = null, effects = null, lights = null, meter = null, current = null;
  const listeners = new Set();
  const baseFar = camera?.far ?? 2200;
  let fogNear = null, fogFar = null, setFar = null;      // the atmosphere's fog values, and the far this module last set

  const autoLevel = () => state.auto?.level || hardwareGuess(env);
  const level = () => state.mode === 'auto' ? autoLevel() : state.mode;
  const weak = () => state.mode === 'auto' && state.auto?.weak === true;

  function apply() {
    const p = graphicsFor(level(), { dpr: env.dpr, weak: weak() });
    const prev = current; current = p;
    if (renderer && renderer.getPixelRatio?.() !== p.pixelRatio) renderer.setPixelRatio(p.pixelRatio);
    const shadows = p.shadow > 0;
    if (renderer?.shadowMap) renderer.shadowMap.enabled = shadows;
    if (sun) {
      sun.castShadow = shadows;
      if (shadows && sun.shadow && sun.shadow.mapSize.x !== p.shadow) {
        sun.shadow.mapSize.set(p.shadow, p.shadow);
        sun.shadow.map?.dispose(); sun.shadow.map = null;        // made again at the new size on the next shadow pass
      }
    }
    if (camera) { camera.far = Math.max(MIN_CAMERA_FAR, baseFar * p.view); camera.updateProjectionMatrix?.(); }
    if (scene?.fog && fogFar !== null && prev && prev.view !== p.view) { scene.fog.near = fogNear * p.view; scene.fog.far = setFar = fogFar * p.view; }
    world?.setDetail?.(worldDetail(p));
    effects?.setCaps?.(p.effectCaps);
    lights?.setDetail?.(p.headlights);
    listeners.forEach(fn => { try { fn(); } catch (e) { console.warn('graphics:', e); } });
  }
  const worldDetail = (p = current) => ({ load: p.load, terrain: p.terrain, treeNear: p.treeNear, treeFar: p.treeFar, props: p.props,
    scenery: p.scenery, campusItems: p.campusItems, townNear: p.townNear, townFar: p.townFar, campusNear: p.campusNear,
    shadows: p.shadow > 0, water: p.water });

  function set(mode) {
    if (!MODES.includes(mode)) return false;
    state = { ...state, mode };
    meter = mode === 'auto' && !state.auto ? createFpsMeter() : null;
    saveGraphics(storage, state); apply(); return true;
  }
  // Auto again from the start, like a first load: the hardware guess, then ~5 s of play
  function remeasure() {
    state = { mode: 'auto', auto: null }; saveGraphics(storage, state);
    meter = createFpsMeter(); apply();
  }
  if (state.mode === 'auto' && !state.auto) meter = createFpsMeter();

  // every frame after the atmosphere has set the fog: scale it by the view distance; playing = the player is driving
  // (no spawn map, menu, pause or shader warm-up), the only frames Auto measures
  function frame(dt, playing = true) {
    const fog = scene?.fog;
    if (fog) {
      if (fog.far !== setFar) { fogNear = fog.near; fogFar = fog.far; }
      fog.near = fogNear * current.view; fog.far = setFar = fogFar * current.view;
    }
    if (!meter || !playing) return;
    if (!meter.add(dt * 1000)) return;
    const r = meter.result(); meter = null;
    const pick = autoPick({ level: level(), fps: r.fps, cores: env.cores, mobile: env.mobile });
    state = { mode: 'auto', auto: { ...pick, fps: Math.round(r.fps) } };
    saveGraphics(storage, state); apply();
  }

  apply();
  return {
    // world.js loadWorld: the first tiles are loaded with the level's radius
    get worldDetail() { return worldDetail(); },
    attach(parts) { if (parts.world) world = parts.world; if (parts.effects) effects = parts.effects; if (parts.lights) lights = parts.lights; apply(); },
    set, remeasure, frame,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get mode() { return state.mode; },
    get level() { return current.level; },
    get auto() { return state.auto; },
    get measuring() { return !!meter; },
    get measured() { return meter ? meter.seconds : 0; },
    get settings() { return current; },
  };
}
