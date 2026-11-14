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
  // Keep the original ring tessellation, but submit only the local arc with nonzero shader fade.
  const segments = Math.min(1024, Math.max(64, Math.ceil(2 * Math.PI * r / 32)));
  const geometry = new THREE.CylinderGeometry(r, r, 400, segments, 1, true);
  const sectorAngle = 2 * Math.PI / segments, centerSector = Math.floor(segments / 2);
  // Every point within 300 m lies inside this angular span. One extra sector
  // covers rounding, the chord sagitta and the snapped rotation below.
  const halfAngle = r <= 300 ? Math.PI : Math.asin(300 / r) + sectorAngle;
  const firstSector = Math.max(0, Math.floor(centerSector - halfAngle / sectorAngle));
  const lastSector = Math.min(segments, Math.ceil(centerSector + halfAngle / sectorAngle));
  geometry.setDrawRange(firstSector * 6, (lastSector - firstSector) * 6);
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
        if (along <= 0.0 || vertical <= 0.0 || uOpacity <= 0.0) discard;
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
      // Whole-sector rotations map vertices onto the original world ring exactly,
      // including across +/-pi. A single contiguous draw range never needs to wrap.
      mesh.rotation.y = lastSector - firstSector < segments
        ? (Math.floor(Math.atan2(player.x - cx, player.z - cz) / sectorAngle) - centerSector) * sectorAngle : 0;
      // The physics wall also applies to aircraft: keep the band around the player's altitude.
      mesh.position.y = player.y + 80;
    },
    dispose() { if (disposed) return; disposed = true; mesh.removeFromParent(); geometry.dispose(); material.dispose(); },
  };
}
