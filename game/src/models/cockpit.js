// First-person-only fittings. +z forward; all dimensions are relative to the pilot's eye.
// Two merged, vertex-coloured meshes, no textures, lights or steady-frame traversal.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function addCockpit(root, { style, eye, width = .52, depth = .8, blockers = [] }) {
  const group = new THREE.Group(); group.name = 'cockpit'; group.visible = false;
  group.position.set(0, eye[0], eye[1]); root.add(group);
  const solid = [], lit = [];
  const dark = 0x242b30, edge = 0x56636b, face = style === 'prop' ? 0x59584f : 0x343e44;
  const jet = style === 'fighter' || style === 'stealth', heli = style === 'heli';
  function part(g, color, x, y, z, luminous = false) {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.translate(x, y, z); geo.deleteAttribute('uv');
    const c = new THREE.Color(color), colors = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) { colors[i] = c.r; colors[i + 1] = c.g; colors[i + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    (luminous ? lit : solid).push(geo);
  }
  const box = (w, h, d, x, y, z, color = dark, luminous = false) => part(new THREE.BoxGeometry(w, h, d), color, x, y, z, luminous);
  function bar(a, b, r = .018, color = edge) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
    const geo = new THREE.BoxGeometry(r * 2, delta.length(), r * 2);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    start.add(end).multiplyScalar(.5); part(geo, color, ...start);
  }
  // Panel begins around the lower third; separate shield projects towards the seat.
  box(width * 2, .31, .09, 0, -.46, depth, face);
  box(width * 2 + .05, .045, .22, 0, -.29, depth - .045);
  function gauge(x, y, r = .066) {
    part(new THREE.CircleGeometry(r, 10).rotateY(Math.PI), 0xa3acaa, x, y, depth - .052, true);
    part(new THREE.CircleGeometry(r * .79, 10).rotateY(Math.PI), 0x101b23, x, y, depth - .054, true);
    box(.008, r * .95, .003, x + .012, y + .012, depth - .058, 0xe7e9d7, true);
    box(.018, .007, .003, x - r * .52, y, depth - .058, 0xe7e9d7, true);
  }
  if (jet) {
    for (const s of [-1, 1]) {
      box(.23, .19, .012, s * width * .56, -.43, depth - .055, 0x10191e);
      box(.19, .15, .004, s * width * .56, -.43, depth - .064, s < 0 ? 0x236756 : 0x24556c, true);
      for (const y of [-.40, -.45]) box(.12, .006, .004, s * width * .56, y, depth - .068, 0x78dcc4, true);
    }
    gauge(0, -.43, .055);
    // Open HUD combiner frame: clear centre preserves the horizon, etched green reference marks.
    for (const s of [-1, 1]) bar([s * .15, -.27, depth], [s * .15, .04, depth + .09], .012);
    bar([-.15, .04, depth + .09], [.15, .04, depth + .09], .012);
    box(.10, .004, .004, 0, -.075, depth + .075, 0x68cda2, true);
    box(.004, .026, .004, 0, -.075, depth + .075, 0x68cda2, true);
  } else {
    for (const x of [-.23, 0, .23]) gauge(x * width / .52, -.4);
    for (const x of [-.12, .12]) gauge(x * width / .52, -.54, .045);
  }
  // Sills, side consoles, seat bolsters and the headrest behind the eye.
  for (const s of [-1, 1]) {
    box(.12, .25, 1.1, s * width, -.57, .16, face);
    box(.13, .045, 1.1, s * width, -.425, .16);
    box(.09, .35, .32, s * .24, -.61, -.17);
    for (const z of [.23, .34]) box(.025, .018, .04, s * width, -.395, z, 0xc2b89b);
    // Windscreen pillars and a faceted bow, with a wide opening ahead.
    bar([s * width, -.29, depth], [s * width * .88, .24, depth * .72]);
    bar([s * width * .88, .24, depth * .72], [s * width * .45, .34, depth * .56]);
  }
  bar([-width * .45, .34, depth * .56], [width * .45, .34, depth * .56]);
  box(.26, .23, .12, 0, -.12, -.3);
  // Throttle / collective to the left; central stick or the trainer's forked yoke.
  bar([width - .07, -.57, .16], [width - .07, -.34, .30], .016);
  box(.095, .04, .05, width - .07, -.33, .30, heli ? 0x444c50 : 0xb38345);
  if (style === 'prop') {
    bar([0, -.55, depth - .05], [0, -.49, .39], .02);
    bar([-.15, -.49, .39], [.15, -.49, .39], .018);
    for (const s of [-1, 1]) bar([s * .15, -.49, .39], [s * .15, -.38, .39], .023, dark);
  } else {
    bar([0, -.79, .30], [0, -.46, .42], .018);
    box(.05, .11, .06, 0, -.43, .42);
    box(.025, .014, .025, 0, -.369, .42, 0xbc5540);
  }
  if (heli) {
    box(.32, .045, .35, 0, .29, .62, face); // overhead switch panel
    for (const x of [-.09, 0, .09]) box(.024, .015, .04, x, .26, .72, 0xd3c8a1);
    for (const s of [-1, 1]) {
      bar([s * width, -.65, .1], [s * width, .25, .1], .022);
      box(.09, .03, .17, s * (width - .035), -.33, .08, edge); // door handles
    }
  }
  for (const [parts, material] of [[solid, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x171c20 })],
    [lit, new THREE.MeshBasicMaterial({ vertexColors: true })]]) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), material); mesh.name = 'cockpit-fittings';
    group.add(mesh); parts.forEach(g => g.dispose());
  }
  const hidden = [...new Set([root.userData.canopy, ...blockers].filter(Boolean))];
  let active = false, wrecked = false;
  const apply = () => {
    group.visible = active && !wrecked;
    for (const mesh of hidden) mesh.visible = !group.visible && (mesh !== root.userData.canopy || !wrecked);
  };
  const wreck = root.userData.wreck;
  root.userData.wreck = on => { wreck(on); wrecked = on; apply(); };
  root.userData.cockpit = { group, eye, setVisible(on) { active = on; apply(); } };
}

// Called once a frame, but touches visibility/projection only when the model or mode changes.
export function createCockpitView(camera) {
  const near = camera.near;
  let current = null;
  return (model, enabled) => {
    const next = enabled ? model?.userData.cockpit : null;
    if (next === current) return;
    current?.setVisible(false); next?.setVisible(true); current = next;
    camera.near = next ? .06 : near; camera.updateProjectionMatrix();
  };
}
