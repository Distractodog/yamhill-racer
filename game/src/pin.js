// Pin guide: once a pin is dropped on the full map (minimap.js), shows
//  - a see-through ribbon on the ground from the car toward the pin (up to RIBBON_LEN m ahead, chevrons flowing to it)
//  - a tall translucent beacon at the pin when it's within BEACON_RANGE
//  - an arrow at the top of the screen that turns to point at the pin relative to the car, plus the distance
// Reaching the pin (within ARRIVE m) shows "You made it" and clears it.
import * as THREE from 'three';
import { PIN_COLOR } from './minimap.js';

const RIBBON_LEN = 150, RIBBON_STEP = 3, RIBBON_W = 2.2, RIBBON_START = 3, RIBBON_LIFT = 0.3;
const BEACON_RANGE = 2500, ARRIVE = 25;

const CSS = `
#pin-hud { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); display: none; align-items: center; gap: 10px;
  padding: 6px 18px 6px 8px; border-radius: 26px; background: #0008; color: #fff; pointer-events: none;
  font: 800 24px/1 system-ui, sans-serif; font-variant-numeric: tabular-nums; text-shadow: 0 1px 3px #000a;
  box-shadow: 0 2px 10px #0005; transition: top .2s; }
#pin-hud.show { display: flex; }
#pin-hud.low { top: 112px; }
#pin-hud svg { width: 38px; height: 38px; display: block; }
#pin-hud .pin-done { font-size: 20px; padding-left: 8px; }
#fullmap.open ~ #pin-hud { display: none !important; }
`;

function chevronTexture() {            // white chevrons pointing along +v, on a soft grey
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#fff'; g.lineWidth = 10; g.lineJoin = 'miter';
  g.beginPath(); g.moveTo(8, 44); g.lineTo(32, 20); g.lineTo(56, 44); g.stroke();   // apex up the canvas = toward +v
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createPinGuide({ scene, world, car, minimap, challenges }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
  const hud = document.createElement('div'); hud.id = 'pin-hud';
  hud.innerHTML = `<svg viewBox="-20 -20 40 40"><g><path d="M0 -15 L11 12 L0 6 L-11 12 Z" fill="${PIN_COLOR}"
    stroke="#fff" stroke-width="3" stroke-linejoin="round"/></g></svg><span class="pin-dist"></span>`;
  document.body.append(hud);
  const arrowG = hud.querySelector('g'), distEl = hud.querySelector('.pin-dist');

  // ---- ribbon: N+1 cross sections, positions rewritten each frame
  const N = Math.round(RIBBON_LEN / RIBBON_STEP);
  const pos = new Float32Array((N + 1) * 2 * 3), col = new Float32Array((N + 1) * 2 * 4), uv = new Float32Array((N + 1) * 2 * 2);
  const idx = [];
  for (let i = 0; i < N; i++) { const a = i * 2, b = a + 2; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(idx);
  const tex = chevronTexture();
  const ribbonMat = new THREE.MeshBasicMaterial({ color: PIN_COLOR, map: tex, vertexColors: true, transparent: true,
    depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const ribbon = new THREE.Mesh(geo, ribbonMat);
  ribbon.frustumCulled = false; ribbon.renderOrder = 5; ribbon.visible = false;
  scene.add(ribbon);

  // ---- beacon at the pin
  const beacon = new THREE.Mesh(new THREE.CylinderGeometry(3, 3, 220, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: PIN_COLOR, transparent: true, opacity: 0.28, depthWrite: false, fog: false,
      side: THREE.DoubleSide }));
  beacon.renderOrder = 4; beacon.visible = false;
  scene.add(beacon);

  let lastY = null, doneT = 0;
  const fw = new THREE.Vector3();
  const fmt = d => d < 1000 ? `${Math.round(d / 10) * 10} m` : d < 10000 ? `${(d / 1000).toFixed(2)} km` : `${(d / 1000).toFixed(1)} km`;

  function update(dt) {
    const pin = minimap.pin, cx = car.renderPos.x, cz = car.renderPos.z;
    if (doneT > 0) {                       // "you made it" message, then hide
      doneT -= dt; if (doneT <= 0) hud.classList.remove('show');
    }
    if (!pin) { ribbon.visible = beacon.visible = false; if (doneT <= 0) hud.classList.remove('show'); return; }
    const dx = pin.x - cx, dz = pin.z - cz, dist = Math.hypot(dx, dz);
    if (dist < ARRIVE) {
      minimap.setPin(null); ribbon.visible = beacon.visible = false;
      distEl.innerHTML = '<span class="pin-done">📍 You made it!</span>'; arrowG.parentNode.style.display = 'none';
      hud.classList.add('show'); doneT = 2.5;
      return;
    }
    // top-of-screen arrow: bearing to the pin relative to where the car points (0 = straight ahead, clockwise)
    fw.set(0, 0, 1).applyQuaternion(car.renderQuat);
    const rel = Math.atan2(dx, -dz) - Math.atan2(fw.x, -fw.z);
    arrowG.setAttribute('transform', `rotate(${(rel * 180 / Math.PI).toFixed(1)})`);
    arrowG.parentNode.style.display = '';
    distEl.textContent = fmt(dist);
    hud.classList.add('show');
    hud.classList.toggle('low', !!challenges && challenges.state !== 'idle');
    doneT = 0;

    // ribbon from just ahead of the car toward the pin, on the ground
    const ux = dx / dist, uz = dz / dist, lx = uz, lz = -ux;
    const len = Math.min(RIBBON_LEN, dist - RIBBON_START), n = Math.max(1, Math.min(N, Math.ceil(len / RIBBON_STEP)));
    ribbon.visible = len > 2;
    if (ribbon.visible) {
      for (let i = 0; i <= N; i++) {
        const s = RIBBON_START + Math.min(i, n) / n * len, x = cx + ux * s, z = cz + uz * s;
        let y = world.loadedAt(x, z) ? world.heightAt(x, z) : (lastY ?? car.renderPos.y);
        if (i === 0) lastY = y;
        y += RIBBON_LIFT;
        const f = Math.min(i, n) / n;                                  // fade in over the first bit, out toward the end
        const a = 0.62 * Math.min(1, f * 8) * (1 - f) ** 1.4;
        for (let k = 0; k < 2; k++) {
          const side = k ? 1 : -1, j = i * 2 + k;
          pos[j * 3] = x + lx * side * RIBBON_W / 2; pos[j * 3 + 1] = y; pos[j * 3 + 2] = z + lz * side * RIBBON_W / 2;
          col[j * 4] = col[j * 4 + 1] = col[j * 4 + 2] = 1; col[j * 4 + 3] = a;
          uv[j * 2] = k; uv[j * 2 + 1] = s / 3;
        }
      }
      geo.attributes.position.needsUpdate = geo.attributes.color.needsUpdate = geo.attributes.uv.needsUpdate = true;
      tex.offset.y -= dt * 2.2;                                         // chevrons flow toward the pin
    }
    // beacon
    beacon.visible = dist < BEACON_RANGE && world.loadedAt(pin.x, pin.z);
    if (beacon.visible) beacon.position.set(pin.x, world.heightAt(pin.x, pin.z) + 110, pin.z);
  }
  return { update };
}
