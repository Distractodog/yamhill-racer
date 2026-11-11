// Tyre marks, dust/smoke particles, water splashes, contact shadows.
import * as THREE from 'three';

const DUST = [ // per surface: rgb, how much it kicks up just from driving fast
  [[150, 140, 100], 0.15], [[110, 96, 70], 0.2], [[205, 160, 110], 0.9], [[235, 235, 235], 0], [[210, 198, 175], 0.7],
  [[230, 240, 245], 1.0], [[235, 235, 235], 0], [[220, 140, 120], 0.2]];

export class Effects {
  constructor(scene) {
    // ---------------- tyre marks: ring buffer of quads
    this.MAX = 8000;
    const g = new THREE.BufferGeometry();
    this.markPos = new Float32Array(this.MAX * 6 * 3);
    this.markA = new Float32Array(this.MAX * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.markPos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.markA, 1).setUsage(THREE.DynamicDrawUsage));
    this.marks = new THREE.Mesh(g, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
      vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(0.067,0.067,0.067, vA); }',
    }));
    this.marks.frustumCulled = false;
    scene.add(this.marks);
    this.markI = 0;
    this.last = [null, null, null, null];
    this.skidT = [0, 0, 0, 0];        // how long each tyre has been sliding (marks start after a short delay)
    this.brakeT = 0; this.launchT = 0;

    // ---------------- particles
    this.PN = 900;
    const pg = new THREE.BufferGeometry();
    this.pPos = new Float32Array(this.PN * 3); this.pVel = new Float32Array(this.PN * 3);
    this.pCol = new Float32Array(this.PN * 3); this.pLife = new Float32Array(this.PN); this.pMax = new Float32Array(this.PN);
    this.pSize = new Float32Array(this.PN); this.pAlpha = new Float32Array(this.PN); this.pGrav = new Float32Array(this.PN);
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('alpha', new THREE.BufferAttribute(this.pAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(pg, new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying float vA; varying vec3 vC;
        void main(){ vA = alpha; vC = color; vec4 mv = modelViewMatrix * vec4(position,1.0);
        gl_PointSize = alpha > 0.003 ? min(size * 900.0 / -mv.z, 140.0) : 0.0; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; varying vec3 vC;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d); if (r > 0.25 || vA < 0.003) discard;
        gl_FragColor = vec4(vC, vA * (1.0 - r * 4.0)); }`,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.pI = 0;

    // ---------------- contact shadows: soft dark blobs on the ground under each tyre and the car
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const ctx = c.getContext('2d'), grd = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(0.55, 'rgba(0,0,0,0.6)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 64, 64);
    const blobTex = new THREE.CanvasTexture(c);
    const mk = (w, l, op) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: op,
          polygonOffset: true, polygonOffsetFactor: -6 }));
      m.userData.op = op; m.renderOrder = 2; scene.add(m); return m;
    };
    this.tyreBlobs = [0, 1, 2, 3].map(i => mk(i < 2 ? 0.7 : 0.85, 1.0, 0.75));
    this.bodyBlob = mk(2.4, 4.9, 0.5);
  }

  placeBlob(m, x, z, yaw, above, world) {
    const h = world.heightAt(x, z);
    m.position.set(x, h + 0.03, z);
    const n = world.normalAt(x, z);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    m.rotateY(yaw);
    m.material.opacity = m.userData.op * Math.max(0, 1 - above / 2.5);
    m.visible = m.material.opacity > 0.01;
  }

  addMark(i, p, n, side, strength) {
    const last = this.last[i];
    if (!last) { this.last[i] = { p: p.clone(), side: side.clone() }; return; }
    if (last.p.distanceToSquared(p) < 0.25) return;
    if (last.p.distanceToSquared(p) > 9) { last.p.copy(p); last.side.copy(side); return; }
    const w = 0.16, o = this.markI * 18, A = this.markPos;          // 32 cm wide
    const a1 = last.p.clone().addScaledVector(last.side, w), a2 = last.p.clone().addScaledVector(last.side, -w);
    const b1 = p.clone().addScaledVector(side, w), b2 = p.clone().addScaledVector(side, -w);
    for (const [k, v] of [a1, a2, b1, a2, b2, b1].entries()) { A[o + k * 3] = v.x; A[o + k * 3 + 1] = v.y + 0.04; A[o + k * 3 + 2] = v.z; }
    this.markA.fill(0.92, this.markI * 6, this.markI * 6 + 6);      // solid, same darkness every time
    this.markI = (this.markI + 1) % this.MAX;
    this.marks.geometry.attributes.position.needsUpdate = true;
    this.marks.geometry.attributes.alpha.needsUpdate = true;
    last.p.copy(p); last.side.copy(side);
  }
  breakMark(i) { this.last[i] = null; }

  emit(p, vel, surf, amount) {
    const [[r, g, b]] = DUST[surf];
    const i = this.pI; this.pI = (this.pI + 1) % this.PN;
    this.pPos.set([p.x + (Math.random() - .5) * .4, p.y + 0.15, p.z + (Math.random() - .5) * .4], i * 3);
    this.pVel.set([vel.x * 0.25 + (Math.random() - .5) * 2.5, 1 + Math.random() * 2, vel.z * 0.25 + (Math.random() - .5) * 2.5], i * 3);
    const v = 0.9 + Math.random() * 0.15;
    this.pCol.set([r / 255 * v, g / 255 * v, b / 255 * v], i * 3);
    this.pMax[i] = this.pLife[i] = 0.7 + Math.random() * 0.9 * amount;
    this.pSize[i] = 0.6 + amount * 0.8;
    this.pGrav[i] = 0;
  }

  // water spray: thrown up and out, falls back down
  splash(p, vel, power) {
    const i = this.pI; this.pI = (this.pI + 1) % this.PN;
    this.pPos.set([p.x + (Math.random() - .5) * 1.2, p.y + 0.1, p.z + (Math.random() - .5) * 1.2], i * 3);
    this.pVel.set([vel.x * 0.35 + (Math.random() - .5) * 5 * power, 2 + Math.random() * 6 * power, vel.z * 0.35 + (Math.random() - .5) * 5 * power], i * 3);
    const v = 0.85 + Math.random() * 0.15;
    this.pCol.set([0.82 * v, 0.92 * v, 1.0 * v], i * 3);
    this.pMax[i] = this.pLife[i] = 0.6 + Math.random() * 0.7;
    this.pSize[i] = 0.12 + Math.random() * 0.18 * power;
    this.pGrav[i] = 1;
  }

  update(dt, car) {
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(car.renderQuat), yaw = Math.atan2(fwd.x, fwd.z);
    const W = car.world;
    car.mesh.userData.wheels.forEach((g, i) => {
      const p = new THREE.Vector3(); g.holder.getWorldPosition(p);
      this.placeBlob(this.tyreBlobs[i], p.x, p.z, yaw + (g.front ? g.holder.rotation.y : 0), p.y - g.r - W.heightAt(p.x, p.z), W);
    });
    const rp = car.renderPos;
    this.placeBlob(this.bodyBlob, rp.x, rp.z, yaw, rp.y - 0.55 - W.heightAt(rp.x, rp.z), W);

    // marks + particles from the wheels
    const sp = car.vel.length(), inp = car.input || {};
    const fwdSpeed = car.vel.dot(fwd.set(0, 0, 1).applyQuaternion(car.quat));
    const side = new THREE.Vector3(1, 0, 0).applyQuaternion(car.quat);
    // Marks only when a tyre is really losing grip, and only after it has slid for a moment:
    //  drifts / big slides and the handbrake (rear), the first moments of a hard stop from speed (all four),
    //  a hard launch from low speed (rear), and corners taken right at the grip limit (rear).
    const sliding = car.drifting || (car.slip > 0.22 && sp > 10);
    const braking = inp.brake > 0 && fwdSpeed > 16;
    this.brakeT = braking ? this.brakeT + dt : 0;
    const launching = inp.throttle > 0 && fwdSpeed > 0.5 && fwdSpeed < 9 && car.lonAcc > 10;
    this.launchT = launching ? this.launchT + dt : (fwdSpeed < 0.5 ? 0 : this.launchT);
    const limitCorner = Math.abs(car.latAcc) > 26 && sp > 15;
    const wet = car.onWater || car.waterDepth > 0;
    car.wheels.forEach((wh, i) => {
      const rear = !wh.front;
      const handbrake = inp.handbrake && rear && sp > 4;
      const skid = (sliding && rear) || handbrake || (braking && this.brakeT < 0.7) ||
        (launching && rear && this.launchT < 0.6) || (limitCorner && rear);
      this.skidT[i] = skid && wh.contact && wh.surf !== 5 ? this.skidT[i] + dt : 0;
      if (this.skidT[i] > 0.075) this.addMark(i, wh.contactPoint, null, side, 1);
      else this.breakMark(i);
      if (!wh.contact) return;
      if (wh.surf === 5) {                         // skimming the water: spray off every tyre
        if (Math.random() < Math.min(1, sp / 25) * dt * 45) this.splash(wh.contactPoint, car.vel, 0.8);
        return;
      }
      const loose = DUST[wh.surf][1];
      let amt = 0;
      if (rear && (sliding || handbrake)) amt = 1;
      else if (launching && rear && this.launchT < 0.6) amt = 0.6;
      else if (braking && this.brakeT < 0.7) amt = 0.35;
      const trail = loose * Math.min(1, sp / 40);
      if (rear && Math.random() < trail * dt * 40) this.emit(wh.contactPoint, car.vel, wh.surf, 0.6);
      if (amt && Math.random() < amt * dt * 60) this.emit(wh.contactPoint, car.vel, wh.surf, amt);
    });
    // water: a big burst when you hit it, then a bow wave while ploughing through
    if (wet && !this.wasWet && sp > 4) for (let k = 0; k < Math.min(60, 12 + sp); k++) this.splash(car.pos, car.vel, Math.min(1.4, sp / 25));
    if (car.waterDepth > 0 && sp > 1.5 && Math.random() < dt * 40) this.splash(car.pos, car.vel, 0.5);
    this.wasWet = wet;
    for (let i = 0; i < this.PN; i++) {
      if (this.pLife[i] <= 0) { this.pAlpha[i] = 0; this.pSize[i] = 0; continue; }   // faded: not drawn at all
      this.pLife[i] -= dt;
      const k = i * 3;
      this.pVel[k] *= 1 - 2 * dt; this.pVel[k + 2] *= 1 - 2 * dt; this.pVel[k + 1] += this.pGrav[i] ? -14 * dt : 0.6 * dt;
      this.pPos[k] += this.pVel[k] * dt; this.pPos[k + 1] += this.pVel[k + 1] * dt; this.pPos[k + 2] += this.pVel[k + 2] * dt;
      const f = this.pLife[i] / this.pMax[i];
      this.pAlpha[i] = Math.max(0, f) * 0.55;
      if (!this.pGrav[i]) this.pSize[i] += dt * 2.2;                // dust spreads; water droplets don't
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.alpha.needsUpdate = a.size.needsUpdate = a.color.needsUpdate = true;
  }
}
