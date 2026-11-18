// Local-player fittings only. Lazily built per cached model; never added to Garage/thumbnail models.
import * as THREE from 'three';
import { material, mesh, box, rod, batch } from './truckbikeparts.js';

const SEATS = {
  race:   { eye: [0, .40, -.06], width: .23, depth: .48, drop: .16, cowl: .24, front: .68 },
  sports: { eye: [.34, .64, -.38], width: .80, depth: .86, drop: .28, cowl: .34, front: 1.04 },
  hatch:  { eye: [.39, .80, -.25], width: .87, depth: .82, drop: .28, cowl: .43, front: .82 },
  suv:    { eye: [.48, .94, -.18], width: 1.05, depth: .92, drop: .31, cowl: .50, front: 1.00 },
  truck:  { eye: [.48, 1.48, -.12], width: 1.02, depth: .86, drop: .29, cowl: .82, front: .89 },
};

// The exteriors batch glass/roof/helmet faces with other parts. Swap only the triangle index;
// positions, paint bindings and damage buffers stay owned by the exterior. Restore on exit.
function faceMasks(parent, frame, remove) {
  frame.updateWorldMatrix(true, true);
  const inverse = frame.matrixWorld.clone().invert(), matrix = new THREE.Matrix4();
  const point = new THREE.Vector3(), centre = new THREE.Vector3(), masks = [];
  parent.traverse(o => {
    if (!o.isMesh || o.userData.damageRigid) return;
    const g = o.geometry, p = g.attributes.position, original = g.index, kept = [];
    matrix.multiplyMatrices(inverse, o.matrixWorld);
    const count = original?.count ?? p.count;
    for (let i = 0; i < count; i += 3) {
      centre.set(0, 0, 0);
      for (let j = 0; j < 3; j++) centre.add(point.fromBufferAttribute(p, original ? original.getX(i + j) : i + j).applyMatrix4(matrix));
      centre.multiplyScalar(1 / 3);
      if (!remove(centre, o)) for (let j = 0; j < 3; j++) kept.push(original ? original.getX(i + j) : i + j);
    }
    if (kept.length !== count) masks.push({ mesh: o, original, filtered: new THREE.Uint32BufferAttribute(kept, 1) });
  });
  return masks;
}

export function ensureGroundInterior(model, kind, type) {
  if (kind !== 'car' && kind !== 'bike') return null;
  if (model.userData.interior) return model.userData.interior;
  const bike = kind === 'bike', race = type === 'race', sport = type === 'sport';
  const ud = model.userData, mount = bike ? ud.bars.parent : ud.bodyPivot;
  const spec = SEATS[type] || SEATS.race;
  const eye = new THREE.Vector3(...(bike ? [0, sport ? .80 : 1.04, sport ? .20 : .09] : spec.eye));
  // Read the authored helmet centre in the body's frame, including the rider's resting pose.
  if (bike && ud.rider) {
    const rotation = ud.rider.rotation.x; ud.rider.rotation.x = .12;
    mount.updateWorldMatrix(true, true);
    const inv = mount.matrixWorld.clone().invert(), bounds = new THREE.Box3(), part = new THREE.Box3();
    ud.rider.traverse(o => {
      if (!o.isMesh || o.material.userData.cosmeticRole !== 'helmet') return;
      o.geometry.computeBoundingBox();
      part.copy(o.geometry.boundingBox).applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld)); bounds.union(part);
    });
    if (!bounds.isEmpty()) bounds.getCenter(eye);
    ud.rider.rotation.x = rotation;
  }
  const masks = bike ? faceMasks(ud.rider, mount, p => p.y > eye.y - .18)
    : faceMasks(mount, mount, p => p.y > spec.cowl && p.z < spec.front && p.z > -1.5 && (!race || Math.abs(p.x) < .33));
  const group = new THREE.Group(); group.name = 'ground-interior'; group.userData.damageRigid = true;
  group.visible = false;
  const dark = material('#262b30'), trim = material('#626d75'), rubber = material('#12171b');
  const face = material('#14222b'), tick = material('#d9ddc7'), red = material('#ed7451');
  // The shared batch helper converts fixed sRGB colours into linear vertex colours.
  const fittings = new THREE.Group(), controls = new THREE.Group(), needles = [];
  group.add(fittings, controls);
  function dial(parent, x, y, z, r) {
    mesh(parent, new THREE.RingGeometry(r * .86, r, 12).rotateY(Math.PI), trim, x, y, z);
    mesh(parent, new THREE.CircleGeometry(r * .85, 12).rotateY(Math.PI), face, x, y, z - .001);
    for (let i = 0; i < 7; i++) {
      const a = (i / 6 - .5) * Math.PI * 1.5;
      const mark = box(parent, i === 6 ? red : tick, .005, r * .17, .002,
        x - Math.sin(a) * r * .68, y + Math.cos(a) * r * .68, z - .003); mark.rotation.z = a;
    }
    const needle = mesh(group, new THREE.BufferGeometry().setAttribute('position',
      new THREE.Float32BufferAttribute([-.004, -.008, 0, 0, r * .65, 0, .004, -.008, 0], 3)),
      new THREE.MeshBasicMaterial({ color: '#f1b16c', side: THREE.DoubleSide }), x, y, z - .006);
    needles.push(needle);
  }
  if (!bike) {
    group.position.copy(eye);
    const { width: w, depth: d, drop } = spec, cx = -eye.x, small = race ? .64 : 1;
    box(fittings, dark, w * 2, .20 * small, .20, cx, -drop - .12 * small, d);
    box(fittings, rubber, w * 2, .025, .25, cx, -drop, d);
    dial(fittings, -.075 * small, -drop - .07 * small, d - .105, .060 * small);
    dial(fittings, .075 * small, -drop - .07 * small, d - .105, .060 * small);
    controls.position.set(0, -drop - .12 * small, d - .25 * small);
    mesh(controls, new THREE.TorusGeometry(.145 * small, .014 * small, 4, 12), rubber);
    box(controls, trim, .26 * small, .018 * small, .025, 0, 0, 0);
    box(controls, dark, .075 * small, .06 * small, .035, 0, 0, -.005);
    box(controls, trim, .018, .13 * small, .02, 0, -.065 * small, 0);
    if (!race) {
      for (const s of [-1, 1]) {
        const x = cx + s * w;
        rod(fittings, dark, [x, -drop, d + .08], [cx + s * w * .90, .19, d * .55], .018, 4);
        box(fittings, dark, .07, .09, 1.2, x, -drop - .09, .15);
        rod(fittings, trim, [x, .19, -.45], [cx + s * w * .90, .19, d * .55], .014, 4);
      }
      box(fittings, dark, w * 1.82, .055, .10, cx, .21, d * .55);
      box(fittings, dark, .24, .075, .035, cx, .105, d * .58);
      box(fittings, trim, .21, .052, .008, cx, .105, d * .58 - .023);
      box(fittings, dark, .22, .20, .60, cx, -drop - .24, .24);
      rod(fittings, trim, [cx, -drop - .15, .24], [cx, -drop - .025, .30], .012, 5);
      box(fittings, rubber, .05, .04, .055, cx, -drop - .01, .30);
      for (const x of [cx - .12, cx + .12]) box(fittings, rubber, .14, .035, .012, x, -drop - .08, d - .108);
    } else {
      for (const s of [-1, 1]) box(fittings, dark, .055, .18, .65, s * w, -.24, .12);
    }
  } else {
    // Keep the real tank, forks, mudguard and turning handlebars. The extra instruments and
    // mirrors are attached to the existing bar pivot, so their steering is identical.
    controls.position.copy(ud.bars.position); controls.quaternion.copy(ud.bars.quaternion);
    const y = sport ? .57 : .13, z = sport ? -.23 : .015;
    box(controls, dark, .20, .09, .06, 0, y, z);
    // Faces incline toward the rider; gauge assembly lives in the steering group's frame.
    const panel = new THREE.Group(); panel.position.set(0, y + .035, z - .04); panel.rotation.x = -.55;
    controls.add(panel);
    dial(panel, 0, 0, 0, .052);
    const needle = needles[0]; group.remove(needle);
    for (const s of [-1, 1]) {
      rod(controls, trim, [s * .27, y - .015, z], [s * .39, y + .20, z + .07], .009, 4);
      box(controls, rubber, .13, .07, .035, s * .40, y + .20, z + .07);
      box(controls, trim, .105, .05, .005, s * .40, y + .20, z + .049);
    }
    batch(panel); panel.add(needle);
  }
  // Preserve moving needles when merging their static instrument surroundings.
  // The car needles are siblings of fittings; the bike's panel is merged before its needle is restored.
  batch(fittings); batch(controls);
  let active = false;
  const look = new THREE.Vector3(), up = new THREE.Vector3();
  const interior = {
    group, eye, mount, controls, needles, masks,
    setVisible(on) {
      if (on === active) return;
      active = on; group.visible = on;
      if (on) mount.add(group); else group.removeFromParent();
      for (const m of masks) m.mesh.geometry.setIndex(on ? m.filtered : m.original);
    },
    update(v) {
      if (!active) return;
      if (bike) controls.quaternion.copy(ud.bars.quaternion);
      else controls.rotation.z = -(v.steer || 0) * 1.8;
      const speed = v.vel.length() * 3.6;
      for (let i = 0; i < needles.length; i++) needles[i].rotation.z = (Math.min(1, speed / (i ? 160 : (v.t?.topSpeed || 300))) - .5) * Math.PI * 1.5;
    },
    camera(camera) {
      camera.position.copy(eye).applyMatrix4(mount.matrixWorld);
      const pitch = bike ? .32 : 0;
      look.set(0, -Math.sin(pitch), Math.cos(pitch)).transformDirection(mount.matrixWorld).add(camera.position);
      up.set(0, 1, 0).transformDirection(mount.matrixWorld); camera.up.copy(up); camera.lookAt(look);
    },
  };
  model.userData.interior = interior;
  return interior;
}
