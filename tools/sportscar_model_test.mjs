// Sports car model checks in Node (no browser): triangle budget near/far, finite geometry, size, paint roles, light
// anchors, wheel layout for car.js / mp/remotes.js, faces pointing outward, and wheels clear of their arches at rest.
//   node tools/sportscar_model_test.mjs
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildVehicleTypeModel, typeInfo } from '../game/src/vehicletypes.js';
import { paintedModel } from '../game/src/cosmetics.js';

const model = buildVehicleTypeModel('car', 'sports'), ud = model.userData, spec = typeInfo('car', 'sports');
model.updateMatrixWorld(true);
const tris = o => { const g = o.geometry; return (g.index ? g.index.count : g.attributes.position.count) / 3; };
function count(root) {
  let n = 0; root.traverse(o => { if (o.isMesh) n += tris(o); }); return n;
}
const [nearGroup, farGroup] = ud.lod.levels.map(l => l.object);
const wheelTris = ud.wheels.reduce((s, w) => s + count(w.holder), 0);
const near = count(nearGroup) + wheelTris, far = count(farGroup) + wheelTris;
console.log(`triangles: near body ${count(nearGroup)}, far body ${count(farGroup)}, wheels ${wheelTris} → near ${near}, far ${far}`);
assert(near <= 6000, `near over budget: ${near}`);
assert(count(farGroup) <= 750, `far body over budget: ${count(farGroup)}`);
assert.equal(ud.lod.levels[1].distance > 30, true);

// finite positions and normals
model.traverse(o => {
  if (!o.isMesh) return;
  for (const name of ['position', 'normal']) assert(o.geometry.attributes[name].array.every(Number.isFinite), `${name} NaN in ${o.parent?.name}`);
});

// size: body only (no wheels), model space
const box = new THREE.Box3().setFromObject(nearGroup), size = box.getSize(new THREE.Vector3());
const ground = Math.min(...ud.wheels.map(w => w.holder.position.y - w.r));
console.log(`body: width ${size.x.toFixed(2)} m, length ${size.z.toFixed(2)} m, roof ${(box.max.y - ground).toFixed(2)} m above ground, ` +
  `clearance ${(box.min.y - ground).toFixed(2)} m`);
assert(size.x > 1.9 && size.x < 2.25, 'width'); assert(size.z > 4.3 && size.z < 4.8, 'length');
assert(box.max.y - ground > 1.05 && box.max.y - ground < 1.25, 'roof height');
// cabin roof (the wing sits lower than the roof)
const roof = new THREE.Box3(); nearGroup.traverse(o => { if (o.isMesh) { const p = o.geometry.attributes.position; for (let i = 0; i < p.count; i++) if (Math.abs(p.getZ(i)) < .5) roof.expandByPoint(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i))); } });
console.log(`roof above ground ${(roof.max.y - ground).toFixed(2)} m`);

// faces point outward (coarse): most faces look away from the centre line; arch ceilings and undersides legitimately
// do not. tools/model_raster_sportscar.mjs culls back faces like the game, so a flipped panel shows there as a hole.
{
  let out = 0, all = 0; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), m = new THREE.Vector3();
  nearGroup.traverse(o => {
    if (!o.isMesh) return; const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
      n.subVectors(b, a).cross(c.clone().sub(a)); if (n.lengthSq() < 1e-12) continue;
      m.copy(a).add(b).add(c).divideScalar(3); all++;
      if (n.dot(new THREE.Vector3(m.x, m.y - .2, m.z * .3)) > 0) out++;
    }
  });
  console.log(`outward-facing: ${(100 * out / all).toFixed(1)}% of ${all}`);
  assert(out / all > .78, 'too many faces point inward');
}

// paint roles the Garage offers
const roles = new Set(); model.traverse(o => { if (o.material?.userData?.cosmeticRole) roles.add(o.material.userData.cosmeticRole); });
assert(roles.has('body') && roles.has('trim') && roles.has('wheels'), [...roles].join());
// no fixed vertex colour equal to a race-car palette colour (cosmetics.js would repaint it)
{
  const pal = ['#e8402f', '#ffffff', '#ffd23a'].map(h => new THREE.Color(h));
  model.traverse(o => { const c = o.geometry?.attributes.color; if (!c) return; for (let i = 0; i < c.count; i++) for (const p of pal) assert(Math.abs(c.getX(i) - p.r) + Math.abs(c.getY(i) - p.g) + Math.abs(c.getZ(i) - p.b) > .001, 'palette clash'); });
}

// wheels: the layout car.js syncMesh and remotes use; rims are spin.children[1], tyres [0]
assert.equal(ud.wheels.length, 4);
for (const [i, w] of ud.wheels.entries()) {
  assert(w.holder.isObject3D && w.spin.parent === w.holder && w.spin.children[0].isMesh && w.spin.children[1].isMesh);
  assert.equal(typeof w.restY, 'number'); assert.equal(w.front, i < 2);
}
// parked stance = what car.js syncMesh gives at rest
{
  const t = spec.tuning, comp = spec.physics.mass * 24 / (4 * t.springK);
  for (const w of ud.wheels) assert(Math.abs(w.holder.position.y - (w.restY + .3 - (t.restLength - comp) - (spec.physics.radius - w.r))) < 1e-6, 'parked hub');
}
// wheels inside their arches: no body vertex inside any tyre's cylinder at rest, and the arch gap per wheel
// wheelArch is the tyre-top ceiling in the body frame (wheeltravel.js): clearance above the parked tyre top = ceiling - hub - r
console.log('wheelArch (tyre-top ceiling, m):', ud.wheelArch.join(', '));
assert(ud.wheelArch.length === 4 && ud.wheelArch.every((c, i) => { const g = c - ud.wheels[i].holder.position.y - ud.wheels[i].r; return g > .005 && g < .2; })); // the box ceiling (see model) leaves a little less than the round gap
{
  let hits = 0; const v = new THREE.Vector3();
  nearGroup.traverse(o => {
    if (!o.isMesh) return; const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      for (const w of ud.wheels) {
        const h = w.holder.position, half = (w.front ? .27 : .36) / 2;
        if (Math.abs(v.x - h.x) < half - .01 && Math.hypot(v.y - h.y, v.z - h.z) < w.r - .01) hits++;
      }
    }
  });
  assert.equal(hits, 0, `${hits} body vertices inside a tyre`);
  for (const w of ud.wheels) { const h = w.holder.position; assert(Math.abs(h.x) + (w.front ? .135 : .18) <= box.max.x + .01, 'tyre outside the body'); }
}

// clean top over the front wheels and the windscreen base: looking straight down, every first hit is paint or glass,
// never the black arch liners / underbody poking through the bonnet (the old "dark slashes")
{
  // a hole shows up as no front face at all (back faces are culled) or as a tyre seen through the bonnet
  const body = [], wheelMeshes = new Set(); nearGroup.traverse(o => { if (o.isMesh) body.push(o); });
  for (const w of ud.wheels) w.holder.traverse(o => { if (o.isMesh) { body.push(o); wheelMeshes.add(o); } });
  const ray = new THREE.Raycaster(), black = ['#15161a', '#0b0c0e'].map(h => new THREE.Color(h));
  let bad = 0, n = 0; const where = [];
  // straight down and slanted in from above the same side / from above the front (vertical black walls show only then)
  for (const [dx, dz] of [[0, 0], [-.6, 0], [-.4, -.4]])
  for (let x = -.92; x <= .92; x += .02) for (let z = .88; z <= 2.0; z += .02) {     // ahead of the mirrors' black bases
    const dir = new THREE.Vector3(dx * Math.sign(x || 1), -1, dz).normalize();
    ray.set(new THREE.Vector3(x, .45, z).addScaledVector(dir, -3), dir); n++;
    const hit = ray.intersectObjects(body)[0], c = hit?.object.geometry.attributes.color;
    const k = c && new THREE.Color(c.getX(hit.face.a), c.getY(hit.face.a), c.getZ(hit.face.a));
    if (!hit || wheelMeshes.has(hit.object) || k && black.some(b => Math.abs(b.r - k.r) + Math.abs(b.g - k.g) + Math.abs(b.b - k.b) < .002)) {
      bad++; if (where.length < 6) where.push(`${x.toFixed(2)},${z.toFixed(2)}:${!hit ? 'hole' : wheelMeshes.has(hit.object) ? 'tyre' : 'black'}`);
    }
  }
  console.log(`top view over the front: ${bad} of ${n} samples hit arch/underbody black`, where.join(' | '));
  assert.equal(bad, 0, 'arch liner or underbody shows through the bonnet');
}

// livery panel (cosmetics.js decalPanels) lies on the bonnet: corners and centre within 1.2 cm above the surface
{
  const [w, h, x, y, z, rx] = ud.decalPanels[0], plane = new THREE.Object3D(); plane.position.set(x, y, z); plane.rotation.set(rx, 0, 0); plane.updateMatrixWorld();
  const body = []; nearGroup.traverse(o => { if (o.isMesh) body.push(o); });
  const ray = new THREE.Raycaster();
  for (const [u, v] of [[0, 0], [-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]]) {
    const p = plane.localToWorld(new THREE.Vector3(u * w, v * h, 0));
    ray.set(new THREE.Vector3(p.x, 3, p.z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObjects(body)[0]; assert(hit, 'no bonnet under the livery');
    const gap = p.y - hit.point.y; assert(gap > -.001 && gap < .012, `livery corner ${u},${v}: ${gap.toFixed(4)} m off the bonnet`);
  }
}

// lights anchors on the lenses
// (tail: the Y and the line toward the middle on each side; lights_test checks every lens lies on its drawn lamp)
assert(ud.lights.head.length === 2 && ud.lights.tail.length === 4 && [...ud.lights.head, ...ud.lights.tail].every(p => p.isVector3));
assert(ud.lights.head.every(p => p.z > 1.9) && ud.lights.tail.every(p => p.z < -2.1));
assert(ud.lightMount === ud.bodyPivot);

// the painted remote model builds, and the Garage colours reach the materials
const painted = paintedModel('car', { body: '#123456', trim: '#000000', wheels: '#abcdef' }, 'sports');
const col = {}; painted.traverse(o => { const r = o.material?.userData?.cosmeticRole; if (r) col[r] = '#' + o.material.color.getHexString(THREE.SRGBColorSpace); });
assert.equal(col.body, '#123456'); assert.equal(col.wheels, '#abcdef');

// multiplayer bake (mp/remotes.js): parts merge per group, the LOD levels still hold the near and far bodies
{
  const { bakeParts } = await import('../game/src/mp/remotes.js');
  const baked = bakeParts(paintedModel('car', {}, 'sports')), lod = baked.userData.lod;
  for (const l of lod.levels) assert(l.object.parent === lod && l.object.children.some(o => o.isMesh), 'baked LOD level lost its mesh');
  assert.equal(lod.children.length, 2, 'nothing left outside the LOD levels');
  const cam = new THREE.PerspectiveCamera(); baked.updateMatrixWorld(true);
  cam.position.set(0, 2, 10); cam.updateMatrixWorld(); lod.update(cam); assert(lod.levels[0].object.visible && !lod.levels[1].object.visible);
  cam.position.set(0, 2, 120); cam.updateMatrixWorld(); lod.update(cam); assert(!lod.levels[0].object.visible && lod.levels[1].object.visible);
}

// the real car with this type: wheels spin, steer and follow the suspension through car.js syncMesh, no NaN
{
  const { Car, TUNING_DEFAULTS } = await import('../game/src/car.js');
  const { applyVehicleType } = await import('../game/src/vehicletypes.js');
  const flat = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3, normalAt: (x, z, o = new THREE.Vector3()) => o.set(0, 1, 0),
    waterLevelAt: () => -Infinity, treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7, -1e7, 1e7, 1e7] };
  const car = new Car(flat, { ...TUNING_DEFAULTS }); applyVehicleType(car, 'sports'); car.reset(0, 0, 0);
  const input = { throttle: 0, brake: 0, steer: 0, handbrake: false }, dt = 1 / 120;
  for (let i = 0; i < 240; i++) { car.step(dt, input); car.interpolate?.(1); car.syncMesh(dt); }
  const w = car.mesh.userData.wheels, parked = ud.wheels.map(x => x.holder.position.y);
  w.forEach((g, i) => assert(Math.abs(g.holder.position.y - parked[i]) < .02, `wheel ${i} settles ${g.holder.position.y.toFixed(3)} vs parked ${parked[i].toFixed(3)}`));
  input.throttle = 1; input.steer = .6;
  for (let i = 0; i < 120; i++) { car.step(dt, input); car.interpolate?.(1); car.syncMesh(dt); }
  assert(w[0].holder.rotation.y !== 0 && w[2].holder.rotation.y === 0, 'front wheels steer, rears do not');
  assert(w.every(g => g.spin.rotation.x !== 0), 'wheels spin');
  car.mesh.traverse(o => { if (o.isMesh) assert(o.geometry.attributes.position.array.every(Number.isFinite)); });
  assert([car.mesh.position, ...w.map(g => g.holder.position)].every(p => p.toArray().every(Number.isFinite)));
}
// factory trim per type: the Sports car is black-trimmed, the race car keeps white; colours the player picked win,
// survive a reload and Factory colors; older saves without the `custom` list count only non-default colours as picked
{
  const { createCosmetics, COSMETIC_KEY, DEFAULT_COSMETICS } = await import('../game/src/cosmetics.js');
  const { createVehicleTypeSelector } = await import('../game/src/vehicletypeselector.js');
  const { Car, TUNING_DEFAULTS } = await import('../game/src/car.js'), { Bike, BIKE } = await import('../game/src/bike.js');
  const SPORTS = typeInfo('car', 'sports').colors.trim, RACE = DEFAULT_COSMETICS.car.trim;
  const flat = { heightAt: () => 0, terrainAt: () => 0, groundAt: () => 0, surfaceAt: () => 3, normalAt: (x, z, o = new THREE.Vector3()) => o.set(0, 1, 0),
    waterLevelAt: () => -Infinity, treesNear: () => {}, buildingsNear: () => [], loadedAt: () => true, extent: [-1e7, -1e7, 1e7, 1e7] };
  const boot = store => {
    const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    const all = { car: new Car(flat, { ...TUNING_DEFAULTS }), bike: new Bike(flat, { ...BIKE }) }, types = createVehicleTypeSelector(all, { storage });
    const vehicles = { all, current: all.car, ...types };
    return { vehicles, cos: createCosmetics(vehicles, { storage }) };
  };
  const trimOn = mesh => { let c = null; mesh.traverse(o => { if (o.material?.userData?.cosmeticRole === 'trim') c = '#' + o.material.color.getHexString(THREE.SRGBColorSpace); }); return c; };
  const store = new Map(); let { vehicles, cos } = boot(store);
  assert.equal(cos.get('car').trim, RACE, 'race car keeps white trim');
  vehicles.setType('car', 'sports');
  assert.equal(cos.get('car').trim, SPORTS); assert.equal(trimOn(vehicles.all.car.mesh), SPORTS, 'sports model painted black-trimmed');
  assert.equal(trimOn(cos.createPreview('car')), SPORTS, 'Garage preview too');
  cos.set('car', { body: '#123456' }); assert.equal(cos.get('car').trim, SPORTS, 'a body change keeps the factory trim');
  vehicles.setType('car', 'race'); assert.equal(cos.get('car').trim, RACE); assert.equal(cos.get('car').body, '#123456');
  vehicles.setType('car', 'sports'); cos.set('car', { trim: '#ffffff' });           // the player picks white on purpose
  assert.equal(cos.get('car').trim, '#ffffff'); assert.equal(trimOn(vehicles.all.car.mesh), '#ffffff');
  assert.deepEqual(JSON.parse(store.get(COSMETIC_KEY)).car.custom.sort(), ['body', 'trim']);
  ({ vehicles, cos } = boot(store));
  assert.equal(vehicles.getType('car'), 'sports'); assert.equal(cos.get('car').trim, '#ffffff', 'picked trim survives a reload');
  cos.reset('car'); assert.equal(cos.get('car').trim, SPORTS, 'Factory colors → the type\'s factory trim');
  for (const [trim, expect] of [[RACE, SPORTS], ['#ff0000', '#ff0000']]) {      // a save from before this change
    const old = new Map([[COSMETIC_KEY, JSON.stringify({ car: { ...DEFAULT_COSMETICS.car, trim } })], ['yr-vtype-1', JSON.stringify({ car: 'sports', bike: 'dirt' })]]);
    assert.equal(boot(old).cos.get('car').trim, expect, `old save with trim ${trim}`);
  }
  // other players: colours they send win, a missing one takes their type's factory colour
  assert.equal(trimOn(paintedModel('car', {}, 'sports')), SPORTS);
  assert.equal(trimOn(paintedModel('car', { trim: '#ff0000' }, 'sports')), '#ff0000');
}
console.log('sports car model: ok');
