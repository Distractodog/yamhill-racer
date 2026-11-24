import { addCockpit } from './cockpit.js';
// SR-71 at 0.6 scale: 19.6 m long, 10.14 m span. +z nose, +x left wing.
// Static pieces are merged by paint role; moving parts share the Jet.syncMesh contract.
import * as THREE from 'three';
import { speedBrakePanels } from '../speedbrakes.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const BLACKBIRD_AIRFRAME = {
  gear: [[0, 6], [2.2, -1.5], [-2.2, -1.5]], gearH: 1.8, wb: 7.5, poseK: 1.5 / 7.5,
  body: [[0, 0, 11.5], [0, .05, -8.1], [5.07, 0, -5.4], [-5.07, 0, -5.4],
    [3.1, -.65, 2.8], [-3.1, -.65, 2.8], [3.1, -.65, -7.7], [-3.1, -.65, -7.7],
    [2.4, 2.4, -6.5], [-2.4, 2.4, -6.5]],
  half: { x: 5.07, front: 11.5, back: -8.1 }, rotMax: .18, scrapeZ: -6,
  treeR: 1.5, treeZ: [-7, -4, -1, 2, 5, 8, 10], wing: 5.07, authV: 110,
  eye: [.98, 7.1], buildingR: 5.07, maxStepDistance: 2,
};

export function buildBlackbirdModel() {
  const root = new THREE.Group(); root.name = 'jet-blackbird';
  const mat = (color, role) => {
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    if (role) m.userData.cosmeticRole = role;
    return m;
  };
  const body = mat('#16181c', 'body'), trim = mat('#2c3036', 'trim');
  const dark = mat('#161c23'), glass = mat('#485562'), metal = mat('#889099', 'wheels');
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
  const cockpitHull = hull(root, body, [[11.5,.025,-.015,.015],[9.2,.38,-.23,.24],
    [6.3,.66,-.46,.48],[2.8,.85,-.55,.52],[-3.5,.9,-.5,.45],[-7.4,.55,-.22,.18],[-8.1,.03,-.02,.02]]);
  // Continuous flat chines widen the long nose into the delta wing.
  for (const side of [-1, 1]) {
    const ps = points => points.map(([x,z]) => [side*x,z]);
    plate(root, body, ps([[.02,11.4],[.7,7.8],[1.3,3.8],[5.07,-5.4],[4.5,-6.5],[.5,-7.5]]), .10);
    plate(root, trim, ps([[.7,7.8],[1.3,3.8],[4.92,-5.1],[4.8,-5.1],[1.2,3.7]]), .115);
  }
  const cockpitRim = hull(root, trim, [[8.65,.12,0,.04],[7.6,.49,0,.58],[5.3,.48,0,.58],[4.7,.14,0,.04]]);
  cockpitRim.position.y = .42;
  // Two separate glazing humps with a solid divider: front pilot, rear reconnaissance officer.
  const canopy = pivot();
  for (const z of [0, -1.55]) {
    const pane = hull(canopy, glass, [[8.45+z,.12,0,.10],[7.65+z,.43,0,.64],[7.0+z,.39,0,.59],[6.95+z,.38,0,.05]]);
    pane.position.y = .44;
  }
  const elevator = pivot(0, 0, -6.4), rudder = pivot();
  const aileronL = pivot(4.3, 0, -5.7), aileronR = pivot(-4.3, 0, -5.7);
  const rudders = [];
  for (const s of [-1, 1]) {
    const points = ps => ps.map(([x,z]) => [s*x,z]);
    plate(elevator, body, points([[.6,0],[2.3,.3],[2.3,-.55],[.6,-.85]]), .09);
    plate(s > 0 ? aileronL : aileronR, body, points([[-.35,0],[.68,.2],[.25,-.7],[-.35,-.7]]), .09);
    // Eight-sided nacelles, black intake mouths and long pointed inlet spikes.
    const tube = (front, back, length, material, z) => add(root,
      new THREE.CylinderGeometry(front, back, length, 8).rotateX(Math.PI/2), material, s*3.1, 0, z);
    tube(.66,.74,7.8,body,-1.8);
    tube(.68,.66,.22,trim,2.2);
    tube(.58,.58,.025,dark,2.322);
    add(root, new THREE.ConeGeometry(.36,2.15,8).rotateX(Math.PI/2), trim, s*3.1, 0, 3.25);
    tube(.74,.54,1.5,trim,-6.45);
    tube(.49,.49,.035,dark,-7.22);
    // The entire fin turns; inward cant is on a parent so yaw never erases it.
    const cant = pivot(s*3.1,.45,-4.9); cant.rotation.z = s*.28;
    const fin = pivot(0,0,0,cant); rudders.push(fin);
    const finGeo = new THREE.ExtrudeGeometry(new THREE.Shape([
      [.3,0],[-2.4,0],[-2.05,2.1],[-1.15,2.1],
    ].map(([z,y]) => new THREE.Vector2(z,y))), { depth: .09, bevelEnabled: false }).rotateY(-Math.PI/2).translate(.045,0,0);
    add(fin, finGeo, body);
    // Restrained white/red fin stripes, offset above each fin's face to avoid z-fighting.
    box(fin, mat('#d7d9dc'), .10,.12,.7,0,1.55,-1.55);
    box(fin, mat('#b53232'), .102,.08,.7,0,1.35,-1.55);
  }
  const flameMaterial = new THREE.MeshBasicMaterial({ color: '#ff9a48', transparent: true, opacity: .6,
    depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const flames = [-1,1].map(s => {
    const g = new THREE.ConeGeometry(.48, 2.5, 6, 1, true).rotateY(Math.PI/4).rotateX(-Math.PI/2);
    return g.translate(s*3.1, 0, -1.25);
  });
  const flame = add(root, mergeGeometries(flames), flameMaterial, 0, 0, -7.25);
  flames.forEach(g => g.dispose()); flame.castShadow = false; flame.visible = false;
  const wheels = [];
  for (const [i, [x,z]] of BLACKBIRD_AIRFRAME.gear.entries()) {
    const leg = pivot(x, -.5, z);
    box(leg, metal, .09, .95, .09, 0, -.48, 0);
    const holder = pivot(0, -.95, 0, leg), spin = pivot(0,0,0,holder);
    add(spin, new THREE.CylinderGeometry(.35,.35,.25,10).rotateZ(Math.PI/2), dark);
    add(spin, new THREE.CylinderGeometry(.16,.16,.26,8).rotateZ(Math.PI/2), metal);
    wheels.push({ leg, holder, spin, r: .35, front: i === 0 });
  }
  const setGear = k => { for (const w of wheels) { w.leg.scale.y = Math.max(.05,k); w.leg.visible = k > .06; } };
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
    for (const m of [...group.children]) if (m.isMesh && m !== canopy && m !== flame && m !== cockpitHull && m !== cockpitRim) {
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
    x: s * .65, y: .50, z: -3.9, w: .55, d: 1.5, axis: 'z', side: -s, angle: -s * 1.15,
  })));
  root.userData = { setSpeedBrake, wheels, noseWheel: wheels[0].holder, setGear, flame, elevator, rudder, aileronL, aileronR,
    canopy, wreck, wreckMats, wreckColor, blob: [10.14,19.6],
    decalPanels: [[.8,.6,4.1,.065,-4.9,-Math.PI/2],[.8,.6,-4.1,.065,-4.9,-Math.PI/2]],
    lights: { head: [], tail: [], nav: {
      left: new THREE.Vector3(5.03,.1,-5.4), right: new THREE.Vector3(-5.03,.1,-5.4),
      tail: new THREE.Vector3(0,.1,-8.05), strobe: new THREE.Vector3(0,.6,-1),
    } },
    animate(vehicle) {
      const J = vehicle.input?.jet;
      rudder.rotation.y = 0;
      for (const p of rudders) p.rotation.y = -(J?.yaw || 0)*.4;
      for (let i = 0; i < wheels.length; i++) wheels[i].spin.rotation.x = vehicle.wheels[i].spin;
    },
  };
  addCockpit(root, { style: 'blackbird', eye: BLACKBIRD_AIRFRAME.eye, width: .48, depth: .8, blockers: [cockpitHull, cockpitRim] });
  return root;
}
