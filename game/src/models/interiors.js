// Local-player fittings only. Lazily built per cached model; never added to Garage/thumbnail models.
import * as THREE from 'three';
import { material, mesh, box, rod, batch } from './truckbikeparts.js';

const SEATS = {
  race:   { eye: [0, .40, -.06], width: .23, depth: .48, drop: .16, cowl: .24, front: .68 },
  sports: { eye: [.34, .64, -.38], width: .80, depth: .86, drop: .28, cowl: .34, front: 1.04 },
  hatch:  { eye: [.39, .80, -.25], width: .87, depth: .82, drop: .28, cowl: .43, front: .82 },
  rally:  { eye: [.39, .80, -.25], width: .87, depth: .82, drop: .28, cowl: .43, front: .82 },
  tank:   { eye: [.46, 1.64, -.67], width: .48, depth: .65, drop: .24, cowl: 1.12, front: 1.15 },
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
  // Some bike builders merge the opaque screen and pod into the fairing. Clear that
  // small region at the steering anchor, without touching the rider or painted tank.
  if (sport) {
    const front = ud.bars.position.z;
    masks.push(...faceMasks(mount, mount, (p, o) => {
      for (let a = o; a && a !== mount; a = a.parent) if (a === ud.rider) return false;
      for (let a = o; a && a !== mount; a = a.parent)
        if (/windscreen|windshield/i.test(a.name)) return true;
      return Math.abs(p.x) < .26 && p.z > front - .36 && p.z < front + .24 && p.y > eye.y - .30;
    }));
  }
  const group = new THREE.Group(); group.name = 'ground-interior'; group.userData.damageRigid = true;
  group.visible = false;
  const dark = material('#2b2f33'), trim = material('#a6afb5'), rubber = material('#24272b');
  const lower = material(type === 'truck' ? '#a88c69' : type === 'suv' ? '#9c9384' : type === 'sports' ? '#545861' : '#7b8186');
  const headliner = material(type === 'truck' || type === 'suv' ? '#c7bca6' : '#b0b3b6');
  const accent = material(type === 'sports' ? '#b84b41' : '#a6afb5');
  // Reuse the live body material, rather than a baked colour: Garage paint/wetness
  // updates reach the sills even though interiors are built after cosmetic binding.
  let bodyPaint = null;
  if (!bike && !race) mount.traverse(o => {
    if (!bodyPaint && o.material?.userData.cosmeticRole === 'body') bodyPaint = o.material;
  });
  const face = material('#14222b'), tick = material('#d9ddc7'), red = material('#ed7451');
  // The shared batch helper converts fixed sRGB colours into linear vertex colours.
  const fittings = new THREE.Group(), controls = new THREE.Group(), needles = [];
  group.add(fittings, controls);
  function dial(parent, x, y, z, r) {
    mesh(parent, new THREE.RingGeometry(r * .86, r, 12).rotateY(Math.PI), trim, x, y, z);
    mesh(parent, new THREE.CircleGeometry(r * .85, 12).rotateY(Math.PI), face, x, y, z - .001);
    for (let i = 0; i < 7; i++) {
      const a = (i / 6 - .5) * Math.PI * 1.5;
      const mark = mesh(parent, new THREE.PlaneGeometry(.005, r * .17).rotateY(Math.PI), i === 6 ? red : tick,
        x - Math.sin(a) * r * .68, y + Math.cos(a) * r * .68, z - .003); mark.rotation.z = a;
    }
    const needle = mesh(group, new THREE.BufferGeometry().setAttribute('position',
      new THREE.Float32BufferAttribute([-.004, -.008, 0, 0, r * .65, 0, .004, -.008, 0], 3)),
      new THREE.MeshBasicMaterial({ color: '#f1b16c', side: THREE.DoubleSide }), x, y, z - .006);
    needles.push(needle);
  }
  if (type === 'tank') {
    // Commander's periscope: a narrow armoured slit above the turret, with recessed instruments.
    group.position.copy(eye);
    for (const side of [-1, 1]) {
      box(fittings, dark, .13, .55, .75, side * .49, 0, .38);
      box(fittings, bodyPaint || accent, .07, .025, .75, side * .42, -.18, .38);
    }
    box(fittings, dark, 1.10, .26, .18, 0, .23, .65);
    box(fittings, dark, 1.10, .22, .18, 0, -.22, .65);
    box(fittings, trim, .86, .025, .20, 0, -.10, .65);
    dial(fittings, -.13, -.28, .45, .055);
    dial(fittings, .13, -.28, .45, .055);
    for (const side of [-1, 1]) box(controls, rubber, .045, .20, .055, side * .27, -.32, .28);
  } else if (!bike) {
    group.position.copy(eye);
    const { width: w, depth: d, drop } = spec, cx = -eye.x, small = race ? .64 : type === 'rally' ? .84 : 1;
    const chunky = type === 'truck' || type === 'suv';
    box(fittings, race ? dark : lower, w * 2, (chunky ? .25 : .20) * small, .20, cx, -drop - .12 * small, d);
    box(fittings, dark, w * 2, .025, .25, cx, -drop, d);
    const gaugeY = race ? -drop - .07 * small : -drop + .015;
    if (!race) {
      box(fittings, dark, .34, .15, .035, 0, gaugeY, d - .12);
      box(fittings, accent, w * 2 - .05, .012, .012, cx, -drop - .085, d - .108);
    }
    dial(fittings, -.075 * small, gaugeY, d - (race ? .105 : .145), .060 * small);
    dial(fittings, .075 * small, gaugeY, d - (race ? .105 : .145), .060 * small);
    controls.position.set(0, -drop - (race ? .12 * small : .14), d - (race ? .25 * small : .10));
    mesh(controls, new THREE.TorusGeometry(.145 * small, (race ? .014 : .010) * small, 4, race ? 12 : 24), rubber);
    if (race) box(controls, trim, .26 * small, .018 * small, .025, 0, 0, 0);
    else for (const s of [-1, 1]) rod(controls, trim, [s * .025, -.012, 0], [s * .13, -.04, 0], .009, 4);
    box(controls, dark, .075 * small, .06 * small, .035, 0, 0, -.005);
    box(controls, trim, .018, .13 * small, .02, 0, -.065 * small, 0);
    if (!race) {
      // The passenger pillar is further along the sightline; both posts fit the
      // asymmetric driver's view. The thin headliner follows the windscreen top.
      const leftTop = [cx + w * .90, .29, d * .57];
      const rightDepth = Math.abs(cx - w * .90) / 1.04;
      const rightTop = [cx - w * .90, rightDepth * .61, rightDepth];
      for (const s of [-1, 1]) {
        const x = cx + s * w, top = s > 0 ? leftTop : rightTop;
        const bottom = [x, -drop - (s > 0 ? 0 : .18), s > 0 ? d * .55 : Math.abs(x) / 1.08];
        rod(fittings, dark, bottom, top, s > 0 ? .012 : .014, 4);
        const doorLength = s > 0 ? 1.2 : bottom[2] + .55, doorZ = s > 0 ? .15 : (bottom[2] - .35) / 2;
        const doorY = -drop - (s > 0 ? 0 : .18);
        box(fittings, lower, .07, .12, doorLength, x, doorY - .10, doorZ);
        box(fittings, bodyPaint || accent, .075, .025, doorLength, x, doorY + .006, doorZ);
        box(fittings, trim, .014, .012, doorLength - .05, x - s * .04, doorY - .025, doorZ);
        rod(fittings, headliner, [x, top[1], -.45], top, .008, 4);
      }
      // Passenger-side painted return where the door top meets the dash. The
      // distant door itself is mostly occluded from the left-hand driving seat.
      box(fittings, bodyPaint || accent, .16, .025, .20, -d * .98, -drop + .018, d);
      rod(fittings, headliner, leftTop, rightTop, .012, 4);
      // Small mirror just right of the driver, well above the road horizon.
      box(fittings, dark, .095, .027, .018, -.18, .35, .72);
      box(fittings, trim, .083, .019, .003, -.18, .35, .709);
      rod(fittings, headliner, [-.18, .365, .73], [-.18, .40, .75], .005, 4);
      box(fittings, lower, .22, .20, .60, cx, -drop - .24, .24);
      rod(fittings, trim, [cx, -drop - .15, .24], [cx, -drop - .025, .30], .012, 5);
      box(fittings, rubber, .05, .04, .055, cx, -drop - .01, .30);
      for (const x of [cx - .12, cx + .12]) box(fittings, rubber, .14, .035, .012, x, -drop - .055, d - .108);
    } else {
      for (const s of [-1, 1]) box(fittings, dark, .055, .18, .65, s * w, -.24, .12);
    }
    if (type === 'rally') {
      // Cage follows the cabin perimeter, leaving the road and both gauges clear.
      for (const s of [-1, 1]) {
        const x = cx + s * w * .90;
        rod(fittings, trim, [x, -.45, -.55], [x, .08, -.55], .025, 4);
        rod(fittings, trim, [x, .08, -.55], [x, .08, .08], .025, 4);
        rod(fittings, trim, [x, .08, .08], [x, -.25, .68], .025, 4);
        rod(fittings, trim, [x, -.45, -.55], [x, -.25, .48], .022, 4);
        box(fittings, dark, .07, .30, .42, s * .24, -.29, -.25);
      }
      rod(fittings, trim, [cx - w * .90, .08, -.55], [cx + w * .90, .08, -.55], .025, 4);
    }
  } else {
    // Keep the real tank, forks, mudguard and turning handlebars. The extra instruments and
    // mirrors are attached to the existing bar pivot, so their steering is identical.
    controls.position.copy(ud.bars.position); controls.quaternion.copy(ud.bars.quaternion);
    const y = sport ? eye.y - .27 : .13, z = sport ? -.16 : .015;
    box(controls, dark, sport ? .16 : .20, sport ? .06 : .09, .045, 0, y, z);
    // Faces incline toward the rider; gauge assembly lives in the steering group's frame.
    const panel = new THREE.Group(); panel.position.set(0, y + (sport ? .005 : .035), z - .027); panel.rotation.x = -.55;
    controls.add(panel);
    dial(panel, 0, 0, 0, sport ? .042 : .052);
    const needle = needles[0]; group.remove(needle);
    for (const s of sport ? [] : [-1, 1]) {
      rod(controls, trim, [s * .27, y - .015, z], [s * .39, y + .20, z + .07], .009, 4);
      box(controls, rubber, .105, .05, .025, s * .40, y + .20, z + .07);
      box(controls, trim, .085, .035, .005, s * .40, y + .20, z + .049);
    }
    batch(panel); panel.add(needle);
    if (sport) {
      // A single open sheet, not the exterior's opaque closed glass hull. Its top
      // stays below the road sightline; the road also remains visible through it.
      const screen = mesh(group, new THREE.PlaneGeometry(.30, .11),
        new THREE.MeshLambertMaterial({ color: '#88aebc', transparent: true, opacity: .25,
          depthWrite: false, side: THREE.DoubleSide }), 0, eye.y - .29, eye.z + .45);
      screen.rotation.x = -.45; screen.name = 'interior-windscreen';
    }
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
      const pitch = bike ? (sport ? .15 : .32) : 0;
      look.set(0, -Math.sin(pitch), Math.cos(pitch)).transformDirection(mount.matrixWorld).add(camera.position);
      up.set(0, 1, 0).transformDirection(mount.matrixWorld); camera.up.copy(up); camera.lookAt(look);
    },
  };
  model.userData.interior = interior;
  return interior;
}
