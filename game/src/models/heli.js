// Light helicopter model (Bell 206 / AS350 style): bubble cockpit, engine fairing, tail boom with stabiliser and fin,
// two-blade main rotor and tail rotor that spin with rotor power, skids. Low-poly, flat shaded. +z forward, +x left,
// origin = the centre the physics moves (heli.js), HELI_SKID_H above the bottom of the skids.
// Paint roles: body (white), trim (orange stripes, fin, blade tips). userData: wheels (skid ends, for dust and tyre
// shadows), lights (nav left/right/tail, strobe), wreck(on), syncMesh (shared with mp/remotes.js).
import * as THREE from 'three';

export const HELI_SKID_H = 1.6;
// skid ends [x, z]: front-left, front-right, rear-left, rear-right (the order heli.js groundPose expects)
export const HELI_SKIDS = [[1.1, 1.55], [-1.1, 1.55], [1.1, -1.65], [-1.1, -1.65]];
const HUB = [0, 1.62, -0.15], BLADE = 5.0, TAIL_ROTOR = [0.16, 0.95, -6.55], TAIL_R = 0.72;
// points that must not touch the ground in flight: nose, tail fin, tail rotor, main rotor tips (y > 1 = 'rotor')
export const HELI_BODY = [[0, -0.7, 2.55], [0, 0.15, -6.7], [TAIL_ROTOR[0], TAIL_ROTOR[1] - TAIL_R, TAIL_ROTOR[2]],
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(i => [Math.sin(i * Math.PI / 4) * BLADE, HUB[1], HUB[2] + Math.cos(i * Math.PI / 4) * BLADE])];

const M = (color, role, o = {}) => {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true, ...o });
  if (role) m.userData.cosmeticRole = role;
  return m;
};
function add(parent, geometry, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.castShadow = true; parent.add(m); return m;
}
// Octagonal sections lofted nose → tail: [z, half width, bottom y, top y]; capped, flat shaded.
function loft(parent, material, sections) {
  const ring = ([z, w, b, t]) => {
    const h = t - b;
    return [[w * .62, b], [w, b + h * .28], [w, t - h * .3], [w * .62, t], [-w * .62, t], [-w, t - h * .3], [-w, b + h * .28], [-w * .62, b]].map(([x, y]) => [x, y, z]);
  };
  const rings = sections.map(ring), pts = [], tri = (a, b, c) => pts.push(...a, ...b, ...c);
  for (let j = 1; j < rings.length; j++) for (let i = 0; i < 8; i++) {
    const a = rings[j - 1][i], b = rings[j][i], c = rings[j][(i + 1) % 8], d = rings[j - 1][(i + 1) % 8];
    tri(a, b, c); tri(a, c, d);
  }
  for (const [r, flip] of [[rings[0], false], [rings.at(-1), true]]) for (let i = 1; i < 7; i++) flip ? tri(r[0], r[i + 1], r[i]) : tri(r[0], r[i], r[i + 1]);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3)); g.computeVertexNormals();
  return add(parent, g, material);
}
// a round tube from a to b
function tube(parent, material, a, b, r) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
  const m = add(parent, new THREE.CylinderGeometry(r, r, d.length(), 6), material);
  m.position.copy(A).addScaledVector(d, .5); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return m;
}
// a flat side-on plate (fin) from [z, y] points, thickness th, centred on x
function fin(parent, material, pts, th, x = 0) {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))), { depth: th, bevelEnabled: false })
    .rotateY(-Math.PI / 2).translate(x + th / 2, 0, 0);
  return add(parent, g, material);
}

export function buildHeliModel() {
  const root = new THREE.Group(); root.name = 'heli';
  const paint = M('#eef0f2', 'body'), trim = M('#ff6a1a', 'trim'), dark = M('#2a2e36'), metal = M('#9aa0a8'),
    blade = M('#30343a'), glass = M('#1b3550', null, { emissive: 0x0a1a2a });
  // ---- fuselage: lower body, glass bubble on the front, cabin roof and rear fairing into the boom
  loft(root, paint, [[2.55, .3, -.6, -.15], [2.2, .74, -.86, .05], [1.3, .93, -.95, .05], [-.9, .93, -.92, .05], [-1.85, .6, -.6, .1], [-2.45, .3, .3, .45]]);
  const canopy = loft(root, glass, [[2.5, .32, -.15, .0], [2.2, .74, .05, .5], [1.35, .93, .05, .9], [.35, .93, .05, .96]]);
  loft(root, paint, [[.35, .93, .05, .96], [-.9, .9, .05, .96], [-1.85, .6, .1, .82], [-2.45, .3, .45, .7]]);
  for (const s of [1, -1]) {
    add(root, new THREE.BoxGeometry(.05, .85, .07), dark, s * .92, .48, .35);             // door frame
    add(root, new THREE.BoxGeometry(.05, .62, .05), dark, s * .8, .3, 1.75).rotation.x = -.5;   // windscreen post
    add(root, new THREE.BoxGeometry(.03, .14, 2.6), trim, s * .945, -.38, .25);            // side stripe
    add(root, new THREE.BoxGeometry(.03, .06, 2.6), trim, s * .945, -.22, .25);
    add(root, new THREE.BoxGeometry(.04, .32, .5), dark, s * .45, 1.15, -.5);              // engine intake
    add(root, new THREE.BoxGeometry(.04, .55, .02), dark, s * .935, -.38, -.92);           // rear door seam
  }
  add(root, new THREE.BoxGeometry(.06, .05, 1.2), dark, 0, .93, 1.0);                       // canopy centre frame
  // engine + transmission fairing, exhaust, mast
  add(root, new THREE.BoxGeometry(.95, .42, 1.8), paint, 0, 1.12, -.55);
  add(root, new THREE.BoxGeometry(.7, .2, 1.2), paint, 0, 1.38, -.65);
  add(root, new THREE.CylinderGeometry(.13, .15, .5, 8).rotateX(-1.1), dark, 0, 1.25, -1.55);
  add(root, new THREE.CylinderGeometry(.08, .1, .3, 6), dark, HUB[0], 1.48, HUB[2]);
  // ---- tail boom, stabiliser with end plates, fin, tail-rotor gearbox
  add(root, new THREE.CylinderGeometry(.27, .14, 4.4, 8).rotateX(Math.PI / 2), paint, 0, .55, -4.55);
  add(root, new THREE.BoxGeometry(.03, .08, 4), trim, .21, .55, -4.4); add(root, new THREE.BoxGeometry(.03, .08, 4), trim, -.21, .55, -4.4);
  add(root, new THREE.BoxGeometry(2.1, .06, .55), paint, 0, .5, -5.35);
  for (const s of [1, -1]) add(root, new THREE.BoxGeometry(.05, .42, .5), trim, s * 1.05, .58, -5.4);
  fin(root, trim, [[-6.05, .6], [-6.55, .6], [-6.95, 1.6], [-6.62, 1.6]], .07);
  fin(root, trim, [[-6.3, .5], [-6.62, .5], [-6.78, .1], [-6.55, .1]], .06);
  add(root, new THREE.BoxGeometry(.18, .22, .3), dark, .07, TAIL_ROTOR[1], TAIL_ROTOR[2]);
  // ---- skids and cross tubes
  for (const s of [1, -1]) {
    const x = s * 1.1, y = -HELI_SKID_H + .07;
    tube(root, metal, [x, y, -1.75], [x, y, 1.65], .06);
    tube(root, metal, [x, y, 1.65], [x, y + .28, 2.0], .06);
    for (const z of [.95, -1.0]) { tube(root, metal, [x, y, z], [s * .98, -1.12, z], .05); tube(root, metal, [s * .98, -1.12, z], [s * .7, -.9, z], .05); }
  }
  // ---- main rotor: hub + two blades (each on its own pivot, so a wreck can bend them), a faint disc when it's fast
  const mainRotor = new THREE.Group(); mainRotor.position.set(...HUB); root.add(mainRotor);
  const head = new THREE.Group(); mainRotor.add(head);
  add(head, new THREE.CylinderGeometry(.16, .16, .14, 8), dark);
  const blades = [];
  for (const s of [1, -1]) {
    const pivot = new THREE.Group(); pivot.rotation.y = s > 0 ? 0 : Math.PI; head.add(pivot);
    add(pivot, new THREE.BoxGeometry(.28, .04, BLADE - .55).translate(0, 0, (BLADE - .55) / 2 + .1), blade);
    add(pivot, new THREE.BoxGeometry(.28, .045, .45).translate(0, 0, BLADE - .22), trim);
    blades.push(pivot);
  }
  const blur = (r, n) => new THREE.Mesh(new THREE.CircleGeometry(r, n), new THREE.MeshBasicMaterial({ color: 0x23262b, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
  const disc = blur(BLADE, 28); disc.rotation.x = -Math.PI / 2; disc.visible = false; mainRotor.add(disc);
  // ---- tail rotor on the left of the fin, spinning about x
  const tailRotor = new THREE.Group(); tailRotor.position.set(...TAIL_ROTOR); root.add(tailRotor);
  add(tailRotor, new THREE.BoxGeometry(.04, TAIL_R * 2, .13), blade);
  add(tailRotor, new THREE.BoxGeometry(.045, .2, .14), trim, 0, TAIL_R - .1, 0); add(tailRotor, new THREE.BoxGeometry(.045, .2, .14), trim, 0, -TAIL_R + .1, 0);
  const tailDisc = blur(TAIL_R, 16); tailDisc.rotation.y = Math.PI / 2; tailDisc.visible = false; tailRotor.add(tailDisc);
  // skid ends: where dust and the small contact shadows go
  const wheels = HELI_SKIDS.map(([x, z], i) => {
    const holder = new THREE.Group(); holder.position.set(x, -HELI_SKID_H + .06, z); root.add(holder);
    const spin = new THREE.Group(); holder.add(spin);
    return { holder, spin, r: .06, front: i < 2 };
  });
  // wreck: blackened, crumpled, canopy gone, blades bent down, tail rotor knocked askew
  const mats = [paint, trim], WRECK = 0x3a3a3a;
  let wrecked = false, base = [];          // paint is snapshotted on entering the wreck (Garage colours), restored on leaving
  const wreck = on => {
    if (on && !wrecked) base = mats.map(m => m.color.getHex());
    if (on || wrecked) mats.forEach((m, i) => m.color.setHex(on ? WRECK : base[i]));
    wrecked = on;
    root.scale.set(on ? 1.1 : 1, on ? .7 : 1, on ? .85 : 1);
    canopy.visible = !on;
    blades[0].rotation.set(on ? .35 : 0, 0, on ? .2 : 0); blades[1].rotation.set(on ? -.5 : 0, Math.PI, on ? -.3 : 0);
    tailRotor.rotation.z = on ? .9 : 0;
  };
  // per frame, for the player's helicopter (this = Heli) and other players' copies (this = their puppet)
  function syncMesh(dt) {
    const m = this.mesh, ud = m.userData, p = this.mode === 'crashed' ? 0 : Math.max(0, Math.min(1, this.throttle || 0));
    m.position.copy(this.renderPos); m.quaternion.copy(this.renderQuat);
    ud.spin = (ud.spin + p * p * 17 * dt) % (Math.PI * 2);
    ud.mainRotor.rotation.y = ud.spin;
    ud.tailRotor.rotation.x = ud.spin * 5;
    const blurOn = Math.max(0, p - .5) * 2;
    ud.disc.visible = ud.tailDisc.visible = blurOn > 0;
    ud.disc.material.opacity = blurOn * .16; ud.tailDisc.material.opacity = blurOn * .2;
    // the rotor head tips with the stick
    const J = this.input?.jet || { pitch: 0, roll: 0 };
    ud.head.rotation.x += (-(J.pitch || 0) * .14 - ud.head.rotation.x) * Math.min(1, dt * 8);
    ud.head.rotation.z += ((J.roll || 0) * .1 - ud.head.rotation.z) * Math.min(1, dt * 8);
  }
  root.userData = { wheels, mainRotor, head, tailRotor, disc, tailDisc, blades, spin: 0, syncMesh, wreck, setGear() {}, canopy,
    wreckMats: mats, wreckColor: WRECK, blob: [3.2, 8.5],
    // livery number boards and scuffs on the cabin sides (cosmetics.js)
    decalSpots: [[.62, .52, 1.0, -.45, -.25, 0, Math.PI / 2], [.62, .52, -1.0, -.45, -.25, 0, -Math.PI / 2]],
    // Subtle navigation lights only
    lights: { head: [], tail: [], nav: {
      left: new THREE.Vector3(1.1, .62, -5.4), right: new THREE.Vector3(-1.1, .62, -5.4),
      tail: new THREE.Vector3(0, 1.62, -6.75), strobe: new THREE.Vector3(0, 1.52, -.95),
    } } };
  return root;
}
