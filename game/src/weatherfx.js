// Nearby rain, one reusable line buffer and one draw call. Cosmetic only.
import * as THREE from 'three';
const WIDTH = 44, HEIGHT = 30, COUNT = 360;
const wrap = (n, span) => ((n % span) + span) % span - span / 2;
export function createRain({ scene, count = COUNT } = {}) {
  const n = Number.isFinite(count) ? Math.max(1, Math.min(COUNT, Math.floor(count))) : COUNT;
  const seeds = new Float32Array(n * 3), positions = new Float32Array(n * 6);
  let seed = 419, time = 0, enabled = false, disposed = false;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) { seeds[i * 3] = random() * WIDTH; seeds[i * 3 + 1] = random() * HEIGHT; seeds[i * 3 + 2] = random() * WIDTH; }
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage); geometry.setAttribute('position', position);
  const material = new THREE.LineBasicMaterial({ color: '#c1d7df', transparent: true, opacity: .35, depthWrite: false, fog: true });
  const mesh = new THREE.LineSegments(geometry, material); mesh.name = 'nearby-rain'; mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 2;
  scene.add(mesh);
  return {
    get active() { return enabled; },
    get count() { return n; },
    setEnabled(value) { if (disposed) return; enabled = !!value; mesh.visible = enabled; },
    update(dt, camera) {
      if (!enabled || disposed || !camera) return;
      const at = camera.position || camera;
      if (!Number.isFinite(at.x) || !Number.isFinite(at.y) || !Number.isFinite(at.z)) return;
      time = (time + (Number.isFinite(dt) ? Math.max(0, Math.min(.1, dt)) : 0)) % 3600;
      mesh.position.copy(at);
      for (let i = 0; i < n; i++) {
        const j = i * 3, k = i * 6;
        // Subtract camera position before wrapping: drops stay in world space as the car moves.
        const x = wrap(seeds[j] + time * 1.8 - at.x, WIDTH), y = wrap(seeds[j + 1] - time * 19 - at.y, HEIGHT) + 5, z = wrap(seeds[j + 2] + time * .6 - at.z, WIDTH);
        positions[k] = x; positions[k + 1] = y; positions[k + 2] = z;
        positions[k + 3] = x - .12; positions[k + 4] = y + 1.25; positions[k + 5] = z - .04;
      }
      position.needsUpdate = true;
    },
    dispose() { if (disposed) return; disposed = true; enabled = false; scene.remove(mesh); geometry.dispose(); material.dispose(); },
  };
}
