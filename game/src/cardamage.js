// Player-car cosmetic dents. Collision code reports a world contact, outward normal and the
// pre-response normal closing speed. Nothing here writes vehicle physics or interprets `hit`.
import * as THREE from 'three';
import { panelTriangle } from './models/panelskin.js';

export const CAR_DAMAGE = Object.freeze({
  threshold: 3.5, fullSpeed: 45, hitDepth: .24, siteCap: .42, displacementCap: .45,
  radius: 1.35, depthReach: 1.3, mergeDistance: .65, maxSites: 24,
  contactQuiet: .25, bodySlamThreshold: 12,
});
const models = new WeakMap();
const point = new THREE.Vector3(), normal = new THREE.Vector3(), inverse = new THREE.Quaternion();
const clamp = THREE.MathUtils.clamp;
const bodyInverse = new THREE.Matrix4(), wheelInverse = new THREE.Matrix4(), wheelPoint = new THREE.Vector3();

export class CarDamage {
  constructor(car) { this.car = car; this.time = 0; this.sites = []; this.revision = 0; this.applied = -1; this.drawOffset = new THREE.Vector3(); }
  // Spawn-map warm-up prepares owned buffers/bindings, without deforming or repairing.
  // It is also safe on an already damaged cached type; existing rest data stays intact.
  prepare(model = this.car.mesh) { capture(model, stateFor(model)); }
  // Capture only the cosmetic chassis offset, never its world translation. Physics may
  // advance several steps beyond renderPos before the next contact arrives.
  setDrawOffset(meshPosition, renderPosition, renderQuaternion) {
    this.drawOffset.copy(meshPosition).sub(renderPosition).applyQuaternion(inverse.copy(renderQuaternion).invert());
  }
  // Simulation time, including gliding. Contact chatter cannot become repeated full crashes.
  step(dt) { this.time += dt; }
  impact(x, y, z, nx, ny, nz, speed, source = 'wall') {
    if (![x, y, z, nx, ny, nz, speed].every(Number.isFinite)) return;
    if (source === 'ground' && speed < CAR_DAMAGE.bodySlamThreshold) return;
    inverse.copy(this.car.quat).invert();
    point.set(x, y, z).sub(this.car.pos).applyQuaternion(inverse);
    normal.set(nx, ny, nz).applyQuaternion(inverse).normalize();
    point.sub(this.drawOffset);
    const pivot = this.car.mesh?.userData.bodyPivot;
    if (pivot) {
      pivot.updateMatrix(); bodyInverse.copy(pivot.matrix).invert();
      point.applyMatrix4(bodyInverse); normal.transformDirection(bodyInverse);
    }
    if (normal.lengthSq() < .9) return;
    // The few coarse physics shapes (building circle, barrier box) can be inside the drawn
    // bonnet. Preserve tangential contact placement; extend the dent through that outer skin.
    let site, best = Infinity;
    for (const s of this.sites) {
      const d = s.point.distanceToSquared(point);
      if (s.normal.dot(normal) > .8 && d < best) { best = d; site = s; }
    }
    if (best > CAR_DAMAGE.mergeDistance ** 2 && this.sites.length < CAR_DAMAGE.maxSites) site = null;
    const quiet = !site || this.time - site.lastContact >= CAR_DAMAGE.contactQuiet;
    if (site) site.lastContact = this.time;
    if (speed <= CAR_DAMAGE.threshold || !quiet) return;
    if (!site) {
      // At capacity merge into the closest existing site, never erase an old dent.
      if (this.sites.length >= CAR_DAMAGE.maxSites) return;
      site = { point: point.clone(), normal: normal.clone(), depth: 0, lastContact: this.time, source, speed };
      this.sites.push(site);
    }
    const severity = clamp((speed - CAR_DAMAGE.threshold) / (CAR_DAMAGE.fullSpeed - CAR_DAMAGE.threshold), 0, 1);
    const depth = Math.min(CAR_DAMAGE.siteCap, site.depth + CAR_DAMAGE.hitDepth * Math.sqrt(severity));
    if (depth === site.depth) return;
    site.depth = depth; site.speed = speed; this.revision++;
  }
  repair() {
    this.sites.length = 0; this.revision++; this.applied = -1;
    for (const model of new Set([this.car.mesh, ...(this.car._typeModels?.values() || [])])) restore(model);
  }
  // Called from syncMesh; unchanged damage is one integer comparison, no traversal or buffers.
  update() {
    if (this.applied === this.revision) return;
    this.applied = this.revision;
    if (!this.sites.length) return;
    deformModel(this.car.mesh, this.sites);
  }
}

function skipped(mesh, pivot) {
  for (let o = mesh; o && o !== pivot; o = o.parent) {
    if (o.name === 'glider' || o.name === 'vehicle-glow' || o.userData.damageRigid) return true;
  }
  return false;
}
function stateFor(model) {
  let state = models.get(model);
  if (!state) { state = { parts: new Map(), glows: new Map(), sites: [], version: 0 }; models.set(model, state); }
  return state;
}
function capture(model, state) {
  const pivot = model.userData.bodyPivot;
  if (!pivot) return;
  pivot.updateWorldMatrix(true, true);
  const inv = pivot.matrixWorld.clone().invert();
  // Remove detached/replaced livery parts: repeated Garage edits don't retain old buffers.
  for (const [mesh, part] of state.parts) {
    let o = mesh; while (o && o !== pivot) o = o.parent;
    if (!o || mesh.geometry !== part.geometry) { part.original.dispose(); state.parts.delete(mesh); }
  }
  for (const [glow] of state.glows) {
    let o = glow; while (o && o !== pivot) o = o.parent;
    if (!o) state.glows.delete(glow);
  }
  pivot.traverse(mesh => {
    if (mesh.name === 'vehicle-glow' && !state.glows.has(mesh)) {
      const matrix = new THREE.Matrix4().multiplyMatrices(inv, mesh.parent.matrixWorld);
      state.glows.set(mesh, { rest: mesh.position.clone(), matrix, inverse: matrix.clone().invert() });
    }
    if (!mesh.isMesh || skipped(mesh, pivot) || state.parts.has(mesh)) return;
    const original = mesh.geometry, pos = original.attributes.position;
    if (!pos) return;
    // Only position and normal become private. Paint bindings may already hold the colour
    // attribute, so preserve its identity (and all UVs/materials). Never mutate shared geometry.
    const geometry = original.clone();
    for (const [key, attr] of Object.entries(original.attributes)) if (key !== 'position' && key !== 'normal') geometry.setAttribute(key, attr);
    mesh.geometry = geometry;
    const matrix = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const part = { original, geometry, rest: pos.array.slice(), normals: original.attributes.normal?.array.slice(),
      matrix, inverse: matrix.clone().invert(), count: mesh.userData.damageVertexCount ?? pos.count };
    bindSkin(model, part);
    state.parts.set(mesh, part);
  });
}
// Compile each owned part once. Weld only EXACT rest positions (never normals/UVs),
// using a temporary numeric hash table rather than allocating strings per soup vertex.
// The resulting bindings belong to the part and disappear when an attachment detaches.
function bindSkin(model, part) {
  const { rest, count, matrix } = part, ids = new Uint32Array(count);
  let size = 1; while (size < count * 2) size *= 2;
  const table = new Int32Array(size).fill(-1), words = new Uint32Array(rest.buffer, rest.byteOffset, rest.length);
  const representatives = [], corners = new Map(), sources = [], positions = [], bindings = [], weights = [];
  const source = p => { const id = sources.length / 3; sources.push(p.x, p.y, p.z); return id; };
  const corner = p => { let id = corners.get(p); if (id === undefined) { id = source(skinPoint.fromArray(p)); corners.set(p, id); } return id; };
  for (let i = 0; i < count; i++) {
    const k = i * 3;
    // Canonicalize signed zero for the hash, consistent with numeric equality below.
    const x = rest[k] === 0 ? 0 : words[k], y = rest[k + 1] === 0 ? 0 : words[k + 1], z = rest[k + 2] === 0 ? 0 : words[k + 2];
    let hash = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
    hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
    let slot = (hash ^ (hash >>> 16)) & (size - 1);
    while (table[slot] >= 0) {
      const j = representatives[table[slot]] * 3;
      if (rest[j] === rest[k] && rest[j + 1] === rest[k + 1] && rest[j + 2] === rest[k + 2]) break;
      slot = (slot + 1) & (size - 1);
    }
    if (table[slot] >= 0) { ids[i] = table[slot]; continue; }
    const id = representatives.length; table[slot] = id; ids[i] = id; representatives.push(i);
    point.fromArray(rest, k).applyMatrix4(matrix); positions.push(point.x, point.y, point.z);
    const tri = panelTriangle(point, model.userData.damagePanels, skinWeights);
    if (tri) { bindings.push(corner(tri[0]), corner(tri[1]), corner(tri[2])); weights.push(skinWeights.x, skinWeights.y, skinWeights.z); }
    else { bindings.push(source(point), -1, -1); weights.push(0, 0, 0); }
  }
  part.skin = { ids, sources: new Float64Array(sources), evaluated: new Float64Array(sources.length),
    positions: new Float64Array(positions), bindings: new Int32Array(bindings), weights: new Float64Array(weights),
    output: new Float32Array(positions.length) };
}
function evaluateSkin(model, part, sites) {
  const { sources, evaluated, positions, bindings, weights, output } = part.skin;
  for (let i = 0; i < sources.length; i += 3) {
    point.fromArray(sources, i);
    deform(point, sites, wheelWeight(model, point));
    evaluated[i] = moved.x; evaluated[i + 1] = moved.y; evaluated[i + 2] = moved.z;
  }
  for (let i = 0; i < positions.length; i += 3) {
    const a = bindings[i] * 3;
    if (bindings[i + 1] < 0) moved.fromArray(evaluated, a);
    else {
      skinDelta.set(0, 0, 0);
      for (let j = 0; j < 3; j++) {
        const k = bindings[i + j] * 3;
        skinPoint.fromArray(evaluated, k).sub(point.fromArray(sources, k));
        skinDelta.addScaledVector(skinPoint, weights[i + j]);
      }
      moved.fromArray(positions, i).add(skinDelta);
    }
    moved.applyMatrix4(part.inverse);
    output[i] = moved.x; output[i + 1] = moved.y; output[i + 2] = moved.z;
  }
}
function wheelWeight(model, p) {
  let weight = 1;
  const { bodyPivot } = model.userData;
  // Holders live in chassis space; skin/arch heights live in body space. Protect the
  // same tyre envelope after body roll, pitch and lift, without moving the tyres.
  wheelPoint.copy(p);
  if (bodyPivot) wheelPoint.applyMatrix4(bodyPivot.matrix);
  for (const w of wheelBoxes) {
    const dx = Math.abs(wheelPoint.x - w.x) - w.halfWidth - .07;
    const dz = Math.abs(wheelPoint.z - w.z) - w.radius - .07;
    const dy = wheelPoint.y - w.ceiling - .05;
    weight = Math.min(weight, clamp(Math.max(dx, dz, dy) / .2, 0, 1));
  }
  return weight;
}
const moved = new THREE.Vector3(), delta = new THREE.Vector3(), offset = new THREE.Vector3();
function deform(p, sites, weight) {
  delta.set(0, 0, 0);
  for (const s of sites) {
    offset.copy(p).sub(s.point);
    const along = offset.dot(s.normal); // positive = deeper into the car
    const tangent2 = Math.max(0, offset.lengthSq() - along * along);
    const r = Math.sqrt(tangent2) / CAR_DAMAGE.radius;
    if (r >= 1 || along > CAR_DAMAGE.depthReach || along < -2) continue;
    const radial = (1 - r * r) ** 2;
    const depth = along > 0 ? (1 - along / CAR_DAMAGE.depthReach) ** 2 : 1;
    delta.addScaledVector(s.normal, s.depth * radial * depth * weight);
  }
  if (delta.lengthSq() > CAR_DAMAGE.displacementCap ** 2) delta.setLength(CAR_DAMAGE.displacementCap);
  // Don't fold slender noses/sidepods through their centre line at the cap.
  if (p.x * delta.x < 0) delta.x = Math.sign(delta.x) * Math.min(Math.abs(delta.x), Math.abs(p.x) * .45);
  if (p.z * delta.z < 0) delta.z = Math.sign(delta.z) * Math.min(Math.abs(delta.z), Math.abs(p.z) * .45);
  return moved.copy(p).add(delta);
}
const skinWeights = new THREE.Vector3(), skinPoint = new THREE.Vector3(), skinDelta = new THREE.Vector3();
function deformSkin(model, p, sites) {
  const triangle = panelTriangle(p, model.userData.damagePanels, skinWeights);
  if (!triangle) return deform(p, sites, wheelWeight(model, p));
  // The shell and every overlay use precisely the same affine displacement within each
  // original shell triangle. Their authored layer offsets survive regardless of topology.
  skinDelta.set(0, 0, 0);
  for (let i = 0; i < 3; i++) {
    skinPoint.fromArray(triangle[i]);
    deform(skinPoint, sites, wheelWeight(model, skinPoint));
    skinDelta.addScaledVector(moved.sub(skinPoint), skinWeights.getComponent(i));
  }
  return moved.copy(p).add(skinDelta);
}
const wheelBoxes = [];
function prepareWheelFrame(model) {
  const { bodyPivot: pivot, wheels = [], wheelArch = [] } = model.userData;
  if (pivot) { pivot.updateMatrix(); wheelInverse.copy(pivot.matrix).invert(); } else wheelInverse.identity();
  const e = wheelInverse.elements;
  wheelBoxes.length = wheels.length;
  for (let i = 0; i < wheels.length; i++) {
    const w = wheels[i], h = w.holder.position, arch = wheelArch[i] ?? w.restY + w.r;
    const box = wheelBoxes[i] ||= {};
    box.x = h.x; box.z = h.z; box.halfWidth = (w.hubWidth ?? .5) / 2; box.radius = w.r;
    // Solve the body-frame ceiling plane once per revision, at the chassis-space hub.
    const ceiling = Math.abs(e[5]) > 1e-6 ? (arch - e[1] * h.x - e[9] * h.z - e[13]) / e[5] : h.y + w.r;
    box.ceiling = Math.max(ceiling, h.y + w.r);
  }
}
function deformModel(model, sites) {
  prepareWheelFrame(model);
  const state = stateFor(model); state.sites = sites; state.version++;
  capture(model, state);
  for (const [glow, part] of state.glows) {
    point.copy(part.rest).applyMatrix4(part.matrix);
    glow.position.copy(deformSkin(model, point, sites).applyMatrix4(part.inverse));
  }
  for (const [mesh, part] of state.parts) {
    const g = mesh.geometry, pos = g.attributes.position;
    evaluateSkin(model, part, sites);
    const { ids, output } = part.skin;
    let changed = !part.deformed || part.count !== pos.count;
    for (let i = 0; i < part.count; i++) {
      const k = ids[i] * 3;
      const j = i * 3;
      if (pos.array[j] !== output[k] || pos.array[j + 1] !== output[k + 1] || pos.array[j + 2] !== output[k + 2]) changed = true;
      pos.array[j] = output[k]; pos.array[j + 1] = output[k + 1]; pos.array[j + 2] = output[k + 2];
    }
    // Leave pending uploads alone when this part did not change. Animated merged arms
    // still need their face normals, and the first deformation establishes computed normals.
    if (!changed) continue;
    part.deformed = true;
    pos.clearUpdateRanges(); pos.addUpdateRange(0, part.count * 3); pos.needsUpdate = true;
    updateNormals(g); updateBounds(g);
  }
}
// Same Float32 intermediate and normalization as three's triangle-soup normals, but
// one cross/normalization per face instead of clearing and normalizing every duplicate.
// Indexed lamp/attachment geometry keeps three's shared-vertex implementation.
function updateNormals(g) {
  if (g.index || !g.attributes.normal) { g.computeVertexNormals(); return; }
  const p = g.attributes.position.array, n = g.attributes.normal.array;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i] - p[i + 3], ay = p[i + 1] - p[i + 4], az = p[i + 2] - p[i + 5];
    const bx = p[i + 6] - p[i + 3], by = p[i + 7] - p[i + 4], bz = p[i + 8] - p[i + 5];
    let x = Math.fround(by * az - bz * ay), y = Math.fround(bz * ax - bx * az), z = Math.fround(bx * ay - by * ax);
    const scale = 1 / (Math.sqrt(x * x + y * y + z * z) || 1); x *= scale; y *= scale; z *= scale;
    for (let j = i; j < i + 9; j += 3) { n[j] = x; n[j + 1] = y; n[j + 2] = z; }
  }
  g.attributes.normal.needsUpdate = true;
}
// Reuse the box's min/max for the sphere; three's separate calls scan the box twice.
// These are the same tight bounds, including the merged race-car suspension vertices.
function updateBounds(g) {
  const p = g.attributes.position.array;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]); y0 = Math.min(y0, p[i + 1]); z0 = Math.min(z0, p[i + 2]);
    x1 = Math.max(x1, p[i]); y1 = Math.max(y1, p[i + 1]); z1 = Math.max(z1, p[i + 2]);
  }
  g.boundingBox ||= new THREE.Box3(); g.boundingSphere ||= new THREE.Sphere();
  g.boundingBox.min.set(x0, y0, z0); g.boundingBox.max.set(x1, y1, z1);
  const c = g.boundingBox.getCenter(g.boundingSphere.center); let radius2 = 0;
  for (let i = 0; i < p.length; i += 3) {
    const x = c.x - p[i], y = c.y - p[i + 1], z = c.z - p[i + 2]; radius2 = Math.max(radius2, x * x + y * y + z * z);
  }
  g.boundingSphere.radius = Math.sqrt(radius2);
}
function restore(model) {
  const state = models.get(model); if (!state) return;
  for (const [mesh, part] of state.parts) {
    const g = mesh.geometry;
    if (g !== part.geometry) { part.original.dispose(); state.parts.delete(mesh); continue; }
    if (!part.deformed) continue;
    part.deformed = false;
    // Merged animated suspension vertices remain owned by linkage.update().
    g.attributes.position.array.set(part.rest.subarray(0, part.count * 3));
    g.attributes.position.clearUpdateRanges(); g.attributes.position.addUpdateRange(0, part.count * 3); g.attributes.position.needsUpdate = true;
    if (part.normals) { g.attributes.normal.array.set(part.normals); g.attributes.normal.needsUpdate = true; }
    updateBounds(g);
  }
  for (const [glow, part] of state.glows) glow.position.copy(part.rest);
  state.sites = []; state.version++;
}
// A Garage livery rebuild or lazily attached lamp lens must inherit the current field.
// Called only by those attachment changes, never by ordinary paint/wetness or light updates.
export function refreshCarDamageAttachments(model) {
  const state = models.get(model);
  if (state?.sites.length) deformModel(model, state.sites);
}

// Lamps cache their beam origin until this revision changes; no field work in an unchanged frame.
export const carDamageVersion = model => models.get(model)?.version ?? 0;
export function deformCarPoint(model, p) {
  const state = models.get(model);
  if (state?.sites.length) { prepareWheelFrame(model); p.copy(deformSkin(model, p, state.sites)); }
  return p;
}

// On-demand diagnostics for profiling/attachment lifetime tests; no traversal in steady frames.
export function carDamageCacheInfo(model) {
  const state = models.get(model), result = { parts: 0, vertices: 0, unique: 0, sources: 0, bytes: 0 };
  if (state) for (const part of state.parts.values()) {
    result.parts++; result.vertices += part.count; result.unique += part.skin.positions.length / 3;
    result.sources += part.skin.sources.length / 3;
    for (const array of Object.values(part.skin)) result.bytes += array.byteLength;
  }
  return result;
}
