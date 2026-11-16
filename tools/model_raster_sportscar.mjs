// Looks at a vehicle model without a browser: a tiny flat-shaded z-buffer rasterizer (material colour × vertex colour,
// sun + sky light, back faces culled like FrontSide) that writes a PNG sheet of views. For checking model shapes in
// Node only; the real look is the game's (tools/model_shots_*.mjs).
//   node tools/model_raster_sportscar.mjs [--kind car] [--type sports] [--out /tmp/model.png] [--size 420] [--far]
//     [--body #hex --trim #hex --wheels #hex] [--view name | --eye x,y,z --at x,y,z --fov deg]
//   (model space, ground at y = 0)
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { paintedModel } from '../game/src/cosmetics.js';

const args = process.argv.slice(2), opt = (k, d) => args.includes(k) ? args[args.indexOf(k) + 1] : d;
const kind = opt('--kind', 'car'), type = opt('--type', 'sports'), out = opt('--out', `${process.env.TMPDIR || '/tmp'}/model.png`);
const S = +opt('--size', 420), SS = 2;                     // tile size, supersampling
const colors = {}; for (const k of ['body', 'trim', 'wheels']) if (opt('--' + k)) colors[k] = opt('--' + k);
const model = paintedModel(kind, colors, type), ud = model.userData;
const low = Math.min(...(ud.wheels || []).map(w => w.holder.position.y - w.r));
model.position.y = -low; model.updateMatrixWorld(true);
if (ud.lod) ud.lod.levels.forEach((l, i) => { l.object.visible = args.includes('--far') ? i === 1 : i === 0; });

const VIEWS = [
  ['front34', [5.2, 1.9, 5.6], [0, .5, .2], 36], ['rear34', [-5.0, 2.0, -5.8], [0, .5, -.2], 36],
  ['side', [8.5, .75, 0], [0, .55, 0], 34], ['top', [0, 10, .01], [0, 0, 0], 30],
  ['front', [0, .9, 8], [0, .55, 0], 20], ['rear', [0, 1.0, -8], [0, .55, 0], 20],
  ['lowfront', [3.4, .45, 4.6], [0, .45, 0], 44], ['under', [4, -1.5, 0.01], [0, .2, 0], 50],
  ['wheel', [3.0, .5, 2.4], [.9, .15, 1.3], 30],
];
const vec = s => s.split(',').map(Number);
const views = opt('--eye') ? [['custom', vec(opt('--eye')), vec(opt('--at', '0,.4,0')), +opt('--fov', 30)]]
  : opt('--view') ? VIEWS.filter(v => v[0] === opt('--view')) : VIEWS;

// collect world-space triangles with colours
const tris = [];
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), col = new THREE.Color();
model.traverse(o => {
  if (!o.isMesh) return;
  for (let p = o; p; p = p.parent) if (!p.visible) return;
  const g = o.geometry, pos = g.attributes.position, vc = o.material.vertexColors ? g.attributes.color : null, idx = g.index;
  const base = o.material.color || new THREE.Color(1, 1, 1);
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const ia = idx ? idx.getX(i) : i, ib = idx ? idx.getX(i + 1) : i + 1, ic = idx ? idx.getX(i + 2) : i + 2;
    _a.fromBufferAttribute(pos, ia).applyMatrix4(o.matrixWorld); _b.fromBufferAttribute(pos, ib).applyMatrix4(o.matrixWorld); _c.fromBufferAttribute(pos, ic).applyMatrix4(o.matrixWorld);
    col.copy(base); if (vc) col.multiply(new THREE.Color(vc.getX(ia), vc.getY(ia), vc.getZ(ia)));
    tris.push([_a.clone(), _b.clone(), _c.clone(), [col.r, col.g, col.b], o.material.side === THREE.DoubleSide]);
  }
});
// ground quad
const gcol = [.16, .17, .18];
tris.push([new THREE.Vector3(-12, 0, -12), new THREE.Vector3(-12, 0, 12), new THREE.Vector3(12, 0, 12), gcol, false]);
tris.push([new THREE.Vector3(-12, 0, -12), new THREE.Vector3(12, 0, 12), new THREE.Vector3(12, 0, -12), gcol, false]);
const sun = new THREE.Vector3(4, 8, 5).normalize();

const cols = Math.min(3, views.length), rows = Math.ceil(views.length / cols), W = cols * S, H = rows * S;
const img = new Float32Array(W * H * 3).fill(0);
views.forEach(([name, eye, at, fov], vi) => {
  const w = S * SS, h = S * SS, zb = new Float32Array(w * h).fill(Infinity), cb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { const t = Math.floor(i / w) / h; cb[i * 3] = .55 + .1 * t; cb[i * 3 + 1] = .64 + .08 * t; cb[i * 3 + 2] = .74; }
  const cam = new THREE.PerspectiveCamera(fov, 1, .05, 200); cam.position.set(...eye); cam.lookAt(...at); cam.updateMatrixWorld();
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const P = new THREE.Vector4();
  for (const [a, b, c, rgb, dbl] of tris) {
    const nrm = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)); if (nrm.lengthSq() < 1e-14) continue; nrm.normalize();
    const toEye = new THREE.Vector3().subVectors(cam.position, a);
    let nn = nrm; if (nrm.dot(toEye) < 0) { if (!dbl) continue; nn = nrm.clone().negate(); }
    const sc = [a, b, c].map(v => { P.set(v.x, v.y, v.z, 1).applyMatrix4(vp); return P.w <= .05 ? null : [(P.x / P.w * .5 + .5) * w, (1 - (P.y / P.w * .5 + .5)) * h, P.z / P.w]; });
    if (sc.some(s => !s)) continue;
    const light = .38 + .25 * Math.max(0, nn.y) + .85 * Math.max(0, nn.dot(sun));
    const r = rgb[0] * light, g = rgb[1] * light, bl = rgb[2] * light;
    const [p0, p1, p2] = sc, minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0]))), maxX = Math.min(w - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1]))), maxY = Math.min(h - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]); if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + .5, py = y + .5;
      const w0 = ((p1[0] - px) * (p2[1] - py) - (p2[0] - px) * (p1[1] - py)) / area;
      const w1 = ((p2[0] - px) * (p0[1] - py) - (p0[0] - px) * (p2[1] - py)) / area;
      const w2 = 1 - w0 - w1; if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * p0[2] + w1 * p1[2] + w2 * p2[2], k = y * w + x;
      if (z >= zb[k]) continue; zb[k] = z; cb[k * 3] = r; cb[k * 3 + 1] = g; cb[k * 3 + 2] = bl;
    }
  }
  const ox = (vi % cols) * S, oy = Math.floor(vi / cols) * S;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) for (let ch = 0; ch < 3; ch++) {
    let s = 0; for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) s += cb[((y * SS + dy) * w + x * SS + dx) * 3 + ch];
    img[((oy + y) * W + ox + x) * 3 + ch] = s / (SS * SS);
  }
  for (let x = 0; x < S; x++) for (const yy of [0, S - 1]) img.fill(0, ((oy + yy) * W + ox + x) * 3, ((oy + yy) * W + ox + x) * 3 + 3);
  console.log(`${name}: rendered`);
});
// linear → sRGB, PNG
const toS = v => { v = Math.max(0, Math.min(1, v)); return Math.round(255 * (v <= .0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - .055)); };
const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W * 3; x++) raw[y * (W * 3 + 1) + 1 + x] = toS(img[y * W * 3 + x]); }
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = buf => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`wrote ${out} (${W}×${H}, ${tris.length} triangles)`);
