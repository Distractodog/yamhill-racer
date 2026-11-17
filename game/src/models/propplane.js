// Prop plane (a Cessna 172-style trainer): high wing on struts, fixed tricycle gear with wheel pants, big cabin
// windows, a two-blade propeller. Flown by jet.js with PROP_AIRFRAME (vehicletypes.js type 'prop').
import * as THREE from 'three';
import { speedBrakePanels } from '../speedbrakes.js';
import { material, put, pivot, batch, loft, ribbon, plate, fin, mirrorX, rod, wingPair, wheel, pant, propeller } from './planekit.js';

// Geometry the physics needs (jet.js FIGHTER_AIRFRAME keys); matches the model below.
export const PROP_AIRFRAME = {
  gear: [[0, 2.55], [1.25, -0.35], [-1.25, -0.35]], gearH: 1.35, wb: 2.9, poseK: 0.35 / 2.9, rotMax: 0.2,
  body: [[0, -0.1, 4.25], [0, 0.2, -4.75], [5.55, 1.05, 0.6], [-5.55, 1.05, 0.6], [0, 1.75, -4.6]],
  half: { x: 5.5, front: 4.25, back: -4.8 }, scrapeZ: -4, treeR: 1, treeZ: [-3.5, 0, 3], wing: 4.5, authV: 35,
  fixedGear: true, coord: true, airKmh: 210, radius: 0.28, prop: 1, eye: [0.72, 0.55],
};

const WRECK = 0x3a3a3a;
const BODY = [  // fuselage below the cabin windows: [z, half width, bottom, top]
  [3.78, 0.36, -0.36, 0.22], [3.3, 0.5, -0.52, 0.36], [2.2, 0.57, -0.6, 0.42], [1.35, 0.6, -0.62, 0.3],
  [-0.6, 0.6, -0.6, 0.3], [-1.9, 0.46, -0.42, 0.66], [-3.6, 0.2, -0.05, 0.5], [-4.75, 0.08, 0.15, 0.4],
];
// cabin glass: a slightly narrower tube rising out of the body (big windows all round, framed by the posts)
const CABIN = [[2.2, 0.53, -0.3, 0.4], [1.35, 0.58, -0.3, 0.97], [-0.6, 0.58, -0.3, 0.97], [-1.95, 0.42, -0.2, 0.62]];
const BOX = 0.75;     // loft sides: a boxy cabin

export function buildPropPlaneModel() {
  const root = new THREE.Group(); root.name = 'jet-prop';
  const white = material(0xf3f3ef, 'body'), stripe = material(0x1f5fae, 'trim'), dark = material(0x2a2e36), metal = material(0x9aa0a8);
  const glass = material(0x24425a, null, { emissive: 0x0a1a28 }), tyre = material(0x1d1e22);
  // fuselage, cabin glass, cheat line and the window frames
  put(root, loft(BODY, BOX), white);
  const canopy = put(root, loft(CABIN, BOX), glass);
  put(root, ribbon(BODY, 0.05, 0.07, 0, 6, BOX), stripe);
  put(root, ribbon(BODY, -0.3, 0.035, 0, 6, BOX), stripe);
  for (const z of [1.33, 0.35, -0.62]) for (const s of [1, -1]) put(root, new THREE.BoxGeometry(0.05, 0.72, 0.09), white, s * 0.6, 0.62, z);
  put(root, new THREE.BoxGeometry(1.1, 0.06, 0.12), white, 0, 0.97, 1.36);              // windscreen top frame
  put(root, new THREE.BoxGeometry(0.62, 0.1, 0.5), dark, 0, -0.38, 3.82);                 // air intake under the spinner
  put(root, new THREE.BoxGeometry(0.08, 0.06, 0.6), dark, 0.22, -0.58, 2.6);             // exhaust stub
  // high wing: constant-chord inner panel, slight taper outboard; flaps inboard, ailerons outboard
  const WING = [[0, 1.42], [2.7, 1.42], [5.42, 1.3], [5.55, 1.15], [5.55, 0.12], [2.75, 0.12], [2.75, -0.2], [0, -0.2]];
  wingPair(root, white, WING, 0.17, 1.06, 0.025);
  for (const s of [1, -1]) {
    const tip = put(root, new THREE.BoxGeometry(0.14, 0.19, 1.25), stripe, s * 5.6, 1.06 + 5.6 * 0.025, 0.73);  // painted tips
    tip.rotation.z = s * 0.025;
    // struts: fuselage bottom to the wing, a jury strut half way
    rod(root, metal, [s * 0.52, -0.42, 0.35], [s * 3.25, 0.98 + 3.25 * 0.025, 0.62], 0.045);
    rod(root, metal, [s * 1.9, 0.29, 0.5], [s * 1.9, 0.98 + 1.9 * 0.025, 0.55], 0.025);
  }
  const aileronL = pivot(root, 4.15, 1.06 + 4.15 * 0.025, 0.12), aileronR = pivot(root, -4.15, 1.06 + 4.15 * 0.025, 0.12);
  aileronL.rotation.z = 0.025; aileronR.rotation.z = -0.025;
  for (const a of [aileronL, aileronR]) put(a, new THREE.BoxGeometry(2.7, 0.08, 0.3), white, 0, 0, -0.15);
  // tail: tailplane + elevator, swept fin + rudder, dorsal fillet
  const TP = [[0.05, -3.75], [1.75, -4.02], [1.75, -4.42], [0.05, -4.42]];
  put(root, plate(TP, 0.08), white, 0, 0.28, 0); put(root, mirrorX(plate(TP, 0.08)), white, 0, 0.28, 0);
  const elevator = pivot(root, 0, 0.28, -4.42);
  put(elevator, new THREE.BoxGeometry(3.5, 0.06, 0.36), white, 0, 0, -0.18);
  put(root, fin([[-2.7, 0.45], [-3.7, 0.75], [-4.4, 1.8], [-4.78, 1.8], [-4.72, 0.35]], 0.1), white);
  put(root, fin([[-4.25, 1.4], [-4.53, 1.8], [-4.78, 1.8], [-4.75, 1.4]], 0.12), stripe);       // painted fin top
  const rudder = pivot(root, 0, 0.42, -4.76);
  put(rudder, new THREE.BoxGeometry(0.08, 1.38, 0.34), white, 0, 0.69, -0.16);
  put(rudder, new THREE.BoxGeometry(0.09, 0.32, 0.35), stripe, 0, 1.22, -0.16);
  // propeller (two blades, painted tips) on the cowl
  const prop = propeller(root, { y: -0.07, z: 3.82, radius: 0.95, blades: 2, chord: 0.13, blade: dark, tip: stripe, spinner: stripe, spinnerR: 0.17, spinnerL: 0.38, idle: 14, max: 92 });
  // fixed tricycle gear: physics wheel order (nose, left main, right main)
  const wheels = [], r = 0.28;
  for (const [i, [x, z]] of PROP_AIRFRAME.gear.entries()) {
    const y = -PROP_AIRFRAME.gearH + r;
    if (i === 0) rod(root, metal, [0, -0.55, z + 0.05], [0, y + 0.1, z], 0.05);
    else rod(root, metal, [Math.sign(x) * 0.5, -0.55, z + 0.05], [x, y + 0.05, z], 0.05);
    const w = wheel(root, tyre, metal, x, y, z, r, 0.16, i === 0);
    pant(w.holder, white, r, 0.16);
    wheels.push(w);
  }
  // Navigation lights on the tips, white tail light, strobe on the fin
  const lights = { head: [], tail: [], nav: {
    left: new THREE.Vector3(5.7, 1.2, 0.8), right: new THREE.Vector3(-5.7, 1.2, 0.8),
    tail: new THREE.Vector3(0, 0.62, -5.12), strobe: new THREE.Vector3(0, 1.88, -4.6),
  } };
  // wreck: blackened, crumpled, canopy gone, controls and propeller bent (kept attached)
  const mats = [white, stripe];
  let wrecked = false, base = [];          // paint is snapshotted on entering the wreck (Garage colours), restored on leaving
  const wreck = on => {
    if (on && !wrecked) base = mats.map(m => m.color.getHex());
    if (on || wrecked) mats.forEach((m, i) => m.color.setHex(on ? WRECK : base[i]));
    wrecked = on;
    root.scale.set(on ? 1.12 : 1, on ? 0.65 : 1, on ? 0.8 : 1);
    canopy.visible = !on;
    elevator.rotation.z = on ? 0.6 : 0; rudder.rotation.z = on ? -0.7 : 0;
    aileronL.rotation.y = on ? 0.5 : 0; aileronR.rotation.y = on ? -0.3 : 0;
    prop.blades.rotation.x = on ? 0.6 : 0;
  };
  const deck = 1.06 + 0.085;   // wing top
  batch(root, new Set([canopy]));
  const setSpeedBrake = speedBrakePanels(root, stripe, [-1, 1].map(s => ({ x: s * 2.7, y: 1.23, z: .35, w: 1.7, d: .48 })));
  root.userData = { setSpeedBrake,
    wheels, setGear: () => {}, noseWheel: wheels[0].holder, elevator, rudder, aileronL, aileronR, wreck, canopy, propeller: prop,
    wreckMats: mats, wreckColor: WRECK, blob: [11.2, 8.6], lights,
    // Garage liveries / scuffs on top of the wings (cosmetics.js)
    decalSpots: [[1.3, 1.05, 3.6, deck + 3.6 * 0.025 + 0.01, 0.55, -Math.PI / 2], [1.3, 1.05, -3.6, deck + 3.6 * 0.025 + 0.01, 0.55, -Math.PI / 2]],
    animate(v, dt) {
      prop.spin(v, dt);
      v.wheels?.forEach((wh, i) => { if (wheels[i]) wheels[i].spin.rotation.x = wh.spin; });
    },
  };
  return root;
}
