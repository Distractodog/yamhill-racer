// Tracked armour on the car's four suspension contacts. No weapons logic lives here.
import * as THREE from 'three';
import { WHEEL_POS } from '../carmodel.js';
import { measureWheelArch } from '../wheeltravel.js';
import { buildWheels } from './shapedbody.js';
import { material, mesh, box, rod, hull, lod, batch } from './truckbikeparts.js';

export function buildTankModel(type, p, suspension) {
  const root = new THREE.Group(); root.name = `car-${type}`;
  const bodyPivot = new THREE.Group(); root.add(bodyPivot);
  const body = material('#5b6540', 'body'), trim = material('#3a3f2c', 'trim');
  const rim = material('#3a3f2c', 'wheels'), rubber = material('#242623'), steel = material('#45483e');
  const glass = material('#233b3b'), head = material('#e1dfc4'), tail = material('#a3221c');
  const wheels = buildWheels(root, WHEEL_POS, p, suspension, rubber, rim,
    { width: .42, rimR: .36, spokes: 8, segs: 12, spokeW: .045 });
  for (const w of wheels) {
    w.spin.children[1].geometry.dispose();
    w.spin.children[1].geometry = new THREE.CylinderGeometry(.36, .36, .435, 12).rotateZ(Math.PI / 2);
  }
  // Tracks are running gear: attach to suspension holders, outside their spin pivots.
  // This also keeps road-contact treads out of the armoured body's clearance/dent buffers.
  const tracks = [0, 1].map(i => {
    const holder = wheels[i + 2].holder, track = new THREE.Group();
    track.position.copy(holder.position).negate(); holder.add(track); return track;
  });
  const rollers = [];
  for (const side of [-1, 1]) for (const z of [-1.45, -.48, .49, 1.46]) {
    const holder = new THREE.Group(); holder.position.set(side * 1.617, -.25, z); tracks[side > 0 ? 0 : 1].add(holder);
    mesh(holder, new THREE.CylinderGeometry(.43, .43, .42, 12).rotateZ(Math.PI / 2), rubber);
    mesh(holder, new THREE.CylinderGeometry(.33, .33, .44, 10).rotateZ(Math.PI / 2), rim);
    for (const y of [-.20, .20]) box(holder, steel, .455, .06, .08, 0, y, .10);
    batch(holder); rollers.push(holder);
  }
  function shell(far) {
    const group = new THREE.Group(); group.name = far ? 'body-far' : 'body-near';
    const armour = hull(group, body, [[3.05, 1.32, -.20, .10, 1.20], [1.75, 1.4, -.25, .70, 1.30], [.75, 1.4, -.25, .70, 1.30],
      [-.25, 1.4, -.25, .70, 1.30], [-1.25, 1.4, -.25, .70, 1.30], [-2.8, 1.4, -.25, .70, 1.30]]);
    // Centre vertices let broad armour plates dent locally, including the hull roof.
    const points = armour.geometry.attributes.position, triangles = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < points.count; i += 3) {
      a.fromBufferAttribute(points, i); b.fromBufferAttribute(points, i + 1); c.fromBufferAttribute(points, i + 2);
      const ab = a.clone().add(b).multiplyScalar(.5), bc = b.clone().add(c).multiplyScalar(.5), ca = c.clone().add(a).multiplyScalar(.5);
      for (const v of [a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca]) triangles.push(v.x, v.y, v.z);
    }
    armour.geometry.dispose();
    armour.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
    armour.geometry.computeVertexNormals();
    for (const side of [-1, 1]) {
      // Skirts hide the upper track run; an open belt leaves the road wheels visible.
      box(group, body, .68, .10, 5.75, side * 1.62, .69, .02);
      box(group, body, .13, .58, 5.75, side * 1.91, .35, .02);
      if (!far) {
        const track = tracks[side > 0 ? 0 : 1];
        const outline = [[-2.52, -.78], [2.52, -.78], [3.02, -.40], [3.02, -.02],
          [2.52, .35], [-2.52, .35], [-3.02, -.02], [-3.02, -.40]];
        const inside = [[-2.49, -.68], [2.49, -.68], [2.91, -.36], [2.91, -.06],
          [2.49, .25], [-2.49, .25], [-2.91, -.06], [-2.91, -.36]];
        const beltShape = new THREE.Shape(outline.map(([z, y]) => new THREE.Vector2(-z, y)));
        beltShape.holes.push(new THREE.Path(inside.reverse().map(([z, y]) => new THREE.Vector2(-z, y))));
        const beltGeometry = new THREE.ExtrudeGeometry(beltShape, { depth: .56, steps: 1, bevelEnabled: false });
        beltGeometry.rotateY(Math.PI / 2);
        mesh(track, beltGeometry, rubber, side * 1.617 - .28);
        for (const z of [-2.65, 2.65])
          mesh(track, new THREE.CylinderGeometry(.29, .29, .43, 12).rotateZ(Math.PI / 2), trim,
            side * 1.617, -.215, z);
        for (let z = -2.3; z <= 2.3; z += .28) {
          box(track, steel, .58, .025, .08, side * 1.617, -.66, z);
        }
        batch(track);
      }
      if (!far) for (let z = -2.3; z <= 2.3; z += .28)
        box(group, trim, .02, .49, .035, side * 1.982, .35, z);
      box(group, trim, .24, .21, .12, side * 1.05, .265, 2.83);
      box(group, head, .18, .13, .08, side * 1.05, .30, 2.86);
      box(group, tail, .16, .13, .08, side * 1.30, .38, -2.85);
    }
    if (!far) {
      for (let z = -2.55; z < -1.4; z += .15) box(group, trim, 1.5, .035, .06, 0, .725, z);
      box(group, glass, .48, .09, .04, .56, .73, 1.44);
      for (const side of [-1, 1]) rod(group, steel, [side * 1.1, .16, 2.96], [side * 1.1, .38, 2.86], .05);
    }
    return group;
  }
  lod(bodyPivot, shell(false), shell(true), 70);
  const turret = new THREE.Group(); turret.name = 'tank-turret'; turret.position.set(0, .73, -.32); bodyPivot.add(turret);
  function turretShell(far) {
    const group = new THREE.Group();
    mesh(group, new THREE.CylinderGeometry(.95, 1.03, .16, 12), trim, 0, .02, 0);
    hull(group, body, [[1.30, .83, .08, .42, .64], [.60, 1.16, .08, .82, .85], [-1.5, 1.13, .08, .73, 1.0]]);
    box(group, trim, 1.55, .35, .50, 0, .37, -1.65);
    mesh(group, new THREE.CylinderGeometry(.38, .40, .12, 10), trim, .46, .87, -.35);
    box(group, body, .55, .09, .57, .46, .96, -.35);
    box(group, glass, .36, .08, .05, .46, .90, -.03);
    if (!far) {
      for (const side of [-1, 1]) for (let i = 0; i < 4; i++)
        rod(group, trim, [side * 1.05, .35, .15 - i * .18], [side * 1.27, .55, .33 - i * .18], .075);
      rod(group, steel, [-.85, .65, -1.10], [-.85, 1.65, -1.10], .015, 4);
    }
    return group;
  }
  lod(turret, turretShell(false), turretShell(true), 70);
  const barrel = new THREE.Group(); barrel.name = 'tank-barrel'; barrel.position.set(0, .43, 1.04); turret.add(barrel);
  box(barrel, body, .60, .40, .57, 0, 0, .08);
  rod(barrel, body, [0, 0, .25], [0, 0, 4.6], .095, 8);
  rod(barrel, trim, [0, 0, 1.5], [0, 0, 2.08], .15, 8);
  rod(barrel, steel, [0, 0, 4.55], [0, 0, 4.67], .115, 8);
  mesh(barrel, new THREE.CircleGeometry(.082, 8), rubber, 0, 0, 4.675);
  batch(barrel);
  const muzzle = new THREE.Object3D(); muzzle.name = 'tank-muzzle'; muzzle.position.z = 4.68; barrel.add(muzzle);
  root.userData = { bodyPivot, turret, barrel, muzzle, wheels, lightMount: bodyPivot,
    blob: [3.95, 6.1], lights: { head: [-1, 1].map(s => new THREE.Vector3(s * 1.05, .30, 2.91)),
      tail: [-1, 1].map(s => new THREE.Vector3(s * 1.3, .38, -2.90)) },
    linkage: { update() {
      for (const w of wheels) w.holder.rotation.y = 0;
      for (let i = 0; i < rollers.length; i++) rollers[i].rotation.x = wheels[i < 4 ? 1 : 0].spin.rotation.x;
    } } };
  root.userData.wheelArch = measureWheelArch(root);
  return root;
}
