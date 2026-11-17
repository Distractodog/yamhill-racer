// Player-car cosmetic dents. Collision code reports a world contact, outward normal and the
// pre-response normal closing speed. Nothing here writes vehicle physics or interprets `hit`.
import * as THREE from 'three';

export const CAR_DAMAGE = Object.freeze({
  threshold: 3.5, fullSpeed: 45, hitDepth: .24, siteCap: .42, displacementCap: .45,
  radius: 1.35, depthReach: 1.3, mergeDistance: .65, maxSites: 24,
  contactQuiet: .25, bodySlamThreshold: 12,
});
const models = new WeakMap();
const point = new THREE.Vector3(), normal = new THREE.Vector3(), inverse = new THREE.Quaternion();
const clamp = THREE.MathUtils.clamp;

export class CarDamage {
  constructor(car) { this.car = car; this.time = 0; this.sites = []; this.revision = 0; this.applied = -1; }
  // Simulation time, including gliding. Contact chatter cannot become repeated full crashes.
  step(dt) { this.time += dt; }
  impact(x, y, z, nx, ny, nz, speed, source = 'wall') {
    if (![x, y, z, nx, ny, nz, speed].every(Number.isFinite)) return;
    if (source === 'ground' && speed < CAR_DAMAGE.bodySlamThreshold) return;
    inverse.copy(this.car.quat).invert();
    point.set(x, y, z).sub(this.car.pos).applyQuaternion(inverse);
    normal.set(nx, ny, nz).applyQuaternion(inverse).normalize();
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
    if (!o) { part.original.dispose(); state.parts.delete(mesh); }
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
    state.parts.set(mesh, { original, rest: pos.array.slice(), normals: original.attributes.normal?.array.slice(),
      matrix, inverse: matrix.clone().invert(), count: mesh.userData.damageVertexCount ?? pos.count });
  });
}
function wheelWeight(model, p) {
  let weight = 1;
  const { wheels = [], wheelArch = [] } = model.userData;
  for (let i = 0; i < wheels.length; i++) {
    const w = wheels[i], h = w.holder.position;
    // Keep the arch and its lip clear of the whole tyre travel envelope. Wheels, brakes and
    // holders are outside bodyPivot; the race car's merged arms have an explicit vertex range.
    const dx = Math.abs(p.x - h.x) - (w.hubWidth ?? .5) / 2 - .07;
    const dz = Math.abs(p.z - h.z) - w.r - .07;
    const dy = p.y - (wheelArch[i] ?? w.restY + w.r) - .05;
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
function deformModel(model, sites) {
  const state = stateFor(model); state.sites = sites; state.version++;
  capture(model, state);
  for (const [glow, part] of state.glows) {
    point.copy(part.rest).applyMatrix4(part.matrix);
    glow.position.copy(deform(point, sites, wheelWeight(model, point)).applyMatrix4(part.inverse));
  }
  for (const [mesh, part] of state.parts) {
    const g = mesh.geometry, pos = g.attributes.position;
    for (let i = 0; i < part.count; i++) {
      point.fromArray(part.rest, i * 3).applyMatrix4(part.matrix);
      deform(point, sites, wheelWeight(model, point)).applyMatrix4(part.inverse);
      pos.setXYZ(i, moved.x, moved.y, moved.z);
    }
    pos.clearUpdateRanges(); pos.needsUpdate = true;
    g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  }
}
function restore(model) {
  const state = models.get(model); if (!state) return;
  for (const [mesh, part] of state.parts) {
    const g = mesh.geometry;
    // Merged animated suspension vertices remain owned by linkage.update().
    g.attributes.position.array.set(part.rest.subarray(0, part.count * 3));
    g.attributes.position.clearUpdateRanges(); g.attributes.position.needsUpdate = true;
    if (part.normals) { g.attributes.normal.array.set(part.normals); g.attributes.normal.needsUpdate = true; }
    g.computeBoundingBox(); g.computeBoundingSphere();
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
  if (state?.sites.length) p.copy(deform(p, state.sites, wheelWeight(model, p)));
  return p;
}
