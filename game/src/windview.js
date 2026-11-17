import * as THREE from 'three';
// Two instanced wings per bird, shared geometry/material; no per-frame mesh creation.
export function createWindView({ scene, wind, current }) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, .5, 2.2, 0, -.3, 0, 0, -.4], 3));
  const material = new THREE.MeshLambertMaterial({ color: 0x343338, side: THREE.DoubleSide });
  const wings = [new THREE.InstancedMesh(geometry, material, 192), new THREE.InstancedMesh(geometry, material, 192)];
  for (const wing of wings) { wing.count = 0; wing.frustumCulled = false; scene.add(wing); }
  const dummy = new THREE.Object3D(), rotation = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const hud = document.createElement('div'); hud.id = 'wind-hud'; hud.hidden = true;
  hud.style.cssText = 'font:600 14px system-ui;margin-top:4px;font-variant-numeric:tabular-nums;';
  const arrow = document.createElement('span'), label = document.createTextNode('');
  arrow.textContent = '↑'; arrow.style.cssText = 'display:inline-block;margin-right:8px';
  hud.append(arrow, label); document.getElementById('hud').append(hud);
  let columns = [], refresh = 0;
  return {
    get columns() { return columns; },
    update(dt) {
      const v = current(), p = v.pos;
      refresh -= dt;
      if (!wind.thermalActive) { columns = []; refresh = 0; }
      else if (refresh <= 0) { columns = wind.columnsNear(p.x, p.z).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z)).slice(0, 32); refresh = 1; }
      let n = 0;
      for (const c of columns) for (let i = 0; i < c.birds && n < 192; i++, n++) {
        const angle = wind.time * .22 + i * Math.PI * 2 / c.birds + c.x;
        dummy.position.set(c.x + Math.sin(angle) * c.radius * .45, c.ground + 100 + i * 4 + Math.sin(angle * 2) * 3, c.z + Math.cos(angle) * c.radius * .45);
        rotation.setFromAxisAngle(up, angle + Math.PI / 2);
        for (let side = 0; side < 2; side++) {
          dummy.rotation.set(0, 0, (side ? -1 : 1) * (.12 + .3 * Math.sin(wind.time * 5 + i)));
          dummy.quaternion.premultiply(rotation); dummy.scale.set(side ? -1 : 1, 1, 1); dummy.updateMatrix();
          wings[side].setMatrixAt(n, dummy.matrix);
        }
      }
      for (const wing of wings) { wing.count = n; wing.instanceMatrix.needsUpdate = n > 0; }
      const show = wind.active && (v.glide?.active || (v.mode === 'air' && ['prop', 'stunt', 'heli'].includes(v.type)));
      hud.hidden = !show;
      if (show) {
        const w = wind.sample(p.x, p.y, p.z), angle = Math.atan2(w.x, w.z) - v.heading();
        arrow.style.transform = `rotate(${angle}rad)`;
        const text = `Wind ${Math.round(w.speed * 3.6)} km/h`;
        if (label.nodeValue !== text) label.nodeValue = text;
      }
    },
    dispose() { for (const wing of wings) scene.remove(wing); geometry.dispose(); material.dispose(); hud.remove(); },
  };
}
