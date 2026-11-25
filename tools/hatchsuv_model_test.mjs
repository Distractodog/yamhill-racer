// Node geometry checks for the shaped Hatchback, Rally and SUV models (game/src/models/hatch.js, rally.js, suv.js): triangle budget near /
// far, finite positions, outward-facing surfaces, size, paint roles, light anchors, and the wheels inside their arches.
// node tools/hatchsuv_model_test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildVehicleTypeModel, typeInfo } from '../game/src/vehicletypes.js';
import { paintedModel } from '../game/src/cosmetics.js';

const tris = g => (g.index ? g.index.count : g.attributes.position.count) / 3;
// signed volume (closed outward-facing surfaces > 0)
function volume(g) {
  const a = g.attributes.position.array; let v = 0;
  for (let i = 0; i < a.length; i += 9) v += (a[i] * (a[i + 4] * a[i + 8] - a[i + 5] * a[i + 7]) - a[i + 1] * (a[i + 3] * a[i + 8] - a[i + 5] * a[i + 6]) + a[i + 2] * (a[i + 3] * a[i + 7] - a[i + 4] * a[i + 6])) / 6;
  return v;
}
const table = [];
for (const id of ['hatch', 'rally', 'suv']) {
  const spec = typeInfo('car', id), p = spec.physics, model = buildVehicleTypeModel('car', id), ud = model.userData;
  model.updateMatrixWorld(true);
  const lod = model.getObjectByName('body-lod'), near = model.getObjectByName('body-near'), far = model.getObjectByName('body-far');
  assert(lod?.isLOD && near && far, `${id}: near / far LOD groups`);
  let nearTris = 0, farTris = 0, wheelTris = 0, bad = 0, vol = 0;
  const roles = new Set();
  model.traverse(o => {
    if (!o.isMesh) return;
    const a = o.geometry.attributes.position.array;
    for (const x of a) if (!Number.isFinite(x)) bad++;
    if (o.material.userData.cosmeticRole) roles.add(o.material.userData.cosmeticRole);
    let inNear = false, inFar = false; for (let q = o.parent; q; q = q.parent) { if (q === near) inNear = true; if (q === far) inFar = true; }
    if (inNear) { nearTris += tris(o.geometry); vol += volume(o.geometry); } else if (inFar) farTris += tris(o.geometry); else wheelTris += tris(o.geometry);
  });
  assert.equal(bad, 0, `${id}: NaN / infinite positions`);
  assert(nearTris + wheelTris <= 6000, `${id}: ${nearTris + wheelTris} near triangles`);
  assert(farTris < nearTris * .6, `${id}: far version not cheaper: near ${nearTris} far ${farTris} wheels ${wheelTris}`);
  assert(vol > 0, `${id}: body faces point inward (volume ${vol})`);
  for (const r of ['body', 'trim', 'wheels']) assert(roles.has(r), `${id}: no ${r} paint role`);
  // tyres: tread faces point away from the axle
  for (const w of ud.wheels) {
    const g = w.spin.children[0].geometry, a = g.attributes.position.array; let out = 0, inn = 0;
    const n = new THREE.Vector3(), A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
    for (let i = 0; i < a.length; i += 9) {
      A.fromArray(a, i); B.fromArray(a, i + 3); C.fromArray(a, i + 6);
      const cy = (A.y + B.y + C.y) / 3, cz = (A.z + B.z + C.z) / 3; if (Math.hypot(cy, cz) < w.r * .97) continue;
      n.subVectors(B, A).cross(C.clone().sub(A));
      if (n.y * cy + n.z * cz > 0) out++; else inn++;
    }
    assert(out > 0 && inn === 0, `${id}: tyre tread faces inward (${inn}/${out + inn})`);
    assert.equal(w.spin.children[1].material.userData.cosmeticRole, 'wheels');
  }
  // body bounding box (near), wheels inside their arches
  const box = new THREE.Box3().setFromObject(near), size = box.getSize(new THREE.Vector3());
  const ground = Math.min(...ud.wheels.map(w => w.holder.position.y - w.r));
  assert.equal(ud.wheelArch.length, 4);
  for (const [i, w] of ud.wheels.entries()) {
    // wheelArch is a tyre-top ceiling in the body frame (wheeltravel.js): the gap above the parked tyre top
    const gap = ud.wheelArch[i] - w.holder.position.y - w.r;
    assert(gap > .03 && gap < .2, `${id}: wheel ${i} arch gap ${gap}`);
    const wb = new THREE.Box3().setFromObject(w.holder);
    assert(Math.abs(wb.max.x) <= box.max.x + .005 && Math.abs(wb.min.x) <= box.max.x + .005, `${id}: wheel ${i} sticks out of the body width`);
  }
  assert(ud.lights.head.length === (id === 'rally' ? 6 : 2) && ud.lights.tail.length === 2);
  for (const v of ud.lights.head) assert(v.z > box.max.z - .2 && v.z < box.max.z + .08, `${id}: headlight anchor off the nose`);
  for (const v of ud.lights.tail) assert(v.z < box.min.z + .45, `${id}: tail anchor off the tail`);
  // multiplayer: the painted copy still merges (remotes.js bakes it per group)
  const painted = paintedModel('car', { body: '#123456' }, id);
  let blue = false; painted.traverse(o => { if (o.material?.userData?.cosmeticRole === 'body' && o.material.color.getHexString() === new THREE.Color('#123456').getHexString()) blue = true; });
  assert(blue, `${id}: body paint not applied`);
  table.push({ type: id, nearTris: nearTris + wheelTris, farTris: farTris + wheelTris, wheelTris,
    length: size.z.toFixed(2), width: size.x.toFixed(2), height: (box.max.y - ground).toFixed(2), clearance: (box.min.y - ground).toFixed(2),
    wheelArch: ud.wheelArch.join(' '), physWidth: p.width, physLength: p.length });
}
console.table(table);
console.log('PASS: hatch + Rally + SUV geometry (budget, finite, outward faces, paint roles, lights, wheel arches).');
