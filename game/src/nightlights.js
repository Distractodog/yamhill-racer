import * as THREE from 'three';

// Every window and lamp shares this object; changing time never changes a material/program.
export const nightUniform = { value: 0 };
export function nightAttribute(g, value = -1) {
  if (!g.getAttribute('nightStart')) g.setAttribute('nightStart', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count).fill(value), 1));
  return g;
}
export function nightMaterial(material) {
  material.defaultAttributeValues = { ...material.defaultAttributeValues, nightStart: [-1] };
  material.onBeforeCompile = shader => {
    shader.uniforms.townNight = nightUniform;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float nightStart; varying float vNightStart;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNightStart = nightStart;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float townNight; varying float vNightStart;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float glow = step(0.0, vNightStart) * smoothstep(vNightStart, vNightStart + 0.16, townNight);
        totalEmissiveRadiance += vec3(1.35, 0.67, 0.22) * glow;`);
  };
  material.customProgramCacheKey = () => 'town-night-v1';
  return material;
}

// One batched, terrain-conforming radial decal per prop batch. No texture or real light.
const poolMaterial = new THREE.ShaderMaterial({
  uniforms: { townNight: nightUniform }, transparent: true, depthWrite: false,
  blending: THREE.AdditiveBlending,
  vertexShader: `attribute float poolAlpha; varying float vAlpha;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vAlpha = poolAlpha * (1.0 - smoothstep(220.0, 250.0, distance(worldPos.xz, cameraPosition.xz)));
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `uniform float townNight; varying float vAlpha;
    void main() { gl_FragColor = vec4(vec3(0.65, 0.34, 0.10), vAlpha * smoothstep(0.10, 0.75, townNight));
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
export function addLampPools(group, items, ground, radius = 4.5, forward = 0) {
  if (!items.length) return;
  const p = [], a = [], segments = 12, rings = 3;
  const vertex = (x, z, r) => { p.push(x, ground(x, z) + .055, z); a.push(.32 * (1 - r) ** 2); };
  for (const it of items) {
    const x = it.x + Math.sin(it.yaw || 0) * forward, z = it.z + Math.cos(it.yaw || 0) * forward;
    const at = (r, t) => [x + Math.cos(t) * r * radius, z + Math.sin(t) * r * radius, r];
    for (let j = 0; j < rings; j++) for (let i = 0; i < segments; i++) {
      const t = i * Math.PI * 2 / segments, u = (i + 1) * Math.PI * 2 / segments;
      const A = at(j / rings, t), B = at((j + 1) / rings, t), C = at((j + 1) / rings, u), D = at(j / rings, u);
      // Clockwise in x/z faces upward.
      for (const v of [A, C, B, A, D, C]) vertex(...v);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('poolAlpha', new THREE.Float32BufferAttribute(a, 1));
  const mesh = new THREE.Mesh(g, poolMaterial); mesh.name = 'night-lamp-pools'; mesh.renderOrder = 2;
  group.add(mesh);
  return mesh;
}
