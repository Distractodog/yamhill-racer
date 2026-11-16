// V picker thumbnails (vehiclepicker.js): every vehicle type drawn once with its real model in the player's paint
// (cosmetics.paintType: their colours, the type's factory colours where they picked none, clean), offscreen in a small
// WebGL canvas of its own, then copied into a 2D canvas that the picker draws from. Opening the picker draws no 3D.
// A picture is drawn again only when that type's paint changes. The work runs one picture per idle period
// (requestIdleCallback) after start(); pictures the open picker shows jump the queue (one per frame).
import * as THREE from 'three';
import { VEHICLE_TYPES, buildVehicleTypeModel } from './vehicletypes.js';

export const THUMB_W = 360, THUMB_H = 225;
const VIEW = new THREE.Vector3(Math.sin(0.8), 0.42, Math.cos(0.8)).normalize();   // front three-quarter, a little above
const FILL = 0.84;                                                                  // model's extent in the picture

export function createVehicleThumbs({ cosmetics, width = THUMB_W, height = THUMB_H }) {
  const cache = new Map();                  // 'kind/id' → { canvas, sig, model }
  const queue = new Set(), urgent = new Set(), listeners = new Set();
  let renderer = null, scene = null, camera = null, failed = false, started = false, idleSet = false, frameSet = false;
  const key = (kind, id) => `${kind}/${id}`;
  const sig = (kind, id) => JSON.stringify(cosmetics.colorsFor(kind, id) || null);
  const stale = k => { const [kind, id] = k.split('/'), c = cache.get(k); return !c || c.sig !== sig(kind, id); };

  function init() {
    if (renderer || failed) return !!renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1); renderer.setSize(width, height, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.setClearColor(0x000000, 0);
      scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(28, width / height, 0.05, 1000);
      // the Garage preview's lights (garage.js)
      scene.add(new THREE.HemisphereLight('#e3f3ff', '#655a47', 2.2));
      const sun = new THREE.DirectionalLight('#fff0db', 2.4); sun.position.set(3, 6, 5); scene.add(sun);
      const rim = new THREE.DirectionalLight('#b2d6ff', 1.6); rim.position.set(-4, 3, -4); scene.add(rim);
    } catch (e) {
      console.warn('vehicle thumbnails unavailable:', e); renderer?.dispose(); renderer = null; failed = true;
    }
    return !!renderer;
  }

  // centre the model and back the camera off until its drawn parts (hidden ones like wreck smoke don't count) fill FILL
  const box = new THREE.Box3(), part = new THREE.Box3(), p = new THREE.Vector3();
  function frame(model) {
    model.position.set(0, 0, 0); model.updateMatrixWorld(true);
    box.makeEmpty();
    model.traverseVisible(o => {
      if (!o.isMesh || !o.geometry) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      box.union(part.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld));
    });
    if (box.isEmpty()) box.setFromObject(model);
    model.position.copy(box.getCenter(p)).negate(); model.updateMatrixWorld(true);
    box.translate(model.position);
    let d = box.getSize(p).length() * 1.5;
    for (let i = 0; i < 4; i++) {
      camera.position.copy(VIEW).multiplyScalar(d); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      let m = 0;
      for (let c = 0; c < 8; c++) {
        p.set(c & 1 ? box.max.x : box.min.x, c & 2 ? box.max.y : box.min.y, c & 4 ? box.max.z : box.min.z).project(camera);
        m = Math.max(m, Math.abs(p.x), Math.abs(p.y));
      }
      d *= m / FILL;
    }
    camera.near = d / 50; camera.far = d * 4; camera.updateProjectionMatrix();
  }

  function draw(k) {
    const [kind, id] = k.split('/');
    let entry = cache.get(k);
    if (!entry) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      entry = { canvas, sig: null, model: null }; cache.set(k, entry);
    }
    entry.sig = sig(kind, id);            // (set first: a type that fails to draw isn't retried every frame)
    if (!init()) return;
    try {
      entry.model ||= buildVehicleTypeModel(kind, id);
      cosmetics.paintType(kind, id, entry.model);
      scene.add(entry.model); frame(entry.model);
      renderer.render(scene, camera);
      const ctx = entry.canvas.getContext('2d');
      ctx.clearRect(0, 0, width, height); ctx.drawImage(renderer.domElement, 0, 0);
      entry.ready = true;
    } catch (e) { console.warn(`thumbnail ${k}:`, e); }
    finally { if (entry.model) scene.remove(entry.model); }
    listeners.forEach(fn => fn(kind, id));
  }

  // next picture to draw: the open picker's first, then the rest
  function next(sets = [urgent, queue]) {
    for (const set of sets) for (const k of set) { set.delete(k); if (stale(k)) return k; }
    return null;
  }
  function pump() {
    if (failed) { urgent.clear(); queue.clear(); return; }
    if (urgent.size && !frameSet) {
      frameSet = true;
      requestAnimationFrame(() => { frameSet = false; const k = next([urgent]); if (k) draw(k); pump(); });
    }
    if (started && queue.size && !idleSet) {
      idleSet = true;
      const run = () => { idleSet = false; const k = next(); if (k) draw(k); pump(); };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 }); else setTimeout(run, 120);
    }
  }
  const all = kinds => kinds.flatMap(kind => VEHICLE_TYPES[kind].map(t => key(kind, t.id)));
  // a repaint redraws that kind's pictures (only those whose paint really changed: stale() compares it)
  cosmetics.subscribe?.(kind => { if (!VEHICLE_TYPES[kind]) return; all([kind]).forEach(k => queue.add(k)); pump(); });

  return {
    // the picture for a type (the last one drawn, even while a repaint waits), or null before its first drawing
    get(kind, id) { const c = cache.get(key(kind, id)); return c?.ready ? c.canvas : null; },
    // begin drawing everything in idle time; `first` = [[kind, id], …] to draw before the others
    start(first = []) {
      if (started) return;
      started = true;
      for (const [kind, id] of first) queue.add(key(kind, id));
      all(Object.keys(VEHICLE_TYPES)).forEach(k => queue.add(k));
      pump();
    },
    // pictures needed on screen now: drawn one per frame ahead of the idle queue
    want(list) { for (const [kind, id] of list) { const k = key(kind, id); if (stale(k)) urgent.add(k); } pump(); },
    onUpdate(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get started() { return started; }, get failed() { return failed; },
    get pending() { return [...new Set([...urgent, ...queue])].filter(stale).length; },
  };
}
