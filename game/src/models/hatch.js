// Hatchback (Golf / Civic-like): short bonnet, raked screen, roofline dropping to a near-vertical hatch with a spoiler
// lip, flared arches, body-colour pillars with a black B-pillar, wrap-round lamps, mirrors and door lines.
// +z forward, +x = the car's left. Paint roles: body = shell and mirrors, trim = grille line, badges and sill stripe,
// wheels = rims. The wheels sit on the physics mounts (WHEEL_POS × the type's width / length) at the parked stance.
import * as THREE from 'three';
import { measureWheelArch } from '../wheeltravel.js';
import { WHEEL_POS } from '../carmodel.js';
import { Shape, materials, loft, archFlares, sidePanel, sideSkirt, doorLine, endPanels, panelLights, rect, oct, buildWheels, lodBody } from './shapedbody.js';

const UNDER = '#1a1c20', PLASTIC = '#26292e', BLACK = '#16181b', GLASS = '#24394a', SCREEN = '#2b4456';
const LENS = '#d6dde3', HEAD_IN = '#3b4149', BULB = '#f3f5f7', TAIL = '#a5121c', TAIL_IN = '#5e0a10';
const PLATE = '#eeede4', CHROME = '#b9bec4';
const ZC = .80, ZW = .08, ZB0 = -.25, ZB1 = -.33, ZG = -1.02, ZR = -1.44, ZH = -1.60;   // cowl, screen top, B-pillar, glass end, roof end, hatch glass bottom

const K = (z, floor, xWell, xSill, xMax, lip, mid, sh, xB, yB, xG, yG, xR, yR, yC) => ({ z, floor, xWell, xSill, xMax, lip, mid, sh, xB, yB, xG, yG, xR, yR, yC });
const KEYS = [
  // half-widths before the arch blisters (BLISTER adds up to .065 over each wheel; wide front / rear corners)
  K(1.80, -.25, .55, .87, .915, .05, .10, .22, .84, .27, .58, .30, .30, .31, .315),    // nose (front face = cap)
  K(1.73, -.29, .60, .92, .965, .05, .10, .26, .88, .30, .60, .33, .32, .345, .35),
  K(1.60, -.30, .62, .90, .945, .06, .10, .30, .89, .335, .62, .365, .32, .38, .385),
  K(.92, -.30, .62, .90, .945, .06, .10, .40, .895, .43, .64, .455, .33, .468, .472),   // bonnet rear
  K(ZC, -.30, .62, .90, .945, .06, .10, .41, .90, .44, .90, .44, .85, .455, .48),      // cowl: screen base
  K(ZW, -.30, .62, .90, .945, .06, .10, .41, .90, .45, .80, .86, .745, .90, .93),      // screen top
  K(-1.15, -.29, .62, .90, .945, .06, .10, .44, .89, .49, .79, .84, .735, .885, .915),
  K(ZR, -.28, .62, .90, .945, .06, .12, .46, .88, .51, .76, .82, .70, .865, .89),      // roof end (spoiler)
  K(ZH, -.27, .60, .895, .94, .06, .20, .46, .86, .525, .84, .53, .70, .535, .54),     // hatch glass bottom
  K(-1.68, -.26, .55, .89, .93, .05, .20, .42, .84, .48, .80, .49, .60, .495, .50),    // tail (rear face = cap)
];
const BLISTER = { out: .065, reach: .22 }, SKIRT = .995;   // skirt face half-width: flush with the blisters' foot
function colour(b, z0, z1, i, last) {
  const z = (z0 + z1) / 2;
  if (b <= 2) return UNDER;
  if (b === 3) return PLASTIC;
  if (b === 5) return i === 0 ? LENS : i === last ? TAIL : 'body';
  if (b === 7) return z < ZC && z > ZG ? (z < ZB0 && z > ZB1 ? BLACK : GLASS) : 'body';
  if (b === 9) return z < ZC && z > ZW ? SCREEN : z < ZR && z > ZH ? GLASS : 'body';
  return 'body';
}

function body(far, arches) {
  const s = new Shape();
  const car = loft(s, { keys: KEYS, arches, cuts: [ZB0, ZB1, ZG], archSteps: far ? 5 : 11, colour, blister: far ? { ...BLISTER, steps: [1] } : BLISTER });
  for (const a of arches) archFlares(s, car, a, { t: .035, w: .075, col: 'body', steps: far ? 4 : 10 });
  const [fa, ra] = arches, z0 = fa.z - fa.r - .005, z1 = ra.z + ra.r + .005;
  sideSkirt(s, car, z0, z1, -.25, -.13, SKIRT, 'body');
  const { front, rear } = endPanels(s, car), zT = car.tail;
  // front: wrap-round headlights, slim grille with the trim line through it, lower intake, plate
  front.pair(1, [[.38, .10], [.91, .10], [.91, .21], [.86, .25], [.44, .25]], LENS);
  front.one(1, rect(-.355, .105, .355, .248), BLACK);
  front.one(1, [[-.58, -.04], [.58, -.04], [.52, -.20], [-.52, -.20]], BLACK);
  front.one(2, rect(-.25, -.115, .25, -.02), PLATE);
  // rear: lamps wrapping into the corners, plate recess, black valance
  rear.pair(1, [[.52, .20], [.955, .20], [.955, .415], [.60, .415]], TAIL);
  rear.one(1, rect(-.28, .03, .28, .19), PLASTIC);
  rear.one(2, rect(-.25, .05, .25, .17), PLATE);
  rear.one(1, rect(-.92, -.26, .92, -.14), PLASTIC);
  for (const x of [1, -1]) s.box(x * 1.04, .57, .655, .17, .105, .13, 'body');      // mirror housings
  if (far) return { shape: s, car };
  front.pair(2, rect(.45, .125, .84, .238), HEAD_IN);
  front.pair(3, oct(.55, .18, .042), BULB); front.pair(3, oct(.72, .18, .042), BULB);
  front.pair(2, rect(.44, .104, .86, .118), '#eef1f4');                          // running-light strip
  for (const y of [.15, .195]) front.one(2, rect(-.34, y, .34, y + .012), '#30353c');
  front.one(3, rect(-.90, .086, .90, .1), 'trim');
  front.one(3, oct(0, .176, .048), 'trim');
  front.one(2, rect(-.52, -.135, .52, -.12), '#2d3137');
  for (const x of [-.17, -.08, .02, .11]) front.one(3, rect(x, -.085, x + .06, -.05), '#30343a');
  front.pair(1, [[.66, -.06], [.86, -.06], [.86, -.17], [.70, -.17]], BLACK);
  front.pair(2, rect(.705, -.13, .79, -.095), '#cdd3d8');
  front.one(1, rect(-.86, -.25, .86, -.215), PLASTIC);
  rear.pair(2, [[.66, .31], [.955, .31], [.955, .335], [.68, .335]], TAIL_IN);
  rear.pair(2, rect(.57, .225, .68, .265), '#e9e9e3');                           // reversing lights
  rear.one(2, oct(0, .30, .05), 'trim');
  rear.pair(2, rect(.70, -.10, .88, -.075), '#7d0d15');
  for (const x of [-.17, -.08, .02, .11]) rear.one(3, rect(x, .09, x + .06, .13), '#30343a');
  s.geo(new THREE.CylinderGeometry(.036, .036, .1, 8).rotateX(Math.PI / 2), CHROME, new THREE.Matrix4().makeTranslation(-.46, -.235, zT - .02));
  s.poly([[-.49, -.265, zT - .071], [-.43, -.265, zT - .071], [-.43, -.205, zT - .071], [-.49, -.205, zT - .071]], UNDER, [0, 0, -1]);
  // sides: shut lines, handles, sill stripe, mirror bases and glass
  for (const z of [ZC - .03, (ZB0 + ZB1) / 2, ZG + .03]) doorLine(s, car, z);
  for (const z of [-.04, -.76]) { sidePanel(s, car, z + .075, z - .075, .35, .39, BLACK, .004); sidePanel(s, car, z + .06, z - .06, .357, .383, 'body', .016); }
  for (const x of [1, -1]) s.poly([[x * (SKIRT + .003), -.205, z0 - .05], [x * (SKIRT + .003), -.205, z1 + .05], [x * (SKIRT + .003), -.18, z1 + .05], [x * (SKIRT + .003), -.18, z0 - .05]], 'trim', [x, 0, 0]);
  for (const x of [1, -1]) {
    s.box(x * .955, .515, .665, .08, .045, .07, BLACK);
    s.poly([[x * .965, .528, .589], [x * 1.115, .528, .589], [x * 1.115, .612, .589], [x * .965, .612, .589]], '#566472', [0, 0, -1]);
  }
  // wipers on the screen base, spoiler with brake light, rear wiper, roof fin
  for (const x of [-.30, .30]) s.box(x, .54, .70, .6, .014, .03, BLACK, Math.atan2(.45, ZC - ZW));
  s.box(0, .885, -1.47, 1.42, .04, .24, 'body', -.12);
  s.pair(.705, .845, -1.47, .03, .09, .16, 'body');
  s.box(0, .866, -1.585, .32, .02, .02, TAIL);
  s.box(0, .655, -1.556, .022, .30, .016, BLACK, Math.atan2(ZR - ZH, .865 - .535));
  s.box(0, .935, -1.28, .05, .05, .15, BLACK, -.3);
  return { shape: s, car };
}

export function buildHatchModel(type, p, suspension) {
  const root = new THREE.Group(); root.name = `car-${type}`;
  const bodyPivot = new THREE.Group(); root.add(bodyPivot);
  const rim = new THREE.MeshLambertMaterial({ color: '#d9dce2', flatShading: true }); rim.userData.cosmeticRole = 'wheels';
  const mats = materials(rim), tyre = new THREE.MeshLambertMaterial({ color: '#1d1e22', flatShading: true });
  const wheels = buildWheels(root, WHEEL_POS, p, suspension, tyre, rim, { width: .27, rimR: p.radius * .66, spokes: 5 });
  // arch circles centred on the parked wheel centres, r = tyre + gap
  const arches = [wheels[0], wheels[2]].map(w => ({ z: w.holder.position.z, y: w.holder.position.y, r: p.radius + .07 }));
  const near = body(false, arches), far = body(true, arches);
  lodBody(bodyPivot, near.shape.meshes(mats), far.shape.meshes(mats));
  root.userData = { bodyPivot, wheels, lightMount: bodyPivot, blob: [2.4 * p.width, 4.6 * p.length],
    // lit lenses over the headlight, and the tail lamp above its reversing light
    lights: panelLights(near.car, { at: [.645, .175], pts: [[.38, .10], [.91, .10], [.91, .21], [.86, .25], [.44, .25]] },
      { at: [.77, .345], pts: [[.548, .275], [.955, .275], [.955, .415], [.60, .415]] }, [4, 3]),
    triangles: { near: near.shape.triangles(), far: far.shape.triangles() },
    // livery decals on the bonnet and roof
    decalPanels: [[.55, .55, 0, .434, 1.27, -Math.PI / 2 + .127], [.6, .6, 0, .929, -.55, -Math.PI / 2 - .012]] };
  root.userData.wheelArch = measureWheelArch(root); // per wheel: tyre-top ceiling from the real arch (wheeltravel.js)
  return root;
}
