// Stunt plane (an Extra 300-style aerobatic monoplane): low wing with sunburst stripes, bubble canopy, big
// three-blade propeller, fixed main gear in pants and a tail wheel. Flown by jet.js with STUNT_AIRFRAME
// (vehicletypes.js type 'stunt').
import * as THREE from 'three';
import { material, put, pivot, batch, loft, ribbon, plate, fin, mirrorX, rod, wingPair, wheel, pant, propeller } from './planekit.js';

// Geometry the physics needs (jet.js FIGHTER_AIRFRAME keys); matches the model below. Tail wheel first: it steers.
export const STUNT_AIRFRAME = {
  gear: [[0, -4.9, 0.335], [0.95, 0.9], [-0.95, 0.9]], gearH: 1.45, tail: 0.19, wb: 5.8, rotMax: 0.2,
  body: [[0, -0.02, 3.08], [0, 0.15, -4.95], [4.05, -0.3, 0.4], [-4.05, -0.3, 0.4], [0, 1.35, -4.6]],
  half: { x: 4.05, front: 3.08, back: -5 }, scrapeZ: -4, treeR: 0.9, treeZ: [-3.5, 0, 2.5], wing: 3.3, authV: 45,
  fixedGear: true, coord: true, airKmh: 330, radius: 0.28, prop: 1.4, eye: [0.78, -0.6],
};

const WRECK = 0x3a3a3a, K = 0.55, DIH = 0.02, WY = -0.36;
const BODY = [
  [2.62, 0.3, -0.3, 0.25], [2.2, 0.44, -0.42, 0.38], [1.0, 0.48, -0.5, 0.46], [-0.4, 0.46, -0.48, 0.46],
  [-1.9, 0.36, -0.36, 0.42], [-3.5, 0.17, -0.12, 0.34], [-4.95, 0.06, 0.06, 0.28],
];
const BUBBLE = [[0.3, 0.08, 0.36, 0.42], [-0.2, 0.32, 0.3, 0.8], [-1.2, 0.34, 0.3, 0.88], [-2.0, 0.24, 0.3, 0.66], [-2.55, 0.06, 0.32, 0.42]];
const LE = x => 1.25 - 0.1175 * x;      // wing leading edge (z) at span x

export function buildStuntPlaneModel() {
  const root = new THREE.Group(); root.name = 'jet-stunt';
  const white = material(0xf4f2ec, 'body'), stripe = material(0xd8262e, 'trim'), dark = material(0x24272e), metal = material(0x9aa0a8);
  const glass = material(0x2a4a63, null, { emissive: 0x0b1c2a }), tyre = material(0x1d1e22), lamp = material(0xfff2c9, null, { emissive: 0x6a6040 });
  // fuselage, bubble canopy, bold side stripes
  put(root, loft(BODY, K), white);
  const canopy = put(root, loft(BUBBLE), glass);
  put(root, new THREE.BoxGeometry(0.66, 0.05, 0.06), dark, 0, 0.83, -1.0);                      // canopy bow
  put(root, ribbon(BODY, 0.1, 0.1, 0, 6, K), stripe);
  put(root, ribbon(BODY, -0.75, 0.03, 0, 5, K), stripe);
  put(root, new THREE.BoxGeometry(0.4, 0.1, 0.3), dark, 0, -0.32, 2.5);                          // cowl intake
  for (const s of [1, -1]) put(root, new THREE.BoxGeometry(0.06, 0.06, 0.4), dark, s * 0.2, -0.47, 1.9);   // exhausts
  // low wing; tips and sunburst stripes in the trim colour, top and bottom
  const WING = [[0, 1.25], [4.0, 0.78], [4.05, 0.7], [4.05, -0.2], [1.1, -0.2], [1.1, -0.62], [0, -0.62]];
  wingPair(root, white, WING, 0.2, WY, DIH);
  const sides = [];
  for (const s of [1, -1]) {
    const side = pivot(root, 0, WY, 0); side.rotation.z = s * DIH; sides.push(side);
    for (const x0 of [0.55, 1.55, 2.55]) {
      const x1 = Math.min(3.95, x0 + 1.4), x2 = Math.min(3.95, x0 + 1.85);
      const ray = [[x0, -0.17], [x0 + 0.45, -0.17], [x2, LE(x2) - 0.04], [x1, LE(x1) - 0.04]].map(([x, z]) => [s * x, z]);
      const g = plate(ray, 0.02);
      put(side, g, stripe, 0, 0.11, 0); put(side, g.clone(), stripe, 0, -0.11, 0);
    }
    put(side, new THREE.BoxGeometry(0.1, 0.22, 0.95), stripe, s * 4.1, 0, 0.27);                   // tip caps
  }
  const ay = WY + 2.575 * DIH;
  const aileronL = pivot(root, 2.575, ay, -0.2), aileronR = pivot(root, -2.575, ay, -0.2);
  aileronL.rotation.z = DIH; aileronR.rotation.z = -DIH;
  for (const a of [aileronL, aileronR]) put(a, new THREE.BoxGeometry(2.85, 0.1, 0.42), white, 0, 0, -0.21);
  // tail: tailplane + elevator (trim colour), fin with a stripe + rudder (trim colour)
  const TP = [[0.05, -3.95], [1.45, -4.15], [1.45, -4.45], [0.05, -4.45]];
  put(root, plate(TP, 0.07), white, 0, 0.14, 0); put(root, mirrorX(plate(TP, 0.07)), white, 0, 0.14, 0);
  const elevator = pivot(root, 0, 0.14, -4.45);
  put(elevator, new THREE.BoxGeometry(3.0, 0.06, 0.4), stripe, 0, 0, -0.2);
  put(root, fin([[-3.3, 0.32], [-4.3, 1.3], [-4.72, 1.32], [-4.75, 0.25]], 0.09), white);
  put(root, fin([[-3.75, 0.62], [-4.1, 1.0], [-4.74, 1.0], [-4.74, 0.62]], 0.11), stripe);
  const rudder = pivot(root, 0, 0.3, -4.75);
  put(rudder, new THREE.BoxGeometry(0.08, 1.05, 0.45), stripe, 0, 0.52, -0.22);
  // big three-blade propeller
  const prop = propeller(root, { y: -0.02, z: 2.66, radius: 1.0, blades: 3, chord: 0.16, blade: dark, tip: stripe, spinner: stripe, spinnerR: 0.2, spinnerL: 0.42, idle: 16, max: 110 });
  // gear: tail wheel (steers), left main, right main
  const wheels = [];
  for (const [i, [x, z, h = STUNT_AIRFRAME.gearH]] of STUNT_AIRFRAME.gear.entries()) {
    const r = i === 0 ? 0.1 : 0.28, y = -h + r;
    if (i === 0) rod(root, dark, [0, 0.05, -4.62], [0, y + 0.03, z], 0.03);
    else rod(root, metal, [Math.sign(x) * 0.35, -0.46, z + 0.05], [x, y + 0.05, z], 0.05);
    const w = wheel(root, tyre, metal, x, y, z, r, i === 0 ? 0.06 : 0.15, i === 0);
    if (i) pant(w.holder, white, r, 0.15);
    wheels.push(w);
  }
  // lights: landing light in the left wing root, nav lights on the tips, tail light, strobe on the fin
  const ly = WY + 1.8 * DIH;
  put(root, new THREE.BoxGeometry(0.3, 0.08, 0.04), lamp, 1.8, ly, LE(1.8) + 0.01);
  const lz = LE(1.8) + 0.03;               // the lit lens (lights.js) on the lamp box's front face
  const lights = { head: [new THREE.Vector3(1.8, ly, lz)], tail: [],
    lens: { head: [[[1.65, ly - .04, lz], [1.95, ly - .04, lz], [1.95, ly + .04, lz], [1.65, ly + .04, lz]]] }, nav: {
    left: new THREE.Vector3(4.18, WY + 4.1 * DIH, 0.45), right: new THREE.Vector3(-4.18, WY + 4.1 * DIH, 0.45),
    tail: new THREE.Vector3(0, 0.36, -5.0), strobe: new THREE.Vector3(0, 1.4, -4.55),
  } };
  lights.landing = lights.head;
  const mats = [white, stripe];
  let wrecked = false, base = [];          // paint is snapshotted on entering the wreck (Garage colours), restored on leaving
  const wreck = on => {
    if (on && !wrecked) base = mats.map(m => m.color.getHex());
    if (on || wrecked) mats.forEach((m, i) => m.color.setHex(on ? WRECK : base[i]));
    wrecked = on;
    root.scale.set(on ? 1.12 : 1, on ? 0.65 : 1, on ? 0.8 : 1);
    canopy.visible = !on;
    elevator.rotation.z = on ? -0.5 : 0; rudder.rotation.z = on ? 0.7 : 0;
    aileronL.rotation.y = on ? 0.4 : 0; aileronR.rotation.y = on ? -0.5 : 0;
    prop.blades.rotation.x = on ? -0.6 : 0;
  };
  // Garage liveries / scuffs on the fuselage sides behind the canopy (cosmetics.js)
  const tilt = 0.118;
  batch(root, new Set([canopy]));
  sides.forEach(side => batch(side));
  root.userData = {
    wheels, setGear: () => {}, noseWheel: wheels[0].holder, elevator, rudder, aileronL, aileronR, wreck, canopy, propeller: prop,
    wreckMats: mats, wreckColor: WRECK, blob: [8.2, 7.9], lights, landingLight: true,
    decalSpots: [[0.6, 0.32, 0.287, 0.07, -2.65, 0, Math.PI / 2 + tilt], [0.6, 0.32, -0.287, 0.07, -2.65, 0, -Math.PI / 2 - tilt]],
    animate(v, dt) {
      prop.spin(v, dt);
      v.wheels?.forEach((wh, i) => { if (wheels[i]) wheels[i].spin.rotation.x = wh.spin * (i ? 1 : 2.8); });
    },
  };
  return root;
}
