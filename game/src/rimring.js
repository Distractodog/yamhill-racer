// Optional round-map boundary: one faint additive band, no collision or depth writes.
import * as THREE from 'three';
export function ringFade(distance, fadeDistance = 150) {
  const t = Math.max(0, Math.min(1, Math.abs(distance) / fadeDistance));
  return 1 - t * t * (3 - 2 * t);
}
export function createRimRing({ scene, rim } = {}) {
  if (rim == null) return null;
  const { cx, cz, r } = rim;
  if (![cx, cz, r].every(Number.isFinite) || r <= 0) throw new RangeError('Invalid rim: expected finite cx/cz and positive r');
  // At the full 17.2 km radius this is 2,048 triangles / one draw call; no work when far away.
  const segments = Math.min(1024, Math.max(64, Math.ceil(2 * Math.PI * r / 32)));
  const geometry = new THREE.CylinderGeometry(r, r, 400, segments, 1, true);
  const uniforms = { uPlayer: { value: new THREE.Vector3() }, uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0xc2f3ff) } };
  const material = new THREE.ShaderMaterial({ uniforms, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: true, side: THREE.DoubleSide, fog: false, toneMapped: false,
    vertexShader: `varying vec3 vWorld; varying float vHeight;
      void main() { vec4 p = modelMatrix * vec4(position, 1.0); vWorld = p.xyz; vHeight = uv.y;
        gl_Position = projectionMatrix * viewMatrix * p; }`,
    fragmentShader: `uniform vec3 uPlayer; uniform vec3 uColor; uniform float uOpacity;
      varying vec3 vWorld; varying float vHeight;
      void main() { float along = 1.0 - smoothstep(0.0, 300.0, distance(vWorld.xz, uPlayer.xz));
        float vertical = smoothstep(0.0, 0.15, vHeight) * (1.0 - smoothstep(0.35, 1.0, vHeight));
        gl_FragColor = vec4(uColor, uOpacity * along * vertical);
        #include <colorspace_fragment>
      }`,
  });
  // Transparent DoubleSide normally renders twice; a thin band needs a single pass.
  material.forceSinglePass = true;
  const mesh = new THREE.Mesh(geometry, material); mesh.name = 'map-rim-ring'; mesh.visible = false;
  mesh.position.set(cx, 0, cz); scene?.add(mesh);
  let disposed = false;
  return {
    mesh,
    update(player) {
      if (disposed) return;
      const distance = Math.abs(Math.hypot(player.x - cx, player.z - cz) - r);
      mesh.visible = Number.isFinite(distance) && Number.isFinite(player.y) && distance < 150;
      if (!mesh.visible) { uniforms.uOpacity.value = material.opacity = 0; return; }
      uniforms.uOpacity.value = material.opacity = .16 * ringFade(distance);
      uniforms.uPlayer.value.copy(player);
      // The physics wall also applies to aircraft: keep the band around the player's altitude.
      mesh.position.y = player.y + 80;
    },
    dispose() { if (disposed) return; disposed = true; mesh.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}
