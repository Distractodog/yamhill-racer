// Compact stealth airframe in the jet's collision envelope: +z nose, +x left wing.
// Static pieces are merged by paint role; moving parts share the Jet.syncMesh contract.
import * as THREE from 'three';
import { speedBrakePanels } from '../speedbrakes.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function buildStealthModel() {
  const root = new THREE.Group(); root.name = 'jet-stealth';
  const mat = (color, role) => {
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    if (role) m.userData.cosmeticRole = role;
    return m;
  };
  const body = mat('#424a53', 'body'), trim = mat('#727b83', 'trim');
  const dark = mat('#161c23'), glass = mat('#574d35'), metal = mat('#889099', 'wheels');
  const add = (parent, geometry, material, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z);
    m.castShadow = true; parent.add(m); return m;
  };
  const box = (p, m, w, h, d, x, y, z) => add(p, new THREE.BoxGeometry(w, h, d), m, x, y, z);
  const pivot = (x = 0, y = 0, z = 0, parent = root) => {
    const p = new THREE.Group(); p.position.set(x, y, z); parent.add(p); return p;
  };
  // Six-sided sections: the lateral chine stays sharp from the pointed nose to the engines.
  const hull = (parent, material, sections) => {
    const rings = sections.map(([z, w, low, high]) => [
      [-w, 0, z], [-w * .58, low, z], [w * .58, low, z],
      [w, 0, z], [w * .48, high, z], [-w * .48, high, z],
    ]);
    const positions = [], tri = (a, b, c) => positions.push(...a, ...b, ...c);
    for (let i = 1; i < rings.length; i++) for (let k = 0; k < 6; k++) {
      const a = rings[i-1][k], b = rings[i-1][(k+1)%6], c = rings[i][(k+1)%6], d = rings[i][k];
      tri(a, c, b); tri(a, d, c);
    }
    for (let i = 1; i < 5; i++) { tri(rings[0][0], rings[0][i], rings[0][i+1]); tri(rings.at(-1)[0], rings.at(-1)[i+1], rings.at(-1)[i]); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.computeVertexNormals();
    return add(parent, g, material);
  };
  const plate = (parent, material, points, thickness = .10) => {
    // Shape's second coordinate becomes +z after rotation.
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 1 });
    g.rotateX(Math.PI / 2).translate(0, thickness / 2, 0);
    return add(parent, g, material);
  };
  hull(root, body, [[6.6,.035,-.02,.025],[4.3,.66,-.30,.34],[1.8,1.35,-.55,.55],[-1.7,1.70,-.52,.60],[-4.7,1.56,-.34,.36],[-5.4,1.38,-.23,.22]]);
  // Gold smoked, faceted canopy and its raised rim.
  hull(root, trim, [[4.05,.16,0,.04],[2.85,.55,0,.57],[1.25,.50,0,.44],[.7,.16,0,.04]]).position.y = .34;
  const canopy = hull(root, glass, [[3.95,.12,.035,.06],[2.85,.49,.05,.61],[1.30,.44,.05,.48],[.82,.12,.035,.06]]);
  canopy.position.y = .34;
  const elevator = pivot(0, .05, -4.35), rudder = pivot();
  const aileronL = pivot(3.3, 0, -2.2), aileronR = pivot(-3.3, 0, -2.2);
  const rudders = [];
  for (const s of [-1, 1]) {
    const points = ps => ps.map(([x, z]) => [s*x, z]);
    plate(root, body, points([[.8,2.3],[4.9,-1.25],[3.9,-2.2],[1.05,-2.8]]));
    plate(root, trim, points([[1.1,2.06],[4.9,-1.25],[4.66,-1.38],[1.05,1.84]]), .115);
    plate(s > 0 ? aileronL : aileronR, body, points([[-.95,0],[.60,0],[.20,-.65],[-1.35,-.40]]), .075);
    plate(elevator, body, points([[1.1,.50],[3.1,-.55],[2.45,-1.65],[1.2,-1.2]]), .09);
    // Shoulder intakes with inset dark mouths, no external stores.
    const intake = pivot(s*1.14, -.12, 1.25);
    hull(intake, trim, [[1.05,.36,-.35,.19],[.75,.45,-.38,.21],[-1.8,.42,-.30,.20]]);
    const mouth = box(intake, dark, .54, .43, .035, 0, -.06, 1.07); mouth.rotation.z = s*.12;
    // Twin outward-canted fins: their rudders rotate about each fin's own hinge.
    const fin = pivot(s*1.32, .24, -3.45); fin.rotation.z = -s*.39;
    const finGeo = new THREE.ExtrudeGeometry(new THREE.Shape([
      [0,.0],[-1.65,0],[-1.8,2.25],[-.95,2.25],
    ].map(([z,y]) => new THREE.Vector2(z,y))), { depth: .09, bevelEnabled: false }).rotateY(-Math.PI/2).translate(.045,0,0);
    add(fin, finGeo, body);
    const hinge = pivot(0, .1, -1.65, fin); rudders.push(hinge);
    box(hinge, trim, .095, 1.82, .27, 0, .91, -.12);
    // Broad rectangular exhausts, with upper/lower serrated-looking petals.
    box(root, dark, 1.04, .46, .70, s*.73, -.02, -5.28);
    for (const y of [-.27,.23]) box(root, trim, 1.12, .055, .80, s*.73, y, -5.28);
    // Flush bay covers and angular edges on the belly.
    plate(root, dark, points([[.12,1.55],[.75,1.15],[.9,-1.5],[.55,-2.0],[.12,-1.6]]), .025).position.y = -.535;
    plate(root, body, points([[.18,1.4],[.69,1.06],[.83,-1.45],[.53,-1.88],[.18,-1.52]]), .025).position.y = -.55;
  }
  const flameMaterial = new THREE.MeshBasicMaterial({ color: '#ff9a48', transparent: true, opacity: .6,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const flames = [-1,1].map(s => {
    const g = new THREE.ConeGeometry(.42, 2, 4, 1, true).rotateY(Math.PI/4).rotateX(-Math.PI/2);
    return g.scale(1.2,.45,1).translate(s*.73, -.02, -1);
  });
  const flame = add(root, mergeGeometries(flames), flameMaterial, 0, 0, -5.65);
  flames.forEach(g => g.dispose()); flame.castShadow = false; flame.visible = false;
  const wheels = [];
  for (const [i, [x,z]] of [[0,3.6],[1.4,-.8],[-1.4,-.8]].entries()) {
    const leg = pivot(x, -.3, z);
    box(leg, metal, .09, .95, .09, 0, -.48, 0);
    const holder = pivot(0, -.95, 0, leg), spin = pivot(0,0,0,holder);
    add(spin, new THREE.CylinderGeometry(.35,.35,.25,10).rotateZ(Math.PI/2), dark);
    add(spin, new THREE.CylinderGeometry(.16,.16,.26,8).rotateZ(Math.PI/2), metal);
    wheels.push({ leg, holder, spin, r: .35, front: i === 0 });
  }
  const setGear = k => { for (const w of wheels) { w.leg.scale.y = Math.max(.05,k); w.leg.visible = k > .06; } };
  box(root, mat('#fff2c9'), .16, .03, .1, 0, -.33, 4.15);       // landing light under the nose
  const wreckMats = [body,trim], wreckColor = 0x292b2f;
  let wrecked = false, paint = [];
  const wreck = on => {
    if (on && !wrecked) paint = wreckMats.map(m => m.color.getHex());
    if (on || wrecked) wreckMats.forEach((m,i) => m.color.setHex(on ? wreckColor : paint[i]));
    wrecked = on; canopy.visible = !on; flame.visible = !on;
    root.scale.set(on ? 1.15 : 1, on ? .65 : 1, on ? .78 : 1);
    elevator.rotation.z = on ? .65 : 0;
    aileronL.rotation.z = on ? .8 : 0; aileronR.rotation.z = on ? -.7 : 0;
  };
  // Batch static meshes within each pivot; keep canopy/flame and wheel mesh order for cosmetics.
  const groups = []; root.traverse(o => { if (o.isGroup) groups.push(o); });
  for (const group of groups) {
    if (wheels.some(w => w.spin === group)) continue;
    const batches = new Map();
    for (const m of [...group.children]) if (m.isMesh && m !== canopy && m !== flame) {
      m.updateMatrix();
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
      g.deleteAttribute('uv');
      if (!batches.has(m.material)) batches.set(m.material, []);
      batches.get(m.material).push(g); m.geometry.dispose(); group.remove(m);
    }
    for (const [material, parts] of batches) { add(group, mergeGeometries(parts), material); parts.forEach(g => g.dispose()); }
  }
  // Two dorsal bay doors hinge along the outside of the flat upper fuselage.
  const setSpeedBrake = speedBrakePanels(root, trim, [-1, 1].map(s => ({
    x: s * .72, y: .61, z: -1.9, w: .69, d: 1.5, axis: 'z', side: -s, angle: -s * 1.15,
  })));
  root.userData = { setSpeedBrake, wheels, noseWheel: wheels[0].holder, setGear, flame, elevator, rudder, aileronL, aileronR,
    canopy, wreck, wreckMats, wreckColor, blob: [9.8,13], landingLight: true,
    decalPanels: [[.9,.65,2.4,.065,-.9,-Math.PI/2],[.9,.65,-2.4,.065,-.9,-Math.PI/2]],
    lights: { head: [new THREE.Vector3(0,-.345,4.15)], tail: [],
      lens: { head: [[[-.08,-.345,4.1],[.08,-.345,4.1],[.08,-.345,4.2],[-.08,-.345,4.2]]] }, nav: {
      left: new THREE.Vector3(4.87,.1,-1.25), right: new THREE.Vector3(-4.87,.1,-1.25),
      tail: new THREE.Vector3(0,.1,-5.55), strobe: new THREE.Vector3(0,.65,-1),
    } },
    animate(vehicle) {
      const J = vehicle.input?.jet;
      rudder.rotation.y = 0;
      rudders.forEach(p => { p.rotation.y = -(J?.yaw || 0)*.4; });
      wheels.forEach((w,i) => { w.spin.rotation.x = vehicle.wheels[i].spin; });
    },
  };
  return root;
}
