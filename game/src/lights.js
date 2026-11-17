// Vehicle-space anchors: +x left, +z forward. Remotes use lenses only.
// A model's userData.lights (all in its lightMount's space unless said otherwise):
//   head / tail: [Vector3] lens centres on the drawn lamps; nav: { left, right, tail, strobe } (aircraft)
//   lens: { head: [outline], tail: [outline] }  optional, per anchor: the drawn lamp's outline [[x, y, z], …] (flat,
//         on the lamp's face, every corner visible from its middle); the glowing lens is that shape just proud of it.
//         Without one: a small plate facing ±z.
//   beam: [Vector3]  optional: the lamps the road beam starts from and the glows sit on (default: head)
//   aim: Vector3     optional (aircraft): the landing light's direction (default: forward, 8° down)
//   mounts: { head } optional: the part the head lamps ride on, if not the lightMount (the dirt bike's bars); head
//         anchors and outlines are then in its space, beam points stay in the lightMount's
import * as THREE from 'three';

export function lightsEnabled(night, override = null) {
  return override === null ? night > 0 : override;
}
// The L override ends when the automatic choice flips or the look changes at once (a preset or "Time now"), not on
// the day/night cycle's gradual change of `night` from frame to frame.
export function nightChanged(last, night) {
  return last !== null && (lightsEnabled(night) !== lightsEnabled(last) || Math.abs(night - last) > .05);
}

export function lightAnchors(mesh, kind = 'car') {
  if (mesh.userData.lights) return mesh.userData.lights;
  // Measure in model space even if the vehicle is already placed in the world.
  const box = new THREE.Box3(), inverse = mesh.matrixWorld.clone();
  mesh.updateWorldMatrix(true, true); inverse.copy(mesh.matrixWorld).invert();
  mesh.traverse(o => {
    if (!o.isMesh) return;
    o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, o.matrixWorld)));
  });
  if (box.isEmpty()) box.set(new THREE.Vector3(-.5, 0, -1), new THREE.Vector3(.5, 1, 1));
  const y = box.min.y + (box.max.y - box.min.y) * .45;
  const point = (x, z) => new THREE.Vector3(x, y, z);
  if (kind === 'jet') return { head: [], tail: [], nav: {
    left: point(box.max.x, 0), right: point(box.min.x, 0), tail: point(0, box.min.z), strobe: point(0, box.max.z),
  } };
  const xs = kind === 'car' ? [box.min.x * .65, box.max.x * .65] : [0];
  return { head: xs.map(x => point(x, box.max.z + .03)), tail: xs.map(x => point(x, box.min.z - .03)) };
}

const LENS_LIFT = .004;                       // lens in front of the drawn lamp's face (m)
const HEAD_LENS = '#fff8ee', TAIL_LENS = '#ff1828', GLOW = '#fff1e2';
// Lens plate for a lamp: its outline lifted along the face normal, as a fan around the anchor (the mesh's position).
function lensGeometry(anchor, outline, role) {
  const pts = outline ? outline.map(p => new THREE.Vector3(...p))
    : Array.from({ length: 8 }, (_, i) => {                    // fallback: a rounded plate facing ±z
      const a = (i + .5) * Math.PI / 4;
      return anchor.clone().add(new THREE.Vector3(.135 * Math.cos(a), .08 * Math.sin(a), 0));
    });
  const n = new THREE.Vector3();                             // Newell normal
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n.x += (a.y - b.y) * (a.z + b.z); n.y += (a.z - b.z) * (a.x + b.x); n.z += (a.x - b.x) * (a.y + b.y);
  }
  n.normalize();
  // face away from the body: lamps sit on the outside, so along the anchor's offset from the mount (tails: backward)
  const out = outline ? anchor : new THREE.Vector3(0, 0, role === 'tail' ? -1 : 1);
  if (n.dot(out) < 0) { pts.reverse(); n.negate(); }
  const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
  const position = [c, ...pts].flatMap(p => p.clone().addScaledVector(n, LENS_LIFT).sub(anchor).toArray());
  const index = pts.flatMap((_, i) => [0, i + 1, (i + 1) % pts.length + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3)); g.setIndex(index); g.computeVertexNormals();
  return g;
}
// soft round glow (alpha falls off from a bright core), shared by every rig and never disposed
let glowTexture = null;
function glowMap() {
  if (glowTexture) return glowTexture;
  const N = 32, data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const r = Math.min(1, Math.hypot(i + .5 - N / 2, j + .5 - N / 2) / (N / 2)), k = (j * N + i) * 4;
    data[k] = data[k + 1] = data[k + 2] = 255;
    data[k + 3] = Math.round(255 * Math.max(0, (1 - r) ** 2.2 * .55 + Math.max(0, 1 - r * 3.5) ** 2 * .45));
  }
  glowTexture = new THREE.DataTexture(data, N, N); glowTexture.magFilter = glowTexture.minFilter = THREE.LinearFilter;
  glowTexture.needsUpdate = true;
  return glowTexture;
}

// No THREE.Light is created here. skin.vehicle supplies kind for multiplayer models.
// Call update({night, on?, brake?, time?, distance?}) each frame; dispose before removing a remote.
// Optional distance culls remote lenses beyond 400 m. Anchors describe the model's rest pose.
// Each head / tail lamp is a flat glowing copy of its drawn lamp's outline (anchors.lens); each beam lamp also gets a soft glow
// facing forward, seen from in front of the vehicle only (a one-sided plate: edge-on from the side, hidden from behind).
export function createVehicleLightLenses(mesh, kind = 'car') {
  const anchors = lightAnchors(mesh, kind), group = new THREE.Group(); group.name = 'vehicle-lenses';
  const lightMount = mesh.userData.lightMount || mesh, headMount = anchors.mounts?.head || lightMount;
  // head lenses on another part (the dirt bike's bars) go in a group of their own there
  const headGroup = headMount === lightMount ? group : new THREE.Group();
  if (headGroup !== group) headGroup.name = 'vehicle-lenses-head';
  // Lenses and glows must not count as body skin in wheel-arch or ground-clearance measurements.
  group.userData.cosmetic = headGroup.userData.cosmetic = true;
  const ball = new THREE.SphereGeometry(kind === 'jet' ? .13 : .09, 6, 4), geometries = [ball];
  const materials = new Map(), lamps = [];
  const materialFor = color => {
    if (!materials.has(color)) materials.set(color, new THREE.MeshLambertMaterial({ color: 0x000000, emissive: color, toneMapped: false }));
    return materials.get(color);
  };
  const glowMaterial = new THREE.MeshBasicMaterial({ map: glowMap(), color: GLOW, transparent: true, opacity: .5,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const glowPlane = new THREE.PlaneGeometry(1, 1); geometries.push(glowPlane);
  function add(position, color, role, outline) {
    let geometry = ball;
    if (role === 'head' || role === 'tail') geometries.push(geometry = lensGeometry(position, outline, role));
    const material = materialFor(color);
    const lens = new THREE.Mesh(geometry, material); lens.position.copy(position);
    lens.name = `vehicle-light-${role}`;
    (role === 'head' ? headGroup : group).add(lens); lamps.push({ lens, material, role, color: new THREE.Color(color) });
    return lens;
  }
  const heads = (anchors.head || []).map((p, i) => add(p, HEAD_LENS, 'head', anchors.lens?.head?.[i]));
  (anchors.tail || []).forEach((p, i) => add(p, TAIL_LENS, 'tail', anchors.lens?.tail?.[i]));
  for (const [role, p] of Object.entries(anchors.nav || {})) {
    for (const point of Array.isArray(p) ? p : [p]) add(point, role === 'left' ? '#ff1828' : role === 'right' ? '#18ff54' : '#ffffff', role === 'tail' ? 'nav-tail' : role);
  }
  // glows: on the beam lamps (the head lenses themselves when they ride on another part), each a child of the nearest
  // head lens so it shows and hides with it, facing the way the light shines
  const glowAt = headGroup !== group || !anchors.beam ? anchors.head || [] : anchors.beam;
  const glowSize = kind === 'jet' ? 1.6 : kind === 'bike' ? .75 : .95;
  const facing = kind === 'jet' ? (anchors.aim || LANDING_AIM).clone().normalize() : FORWARD;
  for (const p of heads.length ? glowAt : []) {
    const near = heads.reduce((a, b) => b.position.distanceTo(p) < a.position.distanceTo(p) ? b : a);
    const glow = new THREE.Mesh(glowPlane, glowMaterial); glow.name = 'vehicle-glow';
    glow.position.copy(p).sub(near.position).addScaledVector(facing, .02);
    glow.quaternion.setFromUnitVectors(FORWARD, facing); glow.scale.setScalar(glowSize); glow.renderOrder = 2;
    near.add(glow);
  }
  lightMount.add(group);
  if (headGroup !== group) headMount.add(headGroup);
  return {
    anchors, group,
    update({ night = 0, on = night > 0, brake = 0, time = 0, distance = 0 } = {}) {
      group.visible = headGroup.visible = distance <= 400;
      for (const { lens, material, role, color } of lamps) {
        const stopping = role === 'tail' && brake > 0;
        lens.visible = on || stopping;
        if (role === 'strobe') lens.visible = on && time % 1.2 < .09;
        // Keep the running tail below display clipping so brakes visibly brighten it.
        material.emissive.copy(color);
        material.emissiveIntensity = role === 'tail' ? (kind === 'jet' ? 1 : stopping ? 1 : .2) : 1;
      }
    },
    dispose() {
      group.removeFromParent(); headGroup.removeFromParent();
      geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); glowMaterial.dispose();
    },
  };
}

// ---------------------------------------------------------------- the road beam
// One SpotLight shaped like a pair of low beams in the shader (three's spot cone is round: wide enough for the road,
// it would also be tall, and its ground pool would be a blob in front of the bumper). The shape, for the scene's spot
// lights (there is only this one), replaces three's cone in `lights_pars_begin`, before anything compiles:
//   - wide sideways (the light's `angle`, soft edge from its `penumbra`), down as far as sideways; up only to
//     BEAM_UP above the horizon (a low-beam cut-off: trees and signs above the lamps stay dark)
//   - stronger toward the horizon as real lamps are, so the road is evenly lit from ~5 m to PLATEAU_END and then
//     fades (1/d, and three's distance cut-off ends it at the light's `distance`)
//   - nothing within BEAM_NEAR[0] m ahead of the light, full from BEAM_NEAR[1] m: no hot spot on the bumper or road
//     right under it, and nothing behind the lamps (the car itself)
// The light's decay is 0: the shape does the fall-off. beamAttenuation() is the same maths in JS (tests).
export const AIM_DISTANCE = 30, PLATEAU_END = 22, BEAM_UP = .05, BEAM_NEAR = [1, 6];
const BEAM_EVEN = AIM_DISTANCE / PLATEAU_END;
const glsl = n => Number.isInteger(n) ? n.toFixed(1) : String(n);
export const BEAM_GLSL = /* glsl */`
	// lights.js: the vehicle beam (a low-beam pool) instead of a round cone
	float yrBeamAttenuation( const in SpotLight spotLight, const in vec3 lVector ) {
		vec3 axis = - spotLight.direction, toFrag = - lVector;
		float ahead = dot( toFrag, axis );
		if ( ahead <= 0.0 ) return 0.0;
		vec3 up = normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz );
		vec3 side = cross( axis, up );
		float s = length( side );
		if ( s < 0.001 ) return smoothstep( spotLight.coneCos, spotLight.penumbraCos, dot( normalize( lVector ), spotLight.direction ) );
		side /= s;
		vec3 vert = cross( side, axis );
		float dip = - dot( axis, up ) / s;
		float coneTan = sqrt( max( 1.0 - spotLight.coneCos * spotLight.coneCos, 0.0 ) ) / spotLight.coneCos;
		float innerTan = sqrt( max( 1.0 - spotLight.penumbraCos * spotLight.penumbraCos, 0.0 ) ) / spotLight.penumbraCos;
		float x = dot( toFrag, side ) / ahead, y = dot( toFrag, vert ) / ahead;
		float r = length( vec2( x / coneTan, y > 0.0 ? y / ( max( dip, 0.0 ) + ${glsl(BEAM_UP)} ) : - y / coneTan ) );
		float even = dip > 0.0 ? min( 1.0, ${glsl(BEAM_EVEN)} * dip / max( dip - y, 0.0001 ) ) : 1.0;
		float edge = 1.0 - smoothstep( min( innerTan / coneTan, 0.95 ), 1.0, r );
		return edge * even * smoothstep( ${glsl(BEAM_NEAR[0])}, ${glsl(BEAM_NEAR[1])}, ahead );
	}
`;
const _side = new THREE.Vector3(), _vert = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const smoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// toFrag: light → point; axis: unit beam direction; the cone from the light's angle / penumbra
export function beamAttenuation(toFrag, axis, angle, penumbra, up = UP) {
  const ahead = toFrag.dot(axis);
  if (ahead <= 0) return 0;
  _side.crossVectors(axis, up); const s = _side.length();
  if (s < .001) return smoothstep(Math.cos(angle), Math.cos(angle * (1 - penumbra)), toFrag.clone().normalize().dot(axis));
  _side.divideScalar(s); _vert.crossVectors(_side, axis);
  const dip = -axis.dot(up) / s, coneTan = Math.tan(angle), innerTan = Math.tan(angle * (1 - penumbra));
  const x = toFrag.dot(_side) / ahead, y = toFrag.dot(_vert) / ahead;
  const r = Math.hypot(x / coneTan, y > 0 ? y / (Math.max(dip, 0) + BEAM_UP) : -y / coneTan);
  const even = dip > 0 ? Math.min(1, BEAM_EVEN * dip / Math.max(dip - y, 1e-4)) : 1;
  return (1 - smoothstep(Math.min(innerTan / coneTan, .95), 1, r)) * even * smoothstep(BEAM_NEAR[0], BEAM_NEAR[1], ahead);
}
// Patch three's spot light once (true if it took; if three's shader text ever changes, the beam stays a plain cone).
export function installBeamShader(chunks = THREE.ShaderChunk) {
  const src = chunks.lights_pars_begin, call = 'float spotAttenuation = getSpotAttenuation( spotLight.coneCos, spotLight.penumbraCos, angleCos );';
  if (src.includes('yrBeamAttenuation')) return true;
  if (!src.includes(call) || !src.includes('void getSpotLightInfo(')) { console.warn('lights.js: headlight beam shape not installed'); return false; }
  chunks.lights_pars_begin = src.replace('void getSpotLightInfo(', `${BEAM_GLSL}\n\tvoid getSpotLightInfo(`)
    .replace(call, 'float spotAttenuation = yrBeamAttenuation( spotLight, lVector );');
  return true;
}
export const BEAM_SHADER = installBeamShader();

export const HEADLIGHT_FADE = 8;                  // 1/s the beam eases on / off
// Ground vehicles: dipped beams (road lit evenly to PLATEAU_END at ROAD_LIGHT, gone by `distance`). Aircraft: a
// narrower, longer landing light, aimed down and forward (anchors.aim), at a fixed strength.
export const BEAMS = {
  road: { color: '#fff4e8', angle: .7, penumbra: .55, distance: 60 },
  landing: { color: '#fff4e8', angle: .32, penumbra: .5, distance: 260, intensity: 45 },
};
// Irradiance on the road in the even part of the pool. A wall facing the lamps gets ~PLATEAU_END / height times
// that (the road is lit at a grazing angle), so lamps lower than STRENGTH_HEIGHT light the road a little less rather
// than walls a lot more.
export const ROAD_LIGHT = 1.3, STRENGTH_HEIGHT = .45;
const BEAM_AHEAD = .25;                           // the light sits this far ahead of the lamps (m)
const FORWARD = new THREE.Vector3(0, 0, 1), LANDING_AIM = new THREE.Vector3(0, -Math.sin(.14), Math.cos(.14));
// Where a mesh's beam starts and points (its lightMount's space) and how strong it is. Ground vehicles aim the beam's
// axis at the ground AIM_DISTANCE ahead; the lamps' height over the tyres' lowest point sets the strength (a low race
// car and a tall truck light the road alike).
export function beamFor(mesh, kind, anchors = lightAnchors(mesh, kind)) {
  const mount = mesh.userData.lightMount || mesh, points = anchors.beam || anchors.head || [];
  const from = new THREE.Vector3();
  for (const p of points) from.add(p);
  if (points.length) from.multiplyScalar(1 / points.length);
  if (kind === 'jet') {
    const aim = (anchors.aim || LANDING_AIM).clone().normalize();
    return { ...BEAMS.landing, from: from.addScaledVector(aim, BEAM_AHEAD), to: from.clone().addScaledVector(aim, AIM_DISTANCE), height: null };
  }
  // tyres' lowest point in the mount's space (lenses excluded)
  mesh.updateWorldMatrix(true, true);
  const inverse = mount.matrixWorld.clone().invert(), box = new THREE.Box3(), m = new THREE.Matrix4();
  mesh.traverse(o => {
    if (!o.isMesh || o.name.startsWith('vehicle-')) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    box.union(o.geometry.boundingBox.clone().applyMatrix4(m.multiplyMatrices(inverse, o.matrixWorld)));
  });
  from.z += BEAM_AHEAD;
  const height = Math.max(.3, box.isEmpty() ? .6 : from.y - box.min.y);
  return { ...BEAMS.road, from, to: from.clone().add(new THREE.Vector3(0, -height, AIM_DISTANCE)), height,
    intensity: ROAD_LIGHT * PLATEAU_END / Math.max(height, STRENGTH_HEIGHT) };
}

// The player's lights: lenses on the current vehicle's model plus one shared headlight beam.
// The SpotLight stays in `scene` for good and is never hidden: adding, removing or hiding a light changes the
// scene's light count, and three.js then recompiles every lit material (a stutter). Off = intensity faded to 0.
// Each frame the beam is placed from the beam lamps in the model's light mount, so a vehicle switch or a Garage type
// change (another mesh) just picks that mesh's lenses and moves the beam. Each mesh's lenses are made once and kept
// with it: disposing them would free their shader program, and the next vehicle's lenses would compile it again.
// Changing the beam's angle, distance or colour per vehicle is only uniforms (no recompile).
export function createVehicleLights(scene = null) {
  // One shared light, never a shadow pass, decay 0 (the beam shape above does the fall-off).
  const spot = new THREE.SpotLight(BEAMS.road.color, 0, BEAMS.road.distance, BEAMS.road.angle, BEAMS.road.penumbra, 0);
  spot.name = 'player-headlight'; spot.castShadow = false;
  const target = new THREE.Object3D(); target.name = 'headlight-target'; spot.target = target;
  scene?.add(spot, target);
  let lenses = null, mount = null, beam = false, shape = null, level = 0;
  let override = null, lastNight = null, currentMesh = null, elapsed = 0;
  const rigs = new Map();                   // vehicle mesh → { lenses, shape }
  const rigFor = (mesh, kind) => {
    let r = rigs.get(mesh);
    if (!r) { const l = createVehicleLightLenses(mesh, kind); rigs.set(mesh, r = { lenses: l, shape: beamFor(mesh, kind, l.anchors) }); }
    return r;
  };
  return {
    spot,
    get override() { return override; },
    get on() { return lightsEnabled(lastNight || 0, override); },
    get beam() { return beam; },                // whether the beam is wanted (it fades in / out from there)
    get lenses() { return lenses; },
    get shape() { return shape; },              // the current mesh's beam: from / to (mount space), intensity, cone
    // lenses for a model before it is first driven (warmup.js compiles them with it)
    prepare(mesh, kind) { return rigFor(mesh, kind).lenses; },
    toggle(night = lastNight || 0) {
      if (nightChanged(lastNight, night)) override = null;
      lastNight = night;
      override = !lightsEnabled(night, override); return override;
    },
    update(dt, vehicle, night = 0, input = {}) {
      elapsed += dt;
      // A change between day/dusk/night restores automatic operation; L overrides it.
      if (nightChanged(lastNight, night)) override = null;
      lastNight = night;
      const mesh = vehicle.mesh;
      const on = lightsEnabled(night, override);
      if (currentMesh !== mesh) {
        currentMesh = mesh;
        ({ lenses, shape } = rigFor(mesh, vehicle.kind));
        mount = mesh.userData.lightMount || mesh;
        spot.angle = shape.angle; spot.penumbra = shape.penumbra; spot.distance = shape.distance; spot.color.set(shape.color);
        level = Math.min(1, spot.intensity / shape.intensity);       // carry on from the same strength (no pop)
      }
      const aircraft = vehicle.kind === 'jet';
      beam = !aircraft && on && mesh.visible && lenses.anchors.head?.length > 0;
      // `level` (0..1) eases; the intensity follows the current mesh's strength, so a switch fades without a pop
      const want = beam ? 1 : 0;
      level += (want - level) * Math.min(1, dt * HEADLIGHT_FADE);
      if (Math.abs(want - level) < .003) level = want;
      spot.intensity = level * shape.intensity;
      mount.updateWorldMatrix(true, false);
      spot.position.copy(shape.from).applyMatrix4(mount.matrixWorld);
      target.position.copy(shape.to).applyMatrix4(mount.matrixWorld);
      const grounded = vehicle.grounded === true || vehicle.wheels?.some(w => w.contact) === true;
      const braking = vehicle.kind !== 'jet' && grounded && !vehicle.glide?.active
        ? Math.max(input.brake || 0, input.handbrake ? 1 : 0) : 0;
      lenses.update({ on, brake: braking, time: elapsed });
    },
    dispose() { spot.removeFromParent(); target.removeFromParent(); spot.dispose(); rigs.forEach(r => r.lenses.dispose()); rigs.clear(); lenses = null; currentMesh = null; },
  };
}
