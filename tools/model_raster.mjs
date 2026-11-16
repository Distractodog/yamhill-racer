// Software model sheet (no browser / GPU): renders a car type's model from several angles with a z-buffer and flat
// Lambert shading into one PNG, so model work can be looked at from Node. Back faces that end up visible are drawn
// magenta (wrong winding). Approximate: no shadows, no textures (livery decals skipped), lenses shown as lit spots.
//   node tools/model_raster.mjs <type> <out.png> [far]        e.g. node tools/model_raster.mjs hatch /tmp/hatch.png
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { paintedModel } from '../game/src/cosmetics.js';

const [type = 'hatch', out = 'model.png', farArg] = process.argv.slice(2);
const model = paintedModel('car', {}, type), ud = model.userData;
const near = model.getObjectByName('body-near'), far = model.getObjectByName('body-far');
if (near && far) { near.visible = !farArg; far.visible = !!farArg; }
// STEER=1 turns the front wheels to full lock the way Car.syncMesh does (steerLock 0.6 × 0.9)
for (const w of ud.wheels) if (w.front) w.holder.rotation.y = -(+process.env.STEER || 0) * .6 * .9;
model.updateMatrixWorld(true);
const lowest = Math.min(...ud.wheels.map(w => w.holder.position.y - w.r));
// world triangles: [ax,ay,az,bx,...,r,g,b] (linear colour)
const T = [], sources = [], backHits = new Map(), _a = new THREE.Vector3(), _c = new THREE.Color();
model.traverse(o => {
  if (!o.isMesh) return;
  for (let q = o; q; q = q.parent) if (!q.visible) return;
  if (o.material.transparent) return;
  const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry, p = g.attributes.position, col = o.material.vertexColors ? g.attributes.color : null;
  _c.copy(o.material.color);
  for (let i = 0; i < p.count; i += 3) {
    const t = [];
    for (let k = 0; k < 3; k++) { _a.fromBufferAttribute(p, i + k).applyMatrix4(o.matrixWorld); t.push(_a.x, _a.y - lowest, _a.z); }
    const r = col ? col.getX(i) : 1, gg = col ? col.getY(i) : 1, b = col ? col.getZ(i) : 1;
    t.push(_c.r * r, _c.g * gg, _c.b * b, 0, sources.length); T.push(t);
  }
  sources.push(`${o.parent?.name || o.parent?.type}/${o.material.userData.cosmeticRole || (o.material.vertexColors ? 'fixed' : 'plain')}`);
});
for (const s of ['head', 'tail']) for (const v of ud.lights[s]) {         // light anchors as small bright diamonds
  const p = v.clone().applyMatrix4(ud.lightMount.matrixWorld), y = p.y - lowest, d = .05, c = s === 'head' ? [3, 3, 2.5] : [3, .1, .1];
  for (const [a, b] of [[[d, 0, 0], [0, d, 0]], [[0, d, 0], [-d, 0, 0]], [[-d, 0, 0], [0, -d, 0]], [[0, -d, 0], [d, 0, 0]]])
    for (const zs of [1, -1]) T.push([p.x + a[0], y + a[1], p.z, p.x + b[0], y + b[1], p.z, p.x, y, p.z + zs * d, ...c, 1]);
}
const box = new THREE.Box3(); for (const t of T) for (let k = 0; k < 9; k += 3) box.expandByPoint(_a.set(t[k], t[k + 1], t[k + 2]));
const C = box.getCenter(new THREE.Vector3()), L = box.getSize(new THREE.Vector3()).length();
const sunDir = new THREE.Vector3(.45, .8, .4).normalize();

const VW = 480, VH = 300, views = [
  ['front 3/4', [1.1, .45, 1.2]], ['rear 3/4', [-1.1, .5, -1.25]], ['side', [1, .02, 0]], ['top', [.0001, 1, 0]],
  ['front', [0, .12, 1]], ['rear', [0, .15, -1]], ['front 3/4 low', [.9, .08, 1.3], 1.15], ['under', [1.2, -.35, .25]],
  ['wheel', [1, .08, .45], 3, 0], ['rear 3/4 right', [1.1, .4, -1.2]], ['other side', [-1, .05, .1]], ['top rear', [-.35, 1, -.9]],
];
const cols = 4, rows = Math.ceil(views.length / cols), IW = VW * cols, IH = VH * rows;
const img = new Uint8Array(IW * IH * 3);
const srgb = v => Math.round(255 * Math.min(1, v <= .0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - .055));
views.forEach(([, dir, zoom = 1, wheel = null], vi) => {
  const ox = (vi % cols) * VW, oy = Math.floor(vi / cols) * VH;
  const target = wheel === null ? C.clone() : ud.wheels[wheel].holder.getWorldPosition(new THREE.Vector3()).setY(ud.wheels[wheel].holder.getWorldPosition(new THREE.Vector3()).y - lowest);
  const eye = target.clone().add(new THREE.Vector3(...dir).normalize().multiplyScalar(L * 1.35 / zoom));
  const cam = new THREE.PerspectiveCamera(32, VW / VH, .05, 100); cam.position.copy(eye);
  if (Math.abs(dir[0]) < .01 && Math.abs(dir[2]) < .01) cam.up.set(0, 0, 1);
  cam.lookAt(target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const M = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const zb = new Float32Array(VW * VH).fill(Infinity);
  for (let y = 0; y < VH; y++) for (let x = 0; x < VW; x++) {        // sky / ground backdrop
    const i = ((oy + y) * IW + ox + x) * 3, gnd = y > VH * .62; img[i] = gnd ? 120 : 165; img[i + 1] = gnd ? 128 : 196; img[i + 2] = gnd ? 112 : 226;
  }
  const P = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), vs = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const own = new Int32Array(VW * VH).fill(-1);       // pixels where a back face ended up in front
  for (let ti = 0; ti < T.length; ti++) {
    const t = T[ti];
    e1.set(t[3] - t[0], t[4] - t[1], t[5] - t[2]); e2.set(t[6] - t[0], t[7] - t[1], t[8] - t[2]); n.crossVectors(e1, e2).normalize();
    const toCam = new THREE.Vector3(eye.x - t[0], eye.y - t[1], eye.z - t[2]), back = n.dot(toCam) < 0 && !t[12];
    let shade;
    if (t[12]) shade = [t[9], t[10], t[11]];
    else if (back) shade = [1, 0, 1];
    else { const k = .35 + .9 * Math.max(0, n.dot(sunDir)) + .15 * Math.max(0, n.y); shade = [t[9] * k, t[10] * k, t[11] * k]; }
    let ok = true;
    for (let k = 0; k < 3; k++) {
      P.set(t[k * 3], t[k * 3 + 1], t[k * 3 + 2]).applyMatrix4(M);
      const w = new THREE.Vector4(t[k * 3], t[k * 3 + 1], t[k * 3 + 2], 1).applyMatrix4(M).w; if (w < .05) ok = false;
      vs[k][0] = (P.x * .5 + .5) * VW; vs[k][1] = (1 - (P.y * .5 + .5)) * VH; vs[k][2] = w;
    }
    if (!ok) continue;
    const [a, b, c] = vs, area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(VW - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(VH - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const col = shade.map(srgb);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + .5, py = y + .5;
      const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area, w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area, w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const z = 1 / (w0 / a[2] + w1 / b[2] + w2 / c[2]) - (t[12] ? .02 : 0) + (back ? .004 : 0), zi = y * VW + x;
      if (z >= zb[zi]) continue; zb[zi] = z;
      own[zi] = back ? ti : -1;
      const i = ((oy + y) * IW + ox + x) * 3; img[i] = col[0]; img[i + 1] = col[1]; img[i + 2] = col[2];
    }
  }
  for (const ti of own) if (ti >= 0) {
    const t = T[ti], key = `${views[vi][0]}: ${sources[t[13]]} @ ${[0, 1, 2].map(k => ((t[k] + t[k + 3] + t[k + 6]) / 3).toFixed(2)).join(',')}`;
    backHits.set(key, (backHits.get(key) || 0) + 1);
  }
  for (let x = 0; x < VW; x++) { const i = ((oy) * IW + ox + x) * 3; img[i] = img[i + 1] = img[i + 2] = 40; }
  for (let y = 0; y < VH; y++) { const i = ((oy + y) * IW + ox) * 3; img[i] = img[i + 1] = img[i + 2] = 40; }
});
// PNG
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (tag, data) => { const h = Buffer.alloc(8); h.writeUInt32BE(data.length); h.write(tag, 4); const cb = Buffer.alloc(4); cb.writeUInt32BE(crc(Buffer.concat([h.subarray(4), data]))); return Buffer.concat([h, data, cb]); };
const raw = Buffer.alloc((IW * 3 + 1) * IH); for (let y = 0; y < IH; y++) { raw[y * (IW * 3 + 1)] = 0; Buffer.from(img.buffer, y * IW * 3, IW * 3).copy(raw, y * (IW * 3 + 1) + 1); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(IW); ihdr.writeUInt32BE(IH, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${out}: ${T.length} triangles drawn (${farArg ? 'far' : 'near'})`);
const worst = [...backHits].sort((a, b) => b[1] - a[1]).slice(0, 12);
if (worst.length) console.log('back faces drawn (pixels, source @ centroid):', worst.map(([k, n]) => `\n  ${n}  ${k}`).join(''));
