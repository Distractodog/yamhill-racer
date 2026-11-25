// First-person-only fittings. +z forward; all dimensions are relative to the pilot's eye.
// Static fittings merge into two meshes. Needles share one instanced draw; instrument updates allocate nothing.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function addCockpit(root, { style, eye, width = .52, depth = .8, blockers = [] }) {
  const group = new THREE.Group(); group.name = 'cockpit'; group.visible = false;
  // Optional lateral seat coordinate: translate the first-person deck around the eye.
  // The camera's existing height/forward convention and exterior framing stay unchanged.
  group.position.set(style === 'airliner' ? -(eye[2] ?? 0) : 0, eye[0], eye[1]); root.add(group);
  const solid = [], lit = [], dials = [];
  let attitude = null;
  const dark = 0x30353a, edge = 0x788287, leather = 0x393532, face = style === 'prop' ? 0x59584f : 0x343e44;
  const jet = style === 'fighter' || style === 'stealth', heli = style === 'heli', airliner = style === 'airliner';
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
  function bar(a, b, r = .009, color = edge) {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b), delta = end.clone().sub(start);
    const geo = new THREE.BoxGeometry(r * 2, delta.length(), r * 2);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    start.add(end).multiplyScalar(.5); part(geo, color, ...start);
  }
  // Slightly overhanging, warm charcoal coaming with a stitched-looking inset edge.
  box(width * 2, .31, .09, 0, -.46, depth, face);
  box(width * 2 + .06, .035, .10, 0, -.29, depth - .015, leather);
  box(width * 2 + .04, .012, .018, 0, -.306, depth - .075, 0x696056);
  const plane = (w, h, x, y, z, color, angle = 0) =>
    part(new THREE.PlaneGeometry(w, h).rotateZ(angle).rotateY(Math.PI), color, x, y, z, true);
  function ring(x, y, r, color, z = depth - .055, segments = 16) {
    part(new THREE.RingGeometry(r * .86, r, segments).rotateY(Math.PI), color, x, y, z, true);
  }
  function gauge(x, y, r = .066, signal = 'speed') {
    ring(x, y, r, 0x8e9999);
    part(new THREE.CircleGeometry(r * .85, 16).rotateY(Math.PI), 0x111d24, x, y, depth - .056, true);
    for (let i = 0; i < 8; i++) {
      const angle = -Math.PI * .75 + i / 7 * Math.PI * 1.5;
      plane(.004, r * .16, x - Math.sin(angle) * r * .68, y + Math.cos(angle) * r * .68,
        depth - .058, i === 7 ? 0xd98462 : 0xd5d6bc, -angle);
    }
    part(new THREE.CircleGeometry(r * .1, 8).rotateY(Math.PI), 0xbdbba7, x, y, depth - .063, true);
    dials.push({ x, y, r, signal });
  }
  if (jet) {
    for (const side of [-1, 1]) {
      const x = side * width * .56;
      box(.235, .205, .012, x, -.43, depth - .055, 0x151c20);
      plane(.207, .177, x, -.43, depth - .063, 0x102a2d);
      for (const dx of [-.086, -.043, 0, .043, .086])
        plane(.016, .008, x + dx, -.535, depth - .064, 0x93a899);
    }
    // A bounded circular attitude display. The shader moves only the horizon inside its fixed bezel.
    const uniforms = { bank: { value: 0 }, pitch: { value: 0 },
      sky: { value: new THREE.Color(0x397d9c) }, ground: { value: new THREE.Color(0x926843) } };
    const display = new THREE.ShaderMaterial({ uniforms, side: THREE.DoubleSide,
      vertexShader: `varying vec2 dial; void main() { dial = position.xy / .077;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 dial; uniform float bank; uniform float pitch; uniform vec3 sky; uniform vec3 ground;
        void main() { float h = dot(dial, vec2(sin(bank), cos(bank))) + pitch;
          vec3 color = mix(ground, sky, smoothstep(-.02, .02, h));
          color = mix(color, vec3(.75), 1.0-smoothstep(.015, .035, abs(h)));
          gl_FragColor = vec4(color, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }` });
    attitude = new THREE.Mesh(new THREE.CircleGeometry(.077, 24), display);
    attitude.position.set(width * .56, -.43, depth - .067); group.add(attitude);
    ring(width * .56, -.43, .082, 0x668e8a, depth - .068);
    plane(.06, .005, width * .56, -.43, depth - .071, 0xefe5ad);
    plane(.005, .023, width * .56, -.442, depth - .071, 0xefe5ad);
    // Radar range rings, cardinal axes, ownship and a pair of returns.
    const radarX = -width * .56;
    for (const r of [.036, .071]) ring(radarX, -.43, r, 0x4c927f, depth - .067);
    plane(.16, .002, radarX, -.43, depth - .069, 0x4c927f);
    plane(.002, .15, radarX, -.43, depth - .069, 0x4c927f);
    for (const [x, y] of [[.026, .035], [-.038, -.022], [0, 0]])
      plane(.009, .009, radarX + x, -.43 + y, depth - .071, 0xc1e7ac, Math.PI / 4);
    gauge(0, -.43, .055);
    // Open HUD combiner frame: clear centre preserves the horizon, etched green reference marks.
    for (const s of [-1, 1]) bar([s * .15, -.27, depth], [s * .15, .04, depth + .09], .006);
    bar([-.15, .04, depth + .09], [.15, .04, depth + .09], .006);
    box(.10, .004, .004, 0, -.075, depth + .075, 0x68cda2, true);
    box(.004, .026, .004, 0, -.075, depth + .075, 0x68cda2, true);
  } else if (airliner) {
    // Captain's primary instruments sit ahead, clear of the lower-left HUD overlay.
    for (const side of [-1, 1]) {
      const x = side * .43;
      gauge(x - .12, -.39, .065, 'speed');
      gauge(x + .12, -.39, .065, 'altitude');
      const screenX = x - .31;
      box(.22, .14, .014, screenX, -.41, depth - .055, 0x151c20);
      plane(.20, .12, screenX, -.41, depth - .065, 0x143c40);
      plane(.15, .003, screenX, -.41, depth - .068, 0x7ba9a5);
      plane(.003, .09, screenX, -.41, depth - .068, 0x7ba9a5);
    }
    box(.29, .24, .6, 0, -.65, .33, face); // centre pedestal and four thrust levers
    for (const x of [-.09, -.03, .03, .09]) box(.025, .09, .04, x, -.49, .43, 0xd6d1b9);
    // Shallow, light overhead: only its front edge is in view, even at cruise FOV.
    box(.48, .035, .12, 0, .65, .72, 0x8b9499, true);
    for (const z of [.68, .72, .76]) for (const x of [-.12, .12])
      box(.022, .012, .025, x, .625, z, 0xd7d4bd, true);
    bar([0, -.34, depth + .08], [0, .64, depth * .88], .0065); // windscreen centre post
  } else {
    gauge(-.23 * width / .52, -.4, .066, heli ? 'rotor' : 'speed');
    gauge(0, -.4, .066, 'altitude');
    gauge(.23 * width / .52, -.4, .066, 'climb');
    gauge(-.12 * width / .52, -.54, .045, 'throttle');
    gauge(.12 * width / .52, -.54, .045, 'heading');
  }
  // Sills, side consoles, seat bolsters and the headrest behind the eye.
  for (const s of [-1, 1]) {
    box(.10, .44, depth + .45, s * (width + .035), -.45, depth * .4, face);
    box(.14, .035, depth + .47, s * (width + .035), -.22, depth * .4, leather);
    bar([s * (width - .025), -.20, -.08], [s * (width - .025), -.20, depth + .1], .006);
    box(.15, .045, .65, s * (width - .04), -.425, .16);
    box(.09, .35, .32, s * .24, -.61, -.17);
    for (const z of [.23, .34]) box(.025, .018, .04, s * width, -.395, z, 0xc2b89b);
    // Trainer's squared windscreen; the other aircraft have swept, faceted bubble bows.
    if (airliner) {
      bar([s * width, -.20, depth + .05], [s * width * .94, .64, depth * .96], .0045);
      bar([s * width * .94, .64, depth * .96], [0, .64, depth * .88], .0045);
    } else if (style === 'prop') {
      bar([s * width, -.20, depth + .05], [s * width * .94, .25, depth * .96], .0065);
      bar([s * width * .94, .25, depth * .96], [0, .25, depth * .96], .0065);
    } else {
      const top = heli ? .32 : .26, shoulder = (style === 'stealth' || style === 'blackbird') ? .78 : .83;
      bar([s * width, -.20, depth + .05], [s * width * .98, .02, depth * .95], .0065);
      bar([s * width * .98, .02, depth * .95], [s * width * shoulder, top * .6, depth * .83], .0065);
      bar([s * width * shoulder, top * .6, depth * .83], [s * width * .43, top, depth * .63], .0065);
      bar([s * width * .43, top, depth * .63], [0, top + .035, depth * .615], .0065);
    }
  }
  box(.26, .23, .12, 0, -.12, -.3);
  // Throttle / collective to the left; central stick or the trainer's forked yoke.
  if (!airliner) {
    bar([width - .07, -.57, .16], [width - .07, -.34, .30], .016);
    box(.095, .04, .05, width - .07, -.33, .30, heli ? 0x444c50 : 0xb38345);
  }
  if (airliner) {
    for (const x of [-.43, .43]) {
      bar([x, -.73, .24], [x, -.47, .70], .014);
      bar([x-.14, -.47, .70], [x+.14, -.47, .70], .012);
      for (const s of [-1, 1]) bar([x+s*.14, -.47, .70], [x+s*.14, -.43, .70], .016, dark);
      box(.3, .35, .12, x, -.55, -.28, leather);
    }
  } else if (style === 'prop') {
    bar([0, -.55, depth - .05], [0, -.47, depth - .12], .02);
    bar([-.15, -.47, depth - .12], [.15, -.47, depth - .12], .018);
    for (const s of [-1, 1]) bar([s * .15, -.47, depth - .12], [s * .15, -.40, depth - .12], .023, dark);
  } else {
    bar([0, -.79, depth - .32], [0, -.46, depth - .08], .018);
    box(.05, .11, .06, 0, -.49, depth - .08);
    box(.025, .014, .025, 0, -.429, depth - .08, 0xbc5540);
  }
  if (heli) {
    box(.34, .055, .42, 0, .30, .63, face); // overhead switch panel
    for (const x of [-.09, 0, .09]) box(.024, .015, .04, x, .264, .72, 0xd3c8a1);
    for (const s of [-1, 1]) {
      bar([s * width, -.65, .1], [s * width, .25, .1], .011);
      box(.09, .03, .17, s * (width - .035), -.33, .08, edge); // door handles
    }
  }
  for (const [parts, material] of [[solid, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: 0x171c20 })],
    [lit, new THREE.MeshBasicMaterial({ vertexColors: true })]]) {
    const mesh = new THREE.Mesh(mergeGeometries(parts), material); mesh.name = 'cockpit-fittings';
    group.add(mesh); parts.forEach(g => g.dispose());
  }
  // All moving needles share a single tiny instanced mesh; every scratch object is built once.
  const needleGeometry = new THREE.BufferGeometry();
  needleGeometry.setAttribute('position', new THREE.Float32BufferAttribute([-.055, -.13, 0, 0, .60, 0, .055, -.13, 0], 3));
  const needles = new THREE.InstancedMesh(needleGeometry, new THREE.MeshBasicMaterial({ color: 0xf1dec0, side: THREE.DoubleSide }), dials.length);
  needles.name = 'cockpit-needles'; needles.frustumCulled = false;
  needles.instanceMatrix.setUsage(THREE.DynamicDrawUsage); group.add(needles);
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
  const axis = new THREE.Vector3(0, 0, 1);
  function update(v) {
    if (!group.visible) return;
    const q = v.renderQuat;
    const heading = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
    for (let i = 0; i < dials.length; i++) {
      const dial = dials[i];
      let value = 0;
      switch (dial.signal) {
        case 'speed': value = v.vel.length() * 3.6 / (style === 'blackbird' ? 3600 : airliner ? 1000 : jet ? 2000 : style === 'stunt' ? 450 : 300); break;
        case 'rotor': value = v.rotor ?? v.throttle ?? 0; break;
        case 'altitude': value = Math.max(0, v.renderPos.y) % 1000 / 1000; break;
        case 'climb': value = .5 + v.vel.y / 40; break;
        case 'throttle': value = v.throttle ?? 0; break;
        case 'heading': value = (heading + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2); break;
      }
      const angle = dial.signal === 'heading' ? value * Math.PI * 2 : (Math.max(0, Math.min(1, value)) - .5) * Math.PI * 1.5;
      position.set(dial.x, dial.y, depth - .061); scale.setScalar(dial.r); rotation.setFromAxisAngle(axis, angle);
      matrix.compose(position, rotation, scale); needles.setMatrixAt(i, matrix);
    }
    needles.instanceMatrix.needsUpdate = true;
    if (attitude) {
      attitude.material.uniforms.bank.value = Math.atan2(2 * (q.x * q.y + q.w * q.z), 1 - 2 * (q.x * q.x + q.z * q.z));
      attitude.material.uniforms.pitch.value = Math.max(-1.4, Math.min(1.4, Math.asin(Math.max(-1, Math.min(1, 2 * (q.y * q.z - q.w * q.x)))) * 2));
    }
  }
  const hidden = [...new Set([root.userData.canopy, ...blockers].filter(Boolean))];
  let active = false, wrecked = false;
  const apply = () => {
    group.visible = active && !wrecked;
    for (const mesh of hidden) mesh.visible = !group.visible && (mesh !== root.userData.canopy || !wrecked);
  };
  const wreck = root.userData.wreck;
  root.userData.wreck = on => { wreck(on); wrecked = on; apply(); };
  root.userData.cockpit = { group, eye, needles, attitude, update, setVisible(on) { active = on; apply(); } };
}

// Called once a frame, but touches visibility/projection only when the model or mode changes.
export function createCockpitView(camera) {
  const near = camera.near;
  let current = null;
  return (model, enabled, vehicle) => {
    const next = enabled ? model?.userData.cockpit ?? model?.userData.interior : null;
    if (next !== current) {
      current?.setVisible(false); next?.setVisible(true); current = next;
      camera.near = next ? .06 : near; camera.updateProjectionMatrix();
    }
    if (vehicle) current?.update(vehicle);
  };
}
