import * as THREE from 'three';
import { trunkRadius } from './data.js';

// Only the affected chunk uploads. Original matrices stay intact for regrowth and falling tops.
export function createTreeBreakFX(world, group, geometries, views, invalidateShadows) {
  const matrix = new THREE.Matrix4(), zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const color = new THREE.Color(), stumpGeo = new THREE.CylinderGeometry(.8, 1, 1, 7);
  const stumpMat = new THREE.MeshLambertMaterial({ color: 0x785137, flatShading: true });
  const tops = Array.from({ length: 12 }, () => {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, transparent: true });
    const pivot = new THREE.Group(), mesh = new THREE.Mesh(geometries[0], material);
    pivot.add(mesh); group.add(pivot); pivot.visible = false;
    return { pivot, mesh, axis: new THREE.Vector3(), age: 11, angle: 0 };
  });
  const chipGeo = new THREE.BoxGeometry(1, 1, 1);
  const chips = new THREE.InstancedMesh(chipGeo, stumpMat, 192);
  chips.instanceMatrix.array.fill(0); chips.frustumCulled = false; group.add(chips);
  for (let i = 0; i < chips.count; i++) chips.setColorAt(i, color.setHex(0xffffff));
  const particles = Array.from({ length: 192 }, () => ({ age: 3, p: new THREE.Vector3(), v: new THREE.Vector3(), floor: 0, size: 0 }));
  let nextChip = 0, lastTime = null, warmup = null, warmed = false;
  const dummy = new THREE.Object3D();

  function apply(view, event, animate) {
    const index = event.ref[2];
    const chunk = view.treeLods[view.treeSlots[index * 2]];
    if (!chunk) return;
    const slot = view.treeSlots[index * 2 + 1], td = view.td, offset = index * 4;
    matrix.fromArray(view.treeMats, index * 16);
    chunk.near.setMatrixAt(slot, event.broken ? zero : matrix);
    chunk.far.setMatrixAt(slot, event.broken ? zero : matrix);
    chunk.near.instanceMatrix.needsUpdate = chunk.far.instanceMatrix.needsUpdate = true;
    if (!chunk.stumps && event.broken) {
      chunk.stumps = new THREE.InstancedMesh(stumpGeo, stumpMat, chunk.near.count);
      // Match the chips' already-warmed shader variant, even though every stump tint is white.
      chunk.stumps.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(chunk.near.count * 3).fill(1), 3);
      chunk.stumps.instanceMatrix.array.fill(0); chunk.stumps.frustumCulled = false;
      view.group.add(chunk.stumps);
    }
    const x = td.trees[offset], z = td.trees[offset + 1], h = td.trees[offset + 2], broad = td.trees[offset + 3];
    const y = td.terrainAt(x, z), r = trunkRadius(h, broad);
    if (chunk.stumps) {
      dummy.position.set(x, y + .25, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(r, .5, r); dummy.updateMatrix();
      chunk.stumps.setMatrixAt(slot, event.broken ? dummy.matrix : zero); chunk.stumps.instanceMatrix.needsUpdate = true;
    }
    if (!event.broken || !animate) return;
    const top = tops.find(t => t.age >= 10) || tops.reduce((a, b) => a.age > b.age ? a : b);
    top.age = 0; top.pivot.visible = true; top.pivot.position.set(x, y + .5, z); top.pivot.quaternion.identity();
    const length = Math.hypot(event.dx, event.dz) || 1, dx = event.dx / length, dz = event.dz / length;
    top.axis.set(dz, 0, -dx);
    // Canopy lands on the local slope, then stays still until its final two-second fade.
    const endY = world.terrainAt(x + dx * h, z + dz * h);
    top.angle = Math.max(.35, Math.min(1.8, Math.acos(Math.max(-1, Math.min(1, ((Number.isFinite(endY) ? endY : y) - y) / h))) - (broad ? .28 : .13)));
    top.mesh.geometry = geometries[broad ? 1 : 0];
    matrix.decompose(top.mesh.position, top.mesh.quaternion, top.mesh.scale); top.mesh.position.set(0, -.5, 0);
    top.baseY = y + .5; top.radius = top.mesh.scale.x * .5; top.crownBase = h * (broad ? .245 : .18);
    chunk.near.getColorAt(slot, color); top.mesh.material.color.copy(color); top.mesh.material.opacity = 1;
    for (let i = 0; i < 24; i++) {
      const n = nextChip++ % particles.length, p = particles[n];
      p.age = 0; p.floor = y; p.size = .08 + Math.random() * .22;
      p.p.set(x, y + .8 + Math.random() * Math.min(h, 5), z);
      p.v.set(dx * 6 + (Math.random() - .5) * 9, 3 + Math.random() * 8, dz * 6 + (Math.random() - .5) * 9);
      chips.setColorAt(n, color.setHex(i % 3 === 0 ? 0x477333 : i % 3 === 1 ? 0x9b7049 : 0x654129));
    }
    chips.instanceColor.needsUpdate = true;
  }
  const off = world.treeBreaks.onChange(event => {
    const view = views.get(world.key(event.ref[0], event.ref[1]));
    if (view) apply(view, event, !event.snapshot);
    invalidateShadows();
  });
  return {
    // Shared stump resources must survive tile disposal.
    stumpGeo,
    // Compile visible copies against the actual scene lights/fog, before the loading screen closes.
    // The pooled tops stay hidden and retain their materials/programs for the whole session.
    warmup(renderer, camera, scene) {
      if (!warmup) warmup = (async () => {
        const models = new THREE.Group();
        for (const top of tops) models.add(new THREE.Mesh(top.mesh.geometry, top.mesh.material));
        const chipCopy = chips.clone(); models.add(chipCopy);
        try {
          if (renderer.compileAsync) await renderer.compileAsync(models, camera, scene);
          else renderer.compile(models, camera, scene);
          warmed = true;
        } finally { chipCopy.dispose(); }
      })();
      return warmup;
    },
    get warmed() { return warmed; },
    attach(view) {
      for (const event of world.treeBreaks.broken.values()) if (event.ref[0] === view.td.tx && event.ref[1] === view.td.tz) apply(view, event, false);
    },
    update(time) {
      world.treeBreaks.update();
      const elapsed = lastTime === null ? 0 : Math.max(0, time - lastTime), dt = Math.min(.1, elapsed); lastTime = time;
      for (const top of tops) if (top.age < 10) {
        top.age += elapsed;
        const angle = top.angle * Math.min(1, (top.age / 1.7) ** 2);
        top.pivot.quaternion.setFromAxisAngle(top.axis, angle);
        // Once detached, the crown supports the trunk: don't bury its lower branches in the ground.
        top.pivot.position.y = top.baseY + Math.max(0, top.radius * Math.sin(angle) - top.crownBase * Math.cos(angle) - .5);
        top.mesh.material.opacity = Math.min(1, Math.max(0, (10 - top.age) / 2));
        top.pivot.visible = top.age < 10;
      }
      let dirty = false;
      particles.forEach((p, i) => {
        if (p.age >= 3) return;
        p.age += elapsed; p.v.y -= 18 * dt; p.p.addScaledVector(p.v, dt);
        if (p.p.y < p.floor + .05) { p.p.y = p.floor + .05; p.v.set(0, 0, 0); }
        dummy.position.copy(p.p); dummy.rotation.set(p.age * 3, i, p.age * 2);
        dummy.scale.setScalar(p.size * Math.max(0, Math.min(1, 3 - p.age))); dummy.scale.y *= i % 3 === 0 ? .15 : .5; dummy.updateMatrix();
        chips.setMatrixAt(i, dummy.matrix); dirty = true;
      });
      if (dirty) chips.instanceMatrix.needsUpdate = true;
    },
    dispose() { off(); tops.forEach(t => { group.remove(t.pivot); t.mesh.material.dispose(); }); group.remove(chips); chips.dispose(); chipGeo.dispose(); stumpGeo.dispose(); stumpMat.dispose(); },
    get activeTops() { return tops.filter(t => t.age < 10).length; },
  };
}
