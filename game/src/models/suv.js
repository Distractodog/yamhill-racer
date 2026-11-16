// SUV (RAV4 / Range-Rover-like): tall upright body, high flat bonnet, big framed grille, black pillars under a
// "floating" roof with rails, plastic arch and sill cladding, chunky bumpers with skid plates, a near-vertical tailgate
// carrying the spare wheel, and bigger wheels with more sidewall. +z forward, +x = the car's left.
// Paint roles: body = shell and mirrors, trim = roof rails, grille frame, skid plates and badges, wheels = rims (spare
// too). The wheels sit on the physics mounts (WHEEL_POS × the type's width / length) at the parked stance.
import * as THREE from 'three';
import { measureWheelArch } from '../wheeltravel.js';
import { WHEEL_POS } from '../carmodel.js';
import { Shape, materials, loft, archFlares, sidePanel, sideSkirt, doorLine, endPanels, rect, oct, wheelGeometry, buildWheels, lodBody } from './shapedbody.js';

const UNDER = '#1a1c20', CLAD = '#2b2e33', BLACK = '#15171a', GLASS = '#24394a', SCREEN = '#2b4456', TYRE = '#1d1e22';
const LENS = '#d6dde3', HEAD_IN = '#3b4149', BULB = '#f3f5f7', TAIL = '#a5121c', TAIL_IN = '#5e0a10', PLATE = '#eeede4';
// cowl, screen top, B-pillar, C-pillar, quarter glass end (D-pillar), roof end, tailgate glass bottom
const ZC = .98, ZW = .40, ZB0 = -.20, ZB1 = -.30, ZC0 = -1.00, ZC1 = -1.12, ZG = -1.78, ZR = -1.95, ZH = -2.07;

const K = (z, floor, xWell, xSill, xMax, lip, mid, sh, xB, yB, xG, yG, xR, yR, yC) => ({ z, floor, xWell, xSill, xMax, lip, mid, sh, xB, yB, xG, yG, xR, yR, yC });
const KEYS = [
  // half-widths before the arch blisters (BLISTER adds up to .075 over each wheel; wide front / rear corners)
  K(2.20, -.36, .70, 1.08, 1.14, .10, .18, .36, 1.06, .40, .70, .42, .35, .43, .435),   // nose (front face = cap)
  K(2.12, -.44, .80, 1.12, 1.16, .10, .18, .39, 1.10, .43, .72, .45, .36, .46, .465),
  K(1.95, -.50, .88, 1.11, 1.15, .10, .18, .43, 1.09, .46, .72, .475, .36, .485, .49),
  K(1.10, -.50, .88, 1.11, 1.15, .10, .18, .47, 1.09, .50, .74, .515, .37, .525, .53),  // bonnet rear
  K(ZC, -.50, .88, 1.11, 1.15, .10, .18, .47, 1.09, .51, 1.09, .51, 1.03, .525, .55),  // cowl: screen base
  K(ZW, -.50, .88, 1.11, 1.15, .10, .18, .48, 1.09, .52, 1.00, 1.00, .96, 1.04, 1.06), // screen top
  K(ZG, -.48, .88, 1.11, 1.15, .10, .18, .49, 1.09, .53, 1.00, .995, .96, 1.035, 1.055),
  K(ZR, -.47, .88, 1.11, 1.15, .10, .16, .49, 1.08, .535, .99, .985, .94, 1.03, 1.05),  // roof end
  K(ZH, -.46, .86, 1.11, 1.15, .10, .15, .49, 1.07, .55, 1.05, .555, .94, .56, .565),  // tailgate glass bottom
  K(-2.14, -.42, .75, 1.08, 1.13, .10, .15, .47, 1.05, .53, 1.00, .535, .70, .54, .545), // tail (rear face = cap)
];
const BLISTER = { out: .075, reach: .22 }, SKIRT = 1.235;  // cladding skirt face half-width, flush with the blisters
const pillar = z => (z < ZB0 && z > ZB1) || (z < ZC0 && z > ZC1);
function colour(b, z0, z1, i, last) {
  const z = (z0 + z1) / 2, house = z < ZC && z > ZH;
  if (b <= 2) return UNDER;
  if (b === 3) return CLAD;
  if (b === 5) return i === 0 ? LENS : i === last ? TAIL : 'body';
  if (b === 7) return house ? (z > ZG && !pillar(z) ? GLASS : BLACK) : 'body';
  if (b === 8) return house ? BLACK : 'body';
  if (b === 9) return z < ZC && z > ZW ? SCREEN : z < ZR && z > ZH ? GLASS : 'body';
  return 'body';
}

function body(far, arches) {
  const s = new Shape();
  const car = loft(s, { keys: KEYS, arches, cuts: [ZB0, ZB1, ZC0, ZC1], archSteps: far ? 5 : 11, colour, blister: far ? { ...BLISTER, steps: [1] } : BLISTER });
  for (const a of arches) archFlares(s, car, a, { t: .075, w: .13, col: CLAD, steps: far ? 4 : 10 });
  const { front, rear } = endPanels(s, car), zN = car.nose, zT = car.tail;
  // lower cladding: a skirt from arch to arch, and round the bumper corners
  const [fa, ra] = arches;
  sideSkirt(s, car, fa.z - fa.r - .005, ra.z + ra.r + .005, -.47, -.22, SKIRT, CLAD);
  sidePanel(s, car, zN - .002, fa.z + fa.r + .02, -.36, -.14, CLAD, .02);
  sidePanel(s, car, ra.z - ra.r - .02, zT + .002, -.36, -.18, CLAD, .02);
  // front: big framed grille between slim wrap-round headlights; chunky full-width bumper wrapping the corners
  front.pair(1, [[.66, .205], [1.14, .205], [1.14, .345], [1.08, .385], [.70, .385]], LENS);
  front.one(1, rect(-.62, -.10, .62, .385), 'trim');
  front.one(2, rect(-.575, -.07, .575, .355), BLACK);
  s.box(0, -.24, zN - .035, 2.40, .24, .21, CLAD);
  front.one(19, rect(-.55, -.36, .55, -.29), 'trim');
  front.one(19, rect(-.26, -.235, .26, -.135), PLATE);
  // rear: tall lamps in the corners, bumper, plate, spare wheel on the tailgate
  rear.pair(1, [[.84, .15], [1.135, .15], [1.135, .46], [.90, .46]], TAIL);
  s.box(0, -.33, zT + .025, 2.40, .18, .19, CLAD);
  rear.one(19, rect(-.26, -.39, .26, -.29), PLATE);
  const at = new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0, .14, zT - .16);
  if (far) s.geo(new THREE.CylinderGeometry(.36, .36, .24, 10).rotateZ(Math.PI / 2), TYRE, at);
  else { const spare = wheelGeometry(.36, .24, { rimR: .22, spokes: 6 }); s.geo(spare.tyre, TYRE, at); s.geo(spare.rim, 'wheels', at); }
  for (const x of [1, -1]) s.box(x * 1.285, .63, .86, .21, .14, .15, 'body');       // mirror housings
  for (const x of [1, -1]) s.box(x * .80, 1.118, -.75, .045, .035, 1.9, 'trim');     // roof rails
  if (far) return { shape: s, car };
  front.pair(2, rect(.72, .225, 1.10, .36), HEAD_IN);
  front.pair(3, oct(.82, .29, .045), BULB); front.pair(3, oct(.99, .29, .045), BULB);
  front.pair(3, [[.70, .37], [1.07, .37], [1.10, .345], [.72, .352]], '#eef1f4');      // running-light strip
  for (let i = 0; i < 5; i++) front.one(3, rect(-.56, -.03 + i * .078, .56, -.012 + i * .078), '#4b525b');
  front.one(4, oct(0, .155, .06), 'trim');
  front.one(19, rect(-.48, -.285, .48, -.255), BLACK);
  front.pair(19, rect(.80, -.22, .96, -.16), '#cdd3d8');                                // fog lamps
  front.pair(18, rect(.77, -.24, .99, -.14), BLACK);
  rear.pair(2, [[.90, .30], [1.135, .30], [1.135, .33], [.92, .33]], TAIL_IN);
  rear.pair(2, rect(.88, .17, 1.01, .21), '#e9e9e3');                                   // reversing lights
  rear.pair(19, rect(.94, -.30, 1.12, -.27), '#7d0d15');
  rear.one(19, rect(-.50, -.42, .50, -.395), 'trim');
  for (const x of [-.17, -.08, .02, .11]) rear.one(20, rect(x, -.36, x + .06, -.32), '#30343a');
  rear.one(1, rect(-.20, .06, .20, .22), BLACK);                                        // spare wheel bracket
  s.geo(new THREE.CylinderGeometry(.04, .04, .1, 8).rotateX(Math.PI / 2), '#b9bec4', new THREE.Matrix4().makeTranslation(-.62, -.43, zT - .05));
  // sides: shut lines, handles, mirror bases and glass, roof rail legs
  for (const z of [ZC - .05, (ZB0 + ZB1) / 2, (ZC0 + ZC1) / 2]) doorLine(s, car, z);
  for (const z of [-.02, -.86]) { sidePanel(s, car, z + .08, z - .08, .38, .425, BLACK, .004); sidePanel(s, car, z + .065, z - .065, .388, .417, 'body', .018); }
  for (const x of [1, -1]) {
    s.box(x * 1.18, .565, .87, .10, .05, .09, BLACK);
    s.poly([[x * 1.19, .575, .784], [x * 1.38, .575, .784], [x * 1.38, .69, .784], [x * 1.19, .69, .784]], '#566472', [0, 0, -1]);
    for (const z of [.12, -.75, -1.62]) s.box(x * .80, 1.08, z, .05, .06, .09, BLACK);
  }
  for (const x of [-.32, .32]) s.box(x, .625, .90, .7, .014, .03, BLACK, Math.atan2(.51, ZC - ZW));
  s.box(0, 1.025, -1.985, 1.6, .035, .08, 'body');                                    // tailgate spoiler lip
  s.box(0, 1.012, -2.03, .34, .02, .02, TAIL);
  s.box(0, 1.08, -1.55, .05, .05, .15, BLACK, -.3);
  return { shape: s, car };
}

export function buildSuvModel(type, p, suspension) {
  const root = new THREE.Group(); root.name = `car-${type}`;
  const bodyPivot = new THREE.Group(); root.add(bodyPivot);
  const rim = new THREE.MeshLambertMaterial({ color: '#d9dce2', flatShading: true }); rim.userData.cosmeticRole = 'wheels';
  const mats = materials(rim), tyre = new THREE.MeshLambertMaterial({ color: '#1d1e22', flatShading: true });
  const wheels = buildWheels(root, WHEEL_POS, p, suspension, tyre, rim, { width: .32, rimR: p.radius * .6, spokes: 6, spokeW: .06 });
  // arch circles a little above the parked wheel centres, r = tyre + gap
  const arches = [wheels[0], wheels[2]].map(w => ({ z: w.holder.position.z, y: w.holder.position.y + .03, r: p.radius + .07 }));
  const near = body(false, arches), far = body(true, arches);
  lodBody(bodyPivot, near.shape.meshes(mats), far.shape.meshes(mats));
  const zN = near.car.nose, zT = near.car.tail;
  root.userData = { bodyPivot, wheels, lightMount: bodyPivot, blob: [2.4 * p.width, 4.6 * p.length],
    lights: { head: [1, -1].map(s => new THREE.Vector3(s * .91, .29, zN + .03)), tail: [1, -1].map(s => new THREE.Vector3(s * 1.0, .30, zT - .03)) },
    triangles: { near: near.shape.triangles(), far: far.shape.triangles() },
    // livery decals on the bonnet and roof (between the rails)
    decalPanels: [[.6, .6, 0, .515, 1.55, -Math.PI / 2 + .047], [.6, .6, 0, 1.064, -.7, -Math.PI / 2]] };
  root.userData.wheelArch = measureWheelArch(root); // per wheel: tyre-top ceiling from the real arch (wheeltravel.js)
  return root;
}
