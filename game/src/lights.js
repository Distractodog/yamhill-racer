// Vehicle-space anchors: +x left, +z forward. Remotes use lenses only.
import * as THREE from 'three';

export function lightsEnabled(night, override = null) {
  return override === null ? night > 0 : override;
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

// No THREE.Light is created here. skin.vehicle supplies kind for multiplayer models.
// Call update({night, on?, brake?, time?, distance?}) each frame; dispose before removing a remote.
// Optional distance culls remote lenses beyond 400 m. Anchors describe the model's rest pose.
export function createVehicleLightLenses(mesh, kind = 'car') {
  const anchors = lightAnchors(mesh, kind), group = new THREE.Group(); group.name = 'vehicle-lenses';
  const geometry = new THREE.SphereGeometry(kind === 'jet' ? .13 : .09, 6, 4);
  const materials = [], lamps = [];
  function add(position, color, role) {
    const material = new THREE.MeshLambertMaterial({ color: 0x000000, emissive: color, toneMapped: false });
    const lens = new THREE.Mesh(geometry, material); lens.position.copy(position);
    lens.name = `vehicle-light-${role}`;
    if (role === 'head' || role === 'tail') lens.scale.set(1.5, 1, .55);
    group.add(lens); materials.push(material); lamps.push({ lens, material, role, color: new THREE.Color(color) });
  }
  for (const p of anchors.head || []) add(p, '#fff4dc', 'head');
  for (const p of anchors.tail || []) add(p, '#ff1828', 'tail');
  for (const [role, p] of Object.entries(anchors.nav || {})) {
    for (const point of Array.isArray(p) ? p : [p]) add(point, role === 'left' ? '#ff1828' : role === 'right' ? '#18ff54' : '#ffffff', role === 'tail' ? 'nav-tail' : role);
  }
  (mesh.userData.lightMount || mesh).add(group);
  return {
    anchors, group,
    update({ night = 0, on = night > 0, brake = 0, time = 0, distance = 0 } = {}) {
      group.visible = distance <= 400;
      for (const { lens, material, role, color } of lamps) {
        const stopping = role === 'tail' && brake > 0;
        lens.visible = on || stopping;
        if (role === 'strobe') lens.visible = on && time % 1.2 < .09;
        // Keep the running tail below display clipping so brakes visibly brighten it.
        material.emissive.copy(color);
        material.emissiveIntensity = role === 'tail' ? (stopping ? 1 : .2) : 1;
      }
    },
    dispose() { group.removeFromParent(); geometry.dispose(); materials.forEach(m => m.dispose()); },
  };
}

export const HEADLIGHT = 220, HEADLIGHT_FADE = 8;     // spot intensity when on; 1/s it eases on / off

// The player's lights: lenses on the current vehicle's model plus one shared headlight beam.
// The SpotLight stays in `scene` for good and is never hidden: adding, removing or hiding a light changes the
// scene's light count, and three.js then recompiles every lit material (a stutter). Off = intensity faded to 0.
// Each frame the beam is placed from the head anchors in the model's light mount, so a vehicle switch or a Garage type
// change (another mesh) just picks that mesh's lenses and moves the beam. Each mesh's lenses are made once and kept
// with it: disposing them would free their shader program, and the next vehicle's lenses would compile it again.
export function createVehicleLights(scene = null) {
  // One shared light, never a shadow pass. A broad beam serves both car lenses.
  const spot = new THREE.SpotLight('#fff4dc', 0, 95, .43, .65, 1.2);
  spot.name = 'player-headlight'; spot.castShadow = false;
  const target = new THREE.Object3D(); target.name = 'headlight-target'; spot.target = target;
  scene?.add(spot, target);
  const from = new THREE.Vector3(), to = new THREE.Vector3();     // beam start / aim in the light mount's space
  let lenses = null, mount = null, beam = false;
  let override = null, lastNight = null, currentMesh = null, elapsed = 0;
  const rigs = new Map();                   // vehicle mesh → its lenses
  const rigFor = (mesh, kind) => { let r = rigs.get(mesh); if (!r) rigs.set(mesh, r = createVehicleLightLenses(mesh, kind)); return r; };
  return {
    spot,
    get override() { return override; },
    get on() { return lightsEnabled(lastNight || 0, override); },
    get beam() { return beam; },                // whether the beam is wanted (it fades in / out from there)
    get lenses() { return lenses; },
    // lenses for a model before it is first driven (warmup.js compiles them with it)
    prepare(mesh, kind) { return rigFor(mesh, kind); },
    toggle(night = lastNight || 0) {
      if (lastNight !== null && night !== lastNight) override = null;
      lastNight = night;
      override = !lightsEnabled(night, override); return override;
    },
    update(dt, vehicle, night = 0, input = {}) {
      elapsed += dt;
      // A change between day/dusk/night restores automatic operation; L overrides it.
      if (lastNight !== null && night !== lastNight) override = null;
      lastNight = night;
      const mesh = vehicle.mesh;
      const on = lightsEnabled(night, override);
      if (currentMesh !== mesh) {
        currentMesh = mesh;
        lenses = rigFor(mesh, vehicle.kind);
        mount = mesh.userData.lightMount || mesh;
        const head = lenses.anchors.head || [];
        from.set(0, 0, 0);
        for (const p of head) from.add(p);
        if (head.length) from.multiplyScalar(1 / head.length);
        from.y += .12;
        to.copy(from).add(_aim);
      }
      beam = on && mesh.visible && (vehicle.kind !== 'jet' || !!mesh.userData.landingLight) && lenses.anchors.head?.length > 0;     // aircraft: only a landing light casts a beam
      const want = beam ? HEADLIGHT : 0;
      spot.intensity += (want - spot.intensity) * Math.min(1, dt * HEADLIGHT_FADE);
      if (Math.abs(want - spot.intensity) < .5) spot.intensity = want;
      mount.updateWorldMatrix(true, false);
      spot.position.copy(from).applyMatrix4(mount.matrixWorld);
      target.position.copy(to).applyMatrix4(mount.matrixWorld);
      const grounded = vehicle.grounded === true || vehicle.wheels?.some(w => w.contact) === true;
      const braking = vehicle.kind !== 'jet' && grounded && !vehicle.glide?.active
        ? Math.max(input.brake || 0, input.handbrake ? 1 : 0) : 0;
      lenses.update({ on, brake: braking, time: elapsed });
    },
    dispose() { spot.removeFromParent(); target.removeFromParent(); spot.dispose(); rigs.forEach(r => r.dispose()); rigs.clear(); lenses = null; currentMesh = null; },
  };
}
const _aim = new THREE.Vector3(0, -1.4, 35);
