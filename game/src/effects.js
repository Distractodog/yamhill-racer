// Tyre marks, tyre smoke, dust, flying gravel / grass, water spray + splash rings, wheel-speed blur discs and contact
// shadows. The ring buffers and the mark ribbon are in fxpool.js; here every vehicle's tyres feed them. Smoke, dust,
// spray and chips are written once when thrown and moved / faded by the GPU from the clock (no per-particle CPU work,
// no per-frame upload but the new ones); each kind is one instanced draw with a fixed shader (nothing recompiles). Fill
// is kept down: octagon sprites, at most ~a third of the screen each, faded and culled close to the camera, fewer puffs
// from far cars. The sprite texture is generated (no image, no document), so remote players' effects also run in Node.
import * as THREE from 'three';
import { PuffRing, ChipRing, MarkStrip, PUFF_A, RING, DROP, STRIDE, CHIP_G, fly, smooth } from './fxpool.js';

export const FX_CAPS = { puffs: 900, chips: 420, marks: 12000, discs: 64 };
const lin = c => (c / 255) ** 2.2, rgb = (r, g, b) => [lin(r), lin(g), lin(b)];
// per surface class (data.js): dust colour, dust thrown just by driving fast, chip colours (+ how flat: grass
// clippings are thin), rut colour (marks while sliding / braking); hard surfaces smoke instead
const SURF = [
  { dust: rgb(184, 176, 140), loose: 0.12, chips: [rgb(70, 118, 38), rgb(98, 140, 52), rgb(122, 150, 70)], flat: 0.15, drag: 2.6, rut: rgb(48, 62, 32), rutA: 0.55, light: 0.5 }, // 0 grass
  { dust: rgb(128, 106, 76), loose: 0.25, chips: [rgb(92, 70, 46), rgb(72, 86, 40), rgb(110, 86, 58)], flat: 0.35, drag: 1.4, rut: rgb(52, 40, 28), rutA: 0.8, light: 0.8 },     // 1 forest floor
  { dust: rgb(196, 152, 104), loose: 0.9, chips: [rgb(122, 90, 60), rgb(150, 114, 80), rgb(98, 72, 50)], flat: 0.7, drag: 0.6, rut: rgb(88, 64, 42), rutA: 0.85, light: 1 },   // 2 dirt trail
  { smoke: rgb(226, 226, 228) },                                                                                                     // 3 asphalt
  { dust: rgb(204, 190, 164), loose: 0.7, chips: [rgb(150, 142, 128), rgb(112, 106, 98), rgb(178, 168, 150)], flat: 0.8, drag: 0.3, rut: rgb(112, 102, 88), rutA: 0.8, light: 1 }, // 4 gravel
  { water: true },                                                                                                                   // 5 water
  { smoke: rgb(230, 230, 230) },                                                                                                     // 6 concrete
  { smoke: rgb(232, 212, 206) },                                                                                                     // 7 running track
];
const RUBBER = rgb(14, 14, 14), SPRAY = rgb(214, 230, 244), FOAM = rgb(236, 243, 248), SOOT = rgb(26, 24, 22), FIRE = rgb(255, 126, 25);
const TAU = Math.PI * 2;
const OFF = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return;';   // outside the view: nothing drawn

// sprite slot: pA x y z birth | pB vx vy vz life | pC size grow rot spin | pD r g b alpha | pE ground drag lift kind
const PUFF_VS = `attribute vec4 pA; attribute vec4 pB; attribute vec4 pC; attribute vec4 pD; attribute vec4 pE;
uniform float uTime; uniform vec3 uLight; uniform vec3 uLamp; uniform vec3 uSpotPos; uniform vec3 uSpotDir; uniform vec4 uSpot;
uniform float uMaxScreen;
varying vec2 vUv; varying vec4 vCol; varying vec3 vSoft;
#include <fog_pars_vertex>
float fly(float k, float g, float v0, float a) { k = max(k, 0.05); return (g / k) * a + (v0 - g / k) * (1.0 - exp(-k * a)) / k; }
void main() {
  float age = uTime - pA.w, life = pB.w, kind = pE.w;
  if (age < 0.0 || age >= life) { ${OFF} }
  float k = pE.y, t = age / life;
  vec3 c0 = pA.xyz + vec3(fly(k, 0.0, pB.x, age), fly(k, pE.z, pB.y, age), fly(k, 0.0, pB.z, age));
  float size = pC.x + pC.y * (age - age * age / (2.0 * life)), alpha;
  bool lying = abs(kind - 2.0) < 0.5, drop = kind > 2.5;          // splash ring: lies on the water
  if (lying) alpha = pD.w * (1.0 - t) * min(1.0, age / 0.06);
  else if (drop) alpha = c0.y < pE.x - 0.02 ? 0.0 : pD.w * min(1.0, (1.0 - t) * 4.0);
  else { alpha = pD.w * min(1.0, age / 0.12) * pow(1.0 - t, 1.6); c0.y = max(c0.y, pE.x + size * 0.2); }
  vec4 mvC = viewMatrix * vec4(c0, 1.0);
  float dist = -mvC.z;
  if (alpha < 0.003 || (!lying && dist < 0.8)) { ${OFF} }
  float rot = pC.z + pC.w * age;
  vec2 q = mat2(cos(rot), sin(rot), -sin(rot), cos(rot)) * position.xy;
  vec4 mvPosition; vec3 wp;
  if (lying) { wp = c0 + vec3(q.x, 0.0, q.y) * size; mvPosition = viewMatrix * vec4(wp, 1.0); }
  else {
    size = min(size, uMaxScreen * dist / projectionMatrix[1][1]);        // never more than ~a third of the screen
    mvPosition = mvC + vec4(q * size, 0.0, 0.0);
    wp = c0 + (vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * q.x + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * q.y) * size;
  }
  gl_Position = projectionMatrix * mvPosition;
  vUv = (position.xy + 0.5) * 0.5 + vec2(mod(kind, 2.0), floor(kind * 0.5)) * 0.5;
  float shade = kind < 1.5 ? mix(0.8, 1.06, q.y + 0.5) : 1.0;          // a cloud is lighter on top
  vec3 d = c0 - uSpotPos; float dl = max(length(d), 0.001);              // in the headlights' cone
  float lamp = uSpot.w * smoothstep(uSpot.x, uSpot.y, dot(d, uSpotDir) / dl) * pow(max(0.0, 1.0 - dl / uSpot.z), 2.0);
  vCol = vec4(pD.rgb * (uLight + uLamp * min(lamp, 1.5)) * shade, alpha);
  // soft where it meets the ground (no hard line) and fading close to the camera
  vSoft = vec3(wp.y - pE.x, lying ? 0.0 : 0.3 * size + 0.05, lying ? 1.0 : smoothstep(0.8, 4.0, dist));
  #include <fog_vertex>
}`;
const PUFF_FS = `uniform sampler2D uTex;
varying vec2 vUv; varying vec4 vCol; varying vec3 vSoft;
#include <fog_pars_fragment>
void main() {
  vec4 tx = texture2D(uTex, vUv);
  float a = tx.a * vCol.a * vSoft.z;
  if (vSoft.y > 0.0) a *= clamp(vSoft.x / vSoft.y, 0.0, 1.0);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb * tx.rgb, a);                 // the texture's light / dark lumps: a billowing cloud
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
// chip slot: cA x y z birth | cB vx vy vz life | cC size flat ax ay | cD wx wy tLand drag | cE r g b ground
const CHIP_VS = `attribute vec4 cA; attribute vec4 cB; attribute vec4 cC; attribute vec4 cD; attribute vec4 cE;
uniform float uTime; uniform vec3 uLight; uniform vec3 uSunDir;
varying vec3 vC;
#include <fog_pars_vertex>
float fly(float k, float g, float v0, float a) { k = max(k, 0.05); return (g / k) * a + (v0 - g / k) * (1.0 - exp(-k * a)) / k; }
void main() {
  float age = uTime - cA.w, life = cB.w;
  if (age < 0.0 || age >= life) { ${OFF} }
  float a = min(age, cD.z), k = cD.w, s = cC.x * min(1.0, (life - age) / 0.3), fl = cC.y;
  vec3 c = cA.xyz + vec3(fly(k, 0.0, cB.x, a), fly(k, -${CHIP_G.toFixed(1)}, cB.y, a), fly(k, 0.0, cB.z, a));
  c.y = max(c.y, cE.w) + s * fl;
  float rx = cC.z + cD.x * a, ry = cC.w + cD.y * a;
  mat3 R = mat3(cos(ry), 0.0, -sin(ry), 0.0, 1.0, 0.0, sin(ry), 0.0, cos(ry)) * mat3(1.0, 0.0, 0.0, 0.0, cos(rx), sin(rx), 0.0, -sin(rx), cos(rx));
  vec3 n = normalize(R * (normal * vec3(1.0, 1.0 / max(fl, 0.05), 1.0)));
  vec4 mvPosition = viewMatrix * vec4(c + R * (position * vec3(s, s * fl, s)), 1.0);
  gl_Position = projectionMatrix * mvPosition;
  vC = cE.rgb * uLight * (0.5 + 0.6 * max(dot(n, uSunDir), 0.0));
  #include <fog_vertex>
}`;
const CHIP_FS = `varying vec3 vC;
#include <fog_pars_fragment>
void main() {
  gl_FragColor = vec4(vC, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
const MARK_VS = `attribute vec3 mcol; attribute vec4 info; varying vec3 vC; varying vec4 vI;
#include <fog_pars_vertex>
void main() {
  vC = mcol; vI = info;
  vec4 mvPosition = viewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const MARK_FS = `uniform float uTime; uniform vec3 uLight; varying vec3 vC; varying vec4 vI;
#include <fog_pars_fragment>
void main() {
  float x = vI.y, fade = 1.0 - smoothstep(45.0, 150.0, uTime - vI.z);          // laid vI.z s ago: fades slowly
  float a = vI.x * fade * smoothstep(0.0, 0.2, x) * smoothstep(1.0, 0.8, x);    // soft edges
  if (vI.w > 0.5) a *= 0.7 + 0.6 * abs(x - 0.5);                                // a rut: pressed-in sides
  if (a < 0.004) discard;
  gl_FragColor = vec4(vC * uLight, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
const DISC_VS = `attribute float aAlpha; attribute vec3 aColor; varying vec2 vUv; varying float vA; varying vec3 vColor;
#include <fog_pars_vertex>
void main() {
  vUv = uv; vA = aAlpha; vColor = aColor;
  vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const DISC_FS = `uniform vec3 uLight; varying vec2 vUv; varying float vA; varying vec3 vColor;
#include <fog_pars_fragment>
void main() {
  float r = length(vUv - 0.5) * 2.0;                       // a spinning rim seen as a blur: hub, smeared spokes, lip
  float shade = mix(0.35, 1.0, smoothstep(0.2, 0.36, r)) * (0.9 + 0.1 * sin(r * 46.0));
  vec3 c = vColor * mix(shade, 0.2, smoothstep(0.8, 0.9, r));
  float a = vA * (1.0 - smoothstep(0.92, 1.0, r));
  if (a < 0.004) discard;
  gl_FragColor = vec4(c * uLight, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

// 2×2 sprite cells, 128 px each: two lumpy smoke puffs, a splash ring, a water drop (shape in alpha, lumps in grey)
function spriteTexture() {
  const N = 128, S = N * 2, data = new Uint8Array(S * S * 4);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const grid = n => { const g = new Float32Array((n + 1) * (n + 1)); for (let i = 0; i < g.length; i++) g[i] = rnd(); return { g, n }; };
  const noise = ({ g, n }, u, v) => {
    const x = u * n, y = v * n, i = Math.min(n - 1, x | 0), j = Math.min(n - 1, y | 0), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), a = g[j * (n + 1) + i], b = g[j * (n + 1) + i + 1];
    const c = g[(j + 1) * (n + 1) + i], d = g[(j + 1) * (n + 1) + i + 1];
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
  };
  for (let cell = 0; cell < 4; cell++) {
    const oct = [grid(3), grid(6), grid(12)], cx = (cell % 2) * N, cy = (cell >> 1) * N;
    for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
      const u = (px + 0.5) / N, v = (py + 0.5) / N, dx = u * 2 - 1, dy = v * 2 - 1, r = Math.hypot(dx, dy);
      let a = 0, l = 1;
      if (cell < 2) {
        const f = 0.5 * noise(oct[0], u, v) + 0.32 * noise(oct[1], u, v) + 0.18 * noise(oct[2], u, v);
        const t = Math.max(0, 1 - r / (0.6 + 0.34 * f));
        a = Math.min(1, t * t * (3 - 2 * t) * (0.6 + 0.6 * f)); l = 0.82 + 0.2 * f;
      } else if (cell === 2) a = Math.min(1, Math.exp(-(((r - 0.74) / 0.08) ** 2)) + 0.3 * Math.exp(-(((r - 0.5) / 0.14) ** 2)));
      else a = Math.max(0, 1 - r * r) ** 2;
      a *= smooth(0.98, 0.86, r);
      const o = ((cy + py) * S + cx + px) * 4;
      data[o] = data[o + 1] = data[o + 2] = Math.round(255 * Math.min(1, l)); data[o + 3] = Math.round(255 * a);
    }
  }
  const tex = new THREE.DataTexture(data, S, S);
  Object.assign(tex, { magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, needsUpdate: true });
  return tex;
}

// a wheel's half width (tyre + rim, from its spinning parts) and the mark it leaves; cached per model wheel
const WHEELS = new WeakMap(), _box = new THREE.Box3(), _inv = new THREE.Matrix4(), _rel = new THREE.Matrix4();
function wheelInfo(g) {
  let w = g && WHEELS.get(g);
  if (w) return w;
  let hw = 0;
  if (g?.spin && g.holder) {
    g.holder.updateWorldMatrix(true, true); _inv.copy(g.holder.matrixWorld).invert();
    g.spin.traverse(o => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      _box.copy(o.geometry.boundingBox).applyMatrix4(_rel.multiplyMatrices(_inv, o.matrixWorld));
      hw = Math.max(hw, Math.abs(_box.min.x), Math.abs(_box.max.x));
    });
  }
  hw = Math.min(0.4, Math.max(0.05, hw || 0.14));
  w = { hw, mark: Math.min(0.26, Math.max(0.07, hw * 0.85)) };
  if (g) WHEELS.set(g, w);
  return w;
}
const tyre = () => ({ trail: MarkStrip.trail(), skidT: 0, a: 0, smoke: 0, dust: 0, chip: 0, spray: 0, spin: NaN, w: 0, xrate: 0,
  blur: 0, extra: 0, air: 0, chirp: 0 });
// one instanced buffer of `ring` slots (STRIDE floats) seen as 5 vec4 attributes
function ringAttributes(geo, ring, names) {
  const buf = new THREE.InstancedInterleavedBuffer(ring.data, STRIDE, 1).setUsage(THREE.DynamicDrawUsage);
  names.forEach((n, k) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, k * 4)));
  geo.instanceCount = 0;
  return buf;
}

const _f = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3(), _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const UNPAINTED_RIM = new THREE.Color('#8a9099');

export class Effects {
  // shadows: false = no contact shadows (mp/remotes.js: other players' vehicles, which also need no document)
  constructor(scene, { shadows = true, caps = FX_CAPS } = {}) {
    this.maxCaps = { ...caps }; this.caps = { ...caps };
    this.scene = scene; this.time = 0; this.cam = new THREE.Vector3(); this.camSeen = false;
    Object.assign(this, Effects.vehicleState());
    const fog = () => THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
    const uLight = this.uLight = { value: new THREE.Vector3(1, 1, 1) }, uTime = this.uTime = { value: 0 };
    this.uLamp = { value: new THREE.Vector3(1, 0.96, 0.9) }; this.uSunDir = { value: new THREE.Vector3(0, 1, 0) };
    this.uSpotPos = { value: new THREE.Vector3() }; this.uSpotDir = { value: new THREE.Vector3(0, 0, 1) };
    this.uSpot = { value: new THREE.Vector4(0.5, 0.9, 60, 0) };        // cos outer, cos inner, range, strength (0 = no lamp)
    const seeCamera = (r, s, camera) => { this.cam.setFromMatrixPosition(camera.matrixWorld); this.camSeen = true; };

    // ---------------- tyre marks: one ring buffer of quads, uploaded only where it changed
    const M = this.marksBuf = new MarkStrip(caps.marks), mg = new THREE.BufferGeometry();
    const idx = new (caps.marks * 4 > 65535 ? Uint32Array : Uint16Array)(caps.marks * 6);
    for (let s = 0; s < caps.marks; s++) idx.set([s * 4, s * 4 + 1, s * 4 + 2, s * 4 + 1, s * 4 + 3, s * 4 + 2], s * 6);
    mg.setIndex(new THREE.BufferAttribute(idx, 1));
    mg.setAttribute('position', new THREE.BufferAttribute(M.pos, 3).setUsage(THREE.DynamicDrawUsage));
    mg.setAttribute('mcol', new THREE.BufferAttribute(M.col, 3).setUsage(THREE.DynamicDrawUsage));
    mg.setAttribute('info', new THREE.BufferAttribute(M.info, 4).setUsage(THREE.DynamicDrawUsage));
    mg.setDrawRange(0, 0);
    this.marks = new THREE.Mesh(mg, new THREE.ShaderMaterial({
      uniforms: { ...fog(), uTime, uLight }, vertexShader: MARK_VS, fragmentShader: MARK_FS, fog: true,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    this.marks.frustumCulled = false; this.marks.renderOrder = 1; this.marks.onBeforeRender = seeCamera;
    scene.add(this.marks);

    // ---------------- smoke, dust, spray, rings: soft octagon sprites facing the camera (rings lie flat)
    this.puffs = new PuffRing(caps.puffs);
    const oct = new THREE.CircleGeometry(0.5 / Math.cos(Math.PI / 8), 8, Math.PI / 8);   // its flats touch the cell edges
    const pg = this.puffGeo = new THREE.InstancedBufferGeometry();
    pg.setIndex(oct.index); pg.setAttribute('position', oct.attributes.position); oct.dispose();
    this.puffBuf = ringAttributes(pg, this.puffs, ['pA', 'pB', 'pC', 'pD', 'pE']);
    this.tex = spriteTexture();
    this.points = new THREE.Mesh(pg, new THREE.ShaderMaterial({
      uniforms: { ...fog(), uTex: { value: this.tex }, uTime, uLight, uLamp: this.uLamp, uSpotPos: this.uSpotPos, uSpotDir: this.uSpotDir,
        uSpot: this.uSpot, uMaxScreen: { value: 0.6 } },
      vertexShader: PUFF_VS, fragmentShader: PUFF_FS, fog: true, transparent: true, depthWrite: false }));
    this.points.frustumCulled = false; this.points.renderOrder = 3; this.points.visible = false; this.points.onBeforeRender = seeCamera;
    scene.add(this.points);

    // ---------------- gravel, clods and grass clippings: tiny lit, tumbling chips (flat faces)
    this.chips = new ChipRing(caps.chips);
    const ico = new THREE.IcosahedronGeometry(1, 0), cg = this.chipGeo = new THREE.InstancedBufferGeometry();
    cg.setAttribute('position', ico.attributes.position); cg.setAttribute('normal', ico.attributes.normal); ico.dispose();
    this.chipBuf = ringAttributes(cg, this.chips, ['cA', 'cB', 'cC', 'cD', 'cE']);
    this.chipMesh = new THREE.Mesh(cg, new THREE.ShaderMaterial({
      uniforms: { ...fog(), uTime, uLight, uSunDir: this.uSunDir }, vertexShader: CHIP_VS, fragmentShader: CHIP_FS, fog: true }));
    this.chipMesh.frustumCulled = false; this.chipMesh.visible = false;
    scene.add(this.chipMesh);

    // ---------------- wheel blur: a soft disc over each side of a fast-turning wheel (hides the spokes)
    const dg = new THREE.CircleGeometry(1, 20).rotateY(Math.PI / 2);
    this.discA = new THREE.InstancedBufferAttribute(new Float32Array(caps.discs), 1).setUsage(THREE.DynamicDrawUsage);
    this.discColor = new THREE.InstancedBufferAttribute(new Float32Array(caps.discs * 3), 3).setUsage(THREE.DynamicDrawUsage);
    dg.setAttribute('aAlpha', this.discA);
    dg.setAttribute('aColor', this.discColor);
    this.discs = new THREE.InstancedMesh(dg, new THREE.ShaderMaterial({
      uniforms: { ...fog(), uLight }, vertexShader: DISC_VS, fragmentShader: DISC_FS, fog: true, transparent: true,
      depthWrite: false, side: THREE.DoubleSide }), caps.discs);
    this.discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.discs.count = 0; this.discs.frustumCulled = false; this.discs.visible = false; this.discN = 0; this.discCap = caps.discs;
    scene.add(this.discs);

    this.objects = [this.marks, this.points, this.chipMesh, this.discs];   // what the effects draw (benchmarks hide them)
    this.O = {}; this.C = {};                                  // scratch spawn records
    this.lookT = 0; this.hemi = this.sun = null; this.spots = [];
    if (!shadows) return;

    // ---------------- contact shadows: soft dark blobs on the ground under each tyre and the car
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d'), grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.6)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
    const blobTex = new THREE.CanvasTexture(c);
    const mk = (w, l, op) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: op,
          polygonOffset: true, polygonOffsetFactor: -6 }));
      m.userData.op = op; m.renderOrder = 2; scene.add(m); return m;
    };
    this.tyreBlobs = [0, 1, 2, 3].map(i => mk(i < 2 ? 0.7 : 0.85, 1.0, 0.75));
    this.bodyBlob = mk(2.4, 4.9, 0.5);
  }

  // Settings → Graphics: reuse the allocated buffers and shaders; smaller rings overwrite sooner.
  // Clear on a change so expanding the limits cannot bring old particles or marks back.
  setCaps(caps = this.maxCaps) {
    const next = {};
    for (const k of Object.keys(this.maxCaps)) next[k] = Number.isFinite(caps[k])
      ? Math.max(1, Math.min(this.maxCaps[k], Math.floor(caps[k]))) : this.maxCaps[k];
    if (Object.keys(next).every(k => next[k] === this.caps[k])) return;
    this.caps = next;
    for (const [R, geo, mesh, cap] of [[this.puffs, this.puffGeo, this.points, next.puffs],
      [this.chips, this.chipGeo, this.chipMesh, next.chips]]) {
      R.clear(); R.data.fill(0); R.cap = cap; R.cursor = R.total = R.fresh = R.first = 0;
      geo.instanceCount = 0; mesh.visible = false;
    }
    const M = this.marksBuf;
    M.max = next.marks; M.i = M.total = 0; M.changed.length = 0;
    this.marks.geometry.setDrawRange(0, 0);
    this.tyres = [];  // fresh trails: never join the old ribbon after its ring was cleared
    this.discCap = next.discs; this.discN = this.discs.count = 0; this.discs.visible = false;
  }

  placeBlob(m, x, z, yaw, above, world, y) {
    const h = world.heightAt(x, z, y);
    m.position.set(x, h + 0.03, z);
    const n = world.normalAt(x, z, this._n ||= new THREE.Vector3(), y);   // roof-aware worlds need an out vector
    m.quaternion.setFromUnitVectors(UP, n);
    m.rotateY(yaw);
    m.material.opacity = m.userData.op * Math.max(0, 1 - above / 2.5);
    m.visible = m.material.opacity > 0.01;
  }

  update(dt, car) { this.drive(dt, car); this.advance(dt); }
  // one vehicle's own share of the state, so several can take turns through drive (mp/remotes.js swaps it in)
  static vehicleState() { return { tyres: [], brakeT: 0, launchT: 0, wasWet: false, ringT: 0, wreck: 0, kind: null, model: null }; }

  // what one vehicle adds this frame (mp/remotes.js runs other players' vehicles through it too, then advance once)
  drive(dt, car) {
    dt = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    const fwd = _f.set(0, 0, 1).applyQuaternion(car.renderQuat), yaw = Math.atan2(fwd.x, fwd.z);
    const W = car.world, mw = car.mesh.userData.wheels || [];
    if (this.bodyBlob) {
      mw.forEach((g, i) => {
        const p = _v; g.holder.getWorldPosition(p);
        this.placeBlob(this.tyreBlobs[i], p.x, p.z, yaw + (g.front ? g.holder.rotation.y : 0), p.y - g.r - W.heightAt(p.x, p.z, p.y), W, p.y);
      });
      for (let i = mw.length; i < this.tyreBlobs.length; i++) this.tyreBlobs[i].visible = false;   // bike: 2 tyres, jet: 3
    }
    if (car.kind !== this.kind || car.mesh !== this.model) {   // vehicle or its type (Garage) switched: blob size + fresh tyre marks
      this.kind = car.kind; this.model = car.mesh; const [bw, bl] = car.mesh.userData.blob || [2.4, 4.9];
      this.bodyBlob?.scale.set(bw / 2.4, 1, bl / 4.9); this.tyres = [];
    }
    const rp = car.renderPos;
    if (this.bodyBlob) this.placeBlob(this.bodyBlob, rp.x, rp.z, yaw, rp.y - (car.kind === 'jet' ? 1.6 : 0.55) - W.heightAt(rp.x, rp.z, rp.y), W, rp.y);
    const T = this.tyres, wheels = car.wheels || [];
    for (let i = 0; i < wheels.length; i++) T[i] ||= tyre();
    this.blur(dt, car, mw);
    if (!dt) return;
    // far from the camera: fewer puffs (none past ~260 m), the marks stay
    const far = (this.camSeen ? smooth(260, 110, rp.distanceTo(this.cam)) : 1) * this.caps.puffs / this.maxCaps.puffs;
    if (car.combatWreck || car.burning && car.mode === 'crashed') { // Shared wreck smoke; ground combat adds flames.
      for (this.wreck += dt * 30 * far; this.wreck >= 1; this.wreck--) {
        this.puff(car.pos, car.vel, SOOT, 1.8, 0.6, 0.15, 2.4, 3, 4, car.pos.y - 1.5);
        if (car.combatWreck) this.puff(car.pos, car.vel, FIRE, .6, .3, .1, .4, .8, 2, car.pos.y - .5);
      }
    }

    const sp = car.vel.length(), inp = car.input || {}, P = this.puffs;
    const fq = _f.set(0, 0, 1).applyQuaternion(car.quat), fwdSpeed = car.vel.dot(fq);
    const side = _s.set(1, 0, 0).applyQuaternion(car.quat), wheeled = car.kind === 'car' || car.kind === 'bike';
    // Marks and smoke only when a tyre is really losing grip, after it has slid for a moment: drifts / big slides and
    // the handbrake (rear), the first moments of a hard stop from speed (all), a hard launch and burnouts (rear: gas
    // with the brake or handbrake held at a standstill), corners right at the grip limit (rear), touching down fast.
    const slip = car.slip || 0, sliding = car.drifting || (slip > 0.22 && sp > 10);
    const slide = sliding ? Math.min(1, car.drifting ? 0.45 + slip * 1.2 : (slip - 0.15) * 3) : 0;
    const braking = inp.brake > 0 && fwdSpeed > 16;
    this.brakeT = braking ? this.brakeT + dt : 0;
    const launching = inp.throttle > 0 && fwdSpeed > 0.5 && fwdSpeed < 9 && car.lonAcc > 10;
    this.launchT = launching ? this.launchT + dt : (fwdSpeed < 0.5 ? 0 : this.launchT);
    const burnout = wheeled && inp.throttle > 0.5 && (inp.brake > 0.3 || !!inp.handbrake) && Math.abs(fwdSpeed) < 7;
    const limitCorner = Math.abs(car.latAcc) > 26 && sp > 15;
    const press = far * (1 - 0.85 * smooth(0.55, 1, P.n / P.cap));   // a nearly full ring: fewer new puffs
    const maxLen = Math.max(3, sp * dt * 2.5 + 1), wet = car.onWater || car.waterDepth > 0;
    wheels.forEach((wh, i) => {
      const t = T[i], g = mw[i], rear = !wh.front, S = SURF[wh.surf] || SURF[3], cp = wh.contactPoint;
      const hardStop = braking && this.brakeT < 0.7;
      const landed = wh.contact && t.air > 0.3 && sp > 12;    // touching down fast after a jump: a short chirp
      t.air = wh.contact ? 0 : t.air + dt;
      t.chirp = landed ? 0.22 : Math.max(0, t.chirp - dt);
      let scrub = 0;                                            // how hard this tyre scrubs: mark darkness, smoke
      if (rear && sliding) scrub = 0.5 + 0.4 * slide;
      if (inp.handbrake && rear && sp > 4) scrub = Math.max(scrub, 0.85);
      if (hardStop) scrub = Math.max(scrub, 0.55 + 0.4 * Math.min(1, inp.brake));   // harder braking, darker marks
      if (launching && rear && this.launchT < 0.6) scrub = Math.max(scrub, 0.75);
      if (rear && limitCorner) scrub = Math.max(scrub, 0.4);
      if (t.chirp > 0) scrub = Math.max(scrub, 0.7);
      if (rear && burnout) scrub = 1;
      t.xrate = rear && burnout ? 45 : 0;
      if (t.xrate) t.extra = (t.extra + t.xrate * dt) % TAU;   // burnout: the driven wheel spins on the spot
      t.skidT = scrub > 0 && wh.contact && !S.water ? t.skidT + dt : 0;

      // the mark: rubber on hard ground, a rut on loose ground (lighter on grass); only while it slides or brakes
      const loose = !!S.rut, target = t.skidT > 0.06 ? scrub * (loose ? S.rutA : 1) : 0;
      t.a += (target - t.a) * Math.min(1, dt * (target > t.a ? 10 : 6));
      if (wh.contact && !S.water && (target > 0 || t.a > 0.03)) {
        const c = loose ? S.rut : RUBBER, w = wheelInfo(g).mark * (1 + (rear ? 0.4 * slide : 0));
        this.marksBuf.add(t.trail, cp.x, cp.y + 0.04, cp.z, w, Math.min(1, t.a), c[0], c[1], c[2], this.time, loose ? 1 : 0, 0.35, maxLen);
      } else t.trail.has = false;
      if (!wh.contact) return;

      if (S.water) {                                          // skimming: spray arcs off every tyre, a fine mist
        const f = Math.min(1, sp / 25) * press, out = Math.sign(_v.subVectors(cp, car.renderPos).dot(side));
        for (t.spray += f * 40 * dt; t.spray >= 1; t.spray--) this.drop(cp, car.vel, side, out || (Math.random() < 0.5 ? -1 : 1), 1.4 + sp * 0.1, 2 + sp * 0.12, cp.y);
        if (Math.random() < f * 6 * dt) this.puff(cp, car.vel, FOAM, 1, 0.24, 0.4, 1.2, 1, 0.6, cp.y);
        return;
      }
      const amt = Math.max(scrub * (t.skidT > 0.03 ? 1 : 0), !rear && sliding ? 0.25 * slide : 0);
      const burn = rear && burnout;
      if (S.smoke) {                                          // tyre smoke: white-grey puffs that billow and hang
        if (amt > 0) for (t.smoke += amt * (burn ? 48 : 24) * press * dt; t.smoke >= 1; t.smoke--) this.smoke(cp, car, fq, amt, S.smoke, burn, dt);
      } else {                                                // loose ground: dust clouds + flying chips
        const trail = S.loose * Math.min(1, sp / 40) * (rear ? 1 : 0.4);
        for (t.dust += (amt * 20 + trail * 7) * press * dt; t.dust >= 1; t.dust--) this.dust(cp, car, S, Math.max(amt, trail * 0.7), dt);
        const chips = (sp > 5 || burn) ? (amt * 40 + (S.flat < 0.3 ? 8 : 12) * Math.min(1, sp / 30) * (rear ? 1 : 0.5)) * far : 0;
        for (t.chip += chips * dt; t.chip >= 1; t.chip--) this.chip(cp, car, fq, fwdSpeed, S, burn);
      }
    });
    // water: a big burst and rings when you hit it, then a bow wave and ripples while ploughing through
    const lvl = W?.waterLevelAt?.(car.pos.x, car.pos.z), wy = Number.isFinite(lvl) && lvl > car.pos.y - 3 ? lvl : car.pos.y - 0.3;
    if (wet && !this.wasWet && sp > 4) {
      const k = Math.min(1.4, sp / 25);
      for (let n = 0; n < Math.min(50, 10 + sp) * far; n++) this.drop(car.pos, car.vel, side, Math.random() < 0.5 ? -1 : 1, 3 + 5 * k * Math.random(), 3 + 6 * k * Math.random(), wy, 1.2);
      for (let n = 0; n < 3; n++) this.ring(car.pos.x, wy, car.pos.z, 1 + n, 4 + n * 2.5 + sp * 0.1, 1.2 + n * 0.3, 0.6);
    }
    if (car.waterDepth > 0 && sp > 1.5) {
      if (Math.random() < dt * 30 * far) this.drop(car.pos, car.vel, side, Math.random() < 0.5 ? -1 : 1, 1 + sp * 0.08, 1.5 + sp * 0.1, wy, 1.2);
      if ((this.ringT -= dt) <= 0) { this.ring(car.pos.x, wy, car.pos.z, 1.8, 2.5 + sp * 0.25, 1.5, 0.45); this.ringT = 0.3; }
    }
    this.wasWet = wet;
  }

  // ---------------- emitters (positions spread along this frame's travel so fast trails are even, not clumped)
  puff(p, vel, col, size, alpha, wake, life, grow, lift, ground) {
    const O = this.O, r = Math.random;
    O.x = p.x + (r() - 0.5) * 0.8; O.y = p.y + 0.2; O.z = p.z + (r() - 0.5) * 0.8; O.ground = ground; O.birth = undefined;
    O.vx = vel.x * wake + (r() - 0.5) * 2; O.vy = lift * (0.5 + r()); O.vz = vel.z * wake + (r() - 0.5) * 2;
    O.size = size * (0.8 + r() * 0.4); O.grow = grow * (0.7 + r() * 0.6); O.life = life * (0.7 + r() * 0.6); O.alpha = alpha;
    O.r = col[0]; O.g = col[1]; O.b = col[2]; O.rot = r() * TAU; O.spin = (r() - 0.5) * 0.6; O.drag = 1.2; O.lift = 0.2; O.kind = r() < 0.5 ? PUFF_A : PUFF_A + 1;
    this.puffs.spawn(O, this.time);
  }
  smoke(cp, car, fwd, amt, col, burn, dt) {
    const O = this.O, r = Math.random, v = car.vel, back = r() * dt, a = r() * TAU, rr = r() * 0.3, wake = 0.3 + r() * 0.25;
    O.x = cp.x - v.x * back + Math.cos(a) * rr; O.y = cp.y + 0.22 + r() * 0.15; O.z = cp.z - v.z * back + Math.sin(a) * rr; O.ground = cp.y; O.birth = undefined;
    O.vx = v.x * wake + (r() - 0.5) * 2.2; O.vy = 0.3 + r() * 0.9; O.vz = v.z * wake + (r() - 0.5) * 2.2;
    if (burn) { const k = 2 + r() * 3; O.x -= fwd.x * 0.4; O.z -= fwd.z * 0.4; O.vx -= fwd.x * k; O.vz -= fwd.z * k; O.vy += 0.4; }
    O.size = (0.55 + 0.5 * amt) * (0.8 + r() * 0.4); O.grow = (1.1 + 1.1 * amt) * (0.7 + r() * 0.6);
    O.life = 1.5 + r() * 1.5 * (0.5 + 0.5 * amt); O.alpha = 0.28 + 0.36 * amt;
    const s = 0.93 + r() * 0.09; O.r = col[0] * s; O.g = col[1] * s; O.b = col[2] * s;
    O.rot = r() * TAU; O.spin = (r() - 0.5) * 0.8; O.drag = 1.5 + r() * 0.6; O.lift = 0.3 + r() * 0.3; O.kind = r() < 0.5 ? PUFF_A : PUFF_A + 1;
    this.puffs.spawn(O, this.time);
  }
  dust(cp, car, S, amt, dt) {
    const O = this.O, r = Math.random, v = car.vel, back = r() * dt, wake = 0.2 + r() * 0.25;
    O.x = cp.x - v.x * back + (r() - 0.5) * 0.6; O.y = cp.y + 0.3 + r() * 0.2; O.z = cp.z - v.z * back + (r() - 0.5) * 0.6; O.ground = cp.y; O.birth = undefined;
    O.vx = v.x * wake + (r() - 0.5) * 2.6; O.vy = 0.4 + r() * 1.1; O.vz = v.z * wake + (r() - 0.5) * 2.6;
    O.size = (0.8 + 0.7 * amt) * (0.8 + r() * 0.5); O.grow = (1.4 + 1.2 * amt) * (0.7 + r() * 0.6);
    O.life = 2 + r() * 1.5; O.alpha = (0.22 + 0.32 * amt) * S.light;
    const s = 0.88 + r() * 0.2; O.r = S.dust[0] * s; O.g = S.dust[1] * s; O.b = S.dust[2] * s;
    O.rot = r() * TAU; O.spin = (r() - 0.5) * 0.6; O.drag = 1.1 + r() * 0.5; O.lift = 0.08 + r() * 0.12; O.kind = r() < 0.5 ? PUFF_A : PUFF_A + 1;
    this.puffs.spawn(O, this.time);
  }
  chip(cp, car, fwd, fwdSpeed, S, burn) {
    const O = this.C, r = Math.random, v = car.vel, col = S.chips[(r() * S.chips.length) | 0], grass = S.flat < 0.3;
    const back = (fwdSpeed >= 0 ? -1 : 1) * (burn ? 5 + r() * 5 : 2 + r() * 4), up = grass ? 1.5 + r() * 2.5 : 2 + r() * 4.5;
    O.x = cp.x + (r() - 0.5) * 0.3; O.y = cp.y + 0.06; O.z = cp.z + (r() - 0.5) * 0.3; O.ground = cp.y;
    O.vx = v.x * 0.35 + fwd.x * back + (r() - 0.5) * 3.5; O.vy = up; O.vz = v.z * 0.35 + fwd.z * back + (r() - 0.5) * 3.5;
    O.size = (grass ? 0.05 : 0.025) + r() * 0.04; O.flat = S.flat * (0.7 + r() * 0.5); O.life = 0.8 + r() * 0.7;
    O.ax = r() * TAU; O.ay = r() * TAU; O.wx = (r() - 0.5) * 30; O.wy = (r() - 0.5) * 30; O.drag = S.drag;
    const s = 0.85 + r() * 0.3; O.r = col[0] * s; O.g = col[1] * s; O.b = col[2] * s;
    this.chips.spawn(O, this.time);
  }
  // a water drop thrown up and out (side * out), falling back; some leave a little ring where they land (born then)
  drop(p, vel, side, out, sideSpeed, upSpeed, ground, spread = 0.3) {
    const O = this.O, r = Math.random;
    O.x = p.x + (r() - 0.5) * spread * 2; O.y = Math.max(p.y, ground) + 0.1; O.z = p.z + (r() - 0.5) * spread * 2; O.ground = ground; O.birth = undefined;
    const k = sideSpeed * (0.6 + r() * 0.6) * out;
    O.vx = vel.x * 0.4 + side.x * k + (r() - 0.5) * 1.5; O.vy = upSpeed * (0.5 + r() * 0.7); O.vz = vel.z * 0.4 + side.z * k + (r() - 0.5) * 1.5;
    O.size = 0.12 + r() * 0.24; O.grow = 0.35; O.life = 0.7 + r() * 0.6; O.alpha = 0.8;
    const s = 0.9 + r() * 0.12; O.r = SPRAY[0] * s; O.g = SPRAY[1] * s; O.b = SPRAY[2] * s;
    O.rot = r() * TAU; O.spin = 0; O.drag = 0.5; O.lift = -16; O.kind = DROP;
    this.puffs.spawn(O, this.time);
    if (r() > 0.18) return;
    for (let a = 0.1; a < O.life; a += 0.03) if (O.y + fly(0.5, -16, O.vy, a) < ground) {
      const x = O.x + fly(0.5, 0, O.vx, a), z = O.z + fly(0.5, 0, O.vz, a);
      this.ring(x, ground, z, 0.25, 1.3, 0.6, 0.4, this.time + a);
      break;
    }
  }
  ring(x, y, z, size, grow, life, alpha, birth = undefined) {
    const O = this.O;
    Object.assign(O, { x, y: y + 0.03, z, vx: 0, vy: 0, vz: 0, ground: y, size, grow, life, alpha, r: FOAM[0], g: FOAM[1], b: FOAM[2],
      rot: Math.random() * TAU, spin: 0, drag: 0, lift: 0, kind: RING, birth });
    this.puffs.spawn(O, this.time);
  }

  // the motion-blur discs: from each wheel's drawn spin rate (blurred above ~60 km/h, fully by ~110)
  blur(dt, car, mw) {
    (car.wheels || []).forEach((wh, i) => {
      const g = mw[i], t = this.tyres[i];
      if (!g?.spin || !g.holder || !t) return;
      if (dt > 0) {
        if (Number.isFinite(t.spin) && Number.isFinite(wh.spin)) t.w += (Math.min(400, Math.abs(wh.spin - t.spin) / dt + t.xrate) - t.w) * Math.min(1, dt * 12);
        t.spin = wh.spin;
        t.blur += (smooth(16, 30, t.w * g.r) * 0.92 - t.blur) * Math.min(1, dt * 8);
      }
      if (t.extra && (car.kind === 'car' || car.kind === 'bike')) g.spin.rotation.x = wh.spin + t.extra;
      if (t.blur < 0.02 || this.discN + 2 > this.discCap) return;
      g.holder.updateWorldMatrix(true, false);
      const info = wheelInfo(g), rd = g.r * 0.72;
      const color = g.rimColor || g.spin.children[1]?.material?.color || UNPAINTED_RIM;
      for (const s of [-1, 1]) {
        _m.makeScale(rd, rd, rd).setPosition(s * (info.hw + 0.006), 0, 0).premultiply(g.holder.matrixWorld);
        this.discColor.setXYZ(this.discN, color.r, color.g, color.b);
        this.discs.setMatrixAt(this.discN, _m); this.discA.array[this.discN++] = t.blur;
      }
    });
  }

  // daylight on the effects (hemisphere + sun, ~1 at midday), the sun's direction (chips) and one headlight cone
  lighting(dt) {
    if ((this.lookT -= dt) <= 0) {
      this.lookT = 2; const ch = this.scene.children;
      this.hemi = ch.find(o => o.isHemisphereLight) || null; this.sun = ch.find(o => o.isDirectionalLight) || null;
      this.spots = ch.filter(o => o.isSpotLight);
    }
    const h = this.hemi, s = this.sun, L = this.uLight.value.set(0, 0, 0);
    if (h) L.set(h.color.r * 0.42 + h.groundColor.r * 0.12, h.color.g * 0.42 + h.groundColor.g * 0.12, h.color.b * 0.42 + h.groundColor.b * 0.12).multiplyScalar(h.intensity);
    if (s) {
      const d = this.uSunDir.value.subVectors(s.position, s.target.position).normalize();
      L.add(_v.set(s.color.r, s.color.g, s.color.b).multiplyScalar(s.intensity * 0.22 * Math.max(0.15, d.y)));
    }
    if (h || s) L.multiplyScalar(1 / 0.92).min(_v.set(1.2, 1.2, 1.2)); else L.set(1, 1, 1);
    const sp = this.spots.find(o => o.visible && o.intensity > 0), S = this.uSpot.value;
    if (!sp) { S.w = 0; return; }
    this.uSpotPos.value.copy(sp.position); this.uSpotDir.value.subVectors(sp.target.position, sp.position).normalize();
    const outer = Math.cos(sp.angle);                         // smoothstep needs its edges apart (else undefined in GLSL)
    S.set(outer, Math.max(outer + 0.001, Math.cos(sp.angle * (1 - sp.penumbra))), sp.distance || 60, 1.3 * sp.intensity / (sp.intensity + 2));
    this.uLamp.value.set(sp.color.r, sp.color.g, sp.color.b);
  }

  // the clock moves everything; send only what was thrown or laid this frame (once, however many vehicles drove)
  advance(dt) {
    dt = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    this.time += dt; this.uTime.value = this.time;
    this.lighting(dt);
    for (const [R, buf, geo, mesh] of [[this.puffs, this.puffBuf, this.puffGeo, this.points], [this.chips, this.chipBuf, this.chipGeo, this.chipMesh]]) {
      R.count(this.time);
      const ranges = R.takeDirty();
      if (ranges.length) { buf.clearUpdateRanges(); for (const [s, n] of ranges) buf.addUpdateRange(s, n); buf.needsUpdate = true; }
      geo.instanceCount = R.drawn; mesh.visible = this.time < R.until;
    }
    const M = this.marksBuf, runs = M.takeDirty();
    if (runs.length) {
      const at = this.marks.geometry.attributes;
      for (const [a, w] of [[at.position, 12], [at.mcol, 12], [at.info, 16]]) {
        a.clearUpdateRanges(); for (const [s, c] of runs) a.addUpdateRange(s * w, c * w); a.needsUpdate = true;
      }
      this.marks.geometry.setDrawRange(0, Math.min(M.total, M.max) * 6);
    }
    const dn = this.discN; this.discs.count = dn; this.discs.visible = dn > 0;   // wheel blur: what drove this frame
    if (dn) {
      this.discs.instanceMatrix.clearUpdateRanges(); this.discs.instanceMatrix.addUpdateRange(0, dn * 16); this.discs.instanceMatrix.needsUpdate = true;
      this.discA.clearUpdateRanges(); this.discA.addUpdateRange(0, dn); this.discA.needsUpdate = true;
      this.discColor.clearUpdateRanges(); this.discColor.addUpdateRange(0, dn * 3); this.discColor.needsUpdate = true;
    }
    this.discN = 0;
  }

  // how many of each are alive / drawn (tests, browser scripts)
  stats() {
    return { puffs: this.puffs.live(this.time), chips: this.chips.live(this.time), marks: Math.min(this.marksBuf.total, this.marksBuf.max),
      discs: this.discs.count, reused: this.puffs.reused + this.chips.reused };
  }
  dispose() {
    for (const o of [...this.objects, ...(this.tyreBlobs || []), this.bodyBlob].filter(Boolean)) {
      o.removeFromParent(); o.geometry.dispose(); o.material.map?.dispose(); o.material.dispose();
    }
    this.tex.dispose(); this.discs.dispose?.();
  }
}
