// Shared vehicle interface. Every vehicle (car.js, bike.js, jet.js) has the same outside: pos / quat / vel / ang,
// renderPos / renderQuat (drawn between physics steps), mesh, step(dt, input) at 120 Hz, reset(x, z, yaw),
// resetToSafe(), syncMesh(dt), and a few read-outs other code uses (grounded, surface, airTime, hit, landing, slip,
// drifting, latAcc, lonAcc, wheels for tyre marks/dust). Physics reads the world only through heightAt / surfaceAt /
// normalAt / treesNear / buildingsNear / waterLevelAt (+ terrainAt / loadedAt / extent for bookkeeping).
// The car keeps its own (older) copies of the collision helpers so its handling is byte-for-byte unchanged.
import * as THREE from 'three';

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

export class Vehicle {
  constructor(world, kind) {
    this.world = world; this.kind = kind;
    this.pos = new THREE.Vector3(); this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3(); this.ang = new THREE.Vector3();
    this.prevPos = new THREE.Vector3(); this.prevQuat = new THREE.Quaternion();
    this.renderPos = new THREE.Vector3(); this.renderQuat = new THREE.Quaternion();
    this.surface = 0; this.grounded = false; this.airTime = 0; this.contacts = 0;
    this.latAcc = 0; this.lonAcc = 0; this.hit = 0; this.landing = 0;
    this.slip = 0; this.slipSigned = 0; this.drifting = false; this.steer = 0;
    this.onWater = false; this.waterDepth = 0; this.stuck = 0;
    this.safe = []; this.wheels = [];
    this._prevVel = new THREE.Vector3();
    this.msg = ''; this.msgT = 0;
  }

  say(m, secs = 2.5) { this.msg = m; this.msgT = secs; }

  savePrev() { this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat); }
  interpolate(alpha) {
    if (this.prevPos.distanceToSquared(this.pos) > 100 && this.vel.lengthSq() < 2500) this.savePrev();   // teleport, not speed
    this.renderPos.lerpVectors(this.prevPos, this.pos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }
  afterReset() { this.savePrev(); this.renderPos.copy(this.pos); this.renderQuat.copy(this.quat); this.hit = 0; this.landing = 0; }

  heading() { _v.set(0, 0, 1).applyQuaternion(this.quat); return Math.atan2(_v.x, _v.z); }

  resetToSafe() {
    const s = this.safe.length > 40 ? this.safe[this.safe.length - 40] : this.safe[0];
    if (s) this.reset(s[0], s[1], s[2]);
  }
  rememberSafe() {
    _v.set(0, 0, 1).applyQuaternion(this.quat);
    const last = this.safe[this.safe.length - 1];
    if (!last || Math.hypot(last[0] - this.pos.x, last[1] - this.pos.z) > 6) {
      this.safe.push([this.pos.x, this.pos.z, Math.atan2(_v.x, _v.z)]); if (this.safe.length > 200) this.safe.shift();
    }
  }

  // tree trunks as circles at a few points along the body; returns the hardest hit (m/s into the trunk)
  collideTrees(R, offsets, bounce = 1.3, keep = 0.82) {
    let worst = 0;
    for (const zo of offsets) {
      _w.set(0, 0, zo).applyQuaternion(this.quat).add(this.pos);
      if (_w.y - this.world.heightAt(_w.x, _w.z) > 14) continue;
      this.world.treesNear(_w.x, _w.z, R + 1.2, (tx, tz, tr) => {
        const dx = _w.x - tx, dz = _w.z - tz, d = Math.hypot(dx, dz), min = R + tr;
        if (d < min && d > 1e-4) {
          const nx = dx / d, nz = dz / d, pen = min - d;
          this.pos.x += nx * pen; this.pos.z += nz * pen; _w.x += nx * pen; _w.z += nz * pen;
          const vn = this.vel.x * nx + this.vel.z * nz;
          if (vn < 0) {
            this.vel.x -= nx * vn * bounce; this.vel.z -= nz * vn * bounce;
            this.vel.multiplyScalar(keep);
            this.hit = Math.max(this.hit, -vn); worst = Math.max(worst, -vn);
          }
        }
      });
    }
    return worst;
  }

  // building footprints (polygons) as walls up to their roof; returns the hardest hit
  collideBuildings(R) {
    let worst = 0;
    for (const b of this.world.buildingsNear(this.pos.x, this.pos.z)) {
      if (!b.pts) continue;
      const top = b.top ?? this.world.heightAt(b.pts[0][0], b.pts[0][1]) + (b.h || 6);   // top is set when the game meshes it
      if (this.pos.y > top + 1) continue;
      const pts = b.pts; let inside = false, bestD = Infinity, bx = 0, bz = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [x1, z1] = pts[j], [x2, z2] = pts[i];
        if (((z2 > this.pos.z) !== (z1 > this.pos.z)) && (this.pos.x < (x1 - x2) * (this.pos.z - z2) / (z1 - z2) + x2)) inside = !inside;
        const ex = x2 - x1, ez = z2 - z1, L = ex * ex + ez * ez || 1;
        const u = Math.max(0, Math.min(1, ((this.pos.x - x1) * ex + (this.pos.z - z1) * ez) / L));
        const cx = x1 + ex * u, cz = z1 + ez * u, d = Math.hypot(this.pos.x - cx, this.pos.z - cz);
        if (d < bestD) { bestD = d; bx = cx; bz = cz; }
      }
      if (!inside && bestD >= R) continue;
      let nx = this.pos.x - bx, nz = this.pos.z - bz; const d = Math.hypot(nx, nz) || 1; nx /= d; nz /= d;
      if (inside) { nx = -nx; nz = -nz; }
      const pen = inside ? R + bestD : R - bestD;
      this.pos.x += nx * pen; this.pos.z += nz * pen;
      const vn = this.vel.x * nx + this.vel.z * nz;
      if (vn < 0) { this.vel.x -= nx * vn * 1.3; this.vel.z -= nz * vn * 1.3; this.vel.multiplyScalar(0.85); this.hit = Math.max(this.hit, -vn); worst = Math.max(worst, -vn); }
    }
    return worst;
  }

  // edge of the map, or (near the ground) a tile that hasn't streamed in yet: bounce back
  keepInBounds(checkLoaded = true) {
    const [x0, z0, x1, z1] = this.world.extent, m = 6;
    if (this.pos.x < x0 + m) { this.pos.x = x0 + m; this.vel.x = Math.abs(this.vel.x) * 0.3; }
    if (this.pos.x > x1 - m) { this.pos.x = x1 - m; this.vel.x = -Math.abs(this.vel.x) * 0.3; }
    if (this.pos.z < z0 + m) { this.pos.z = z0 + m; this.vel.z = Math.abs(this.vel.z) * 0.3; }
    if (this.pos.z > z1 - m) { this.pos.z = z1 - m; this.vel.z = -Math.abs(this.vel.z) * 0.3; }
    if (!checkLoaded) { if (this.world.loadedAt(this.pos.x, this.pos.z)) this._lastLoaded = [this.pos.x, this.pos.z]; return; }
    if (!this.world.loadedAt(this.pos.x, this.pos.z) && this._lastLoaded) {
      this.pos.x = this._lastLoaded[0]; this.pos.z = this._lastLoaded[1]; this.vel.x *= -0.3; this.vel.z *= -0.3;
    } else this._lastLoaded = [this.pos.x, this.pos.z];
  }

  // measured accelerations in the vehicle's frame (camera, sound, body lean)
  trackAccel(dt) {
    _v.copy(this.vel).sub(this._prevVel).divideScalar(dt);
    _w.set(1, 0, 0).applyQuaternion(this.quat);
    this.latAcc += (_v.dot(_w) - this.latAcc) * Math.min(1, 8 * dt);
    _w.set(0, 0, 1).applyQuaternion(this.quat);
    this.lonAcc += (_v.dot(_w) - this.lonAcc) * Math.min(1, 8 * dt);
  }
}

// a Proxy that always forwards to whichever vehicle is active, so modules that were handed "the car" once (challenges,
// pin guide, effects, audio) follow a vehicle switch without knowing about it
export function activeProxy(get) {
  return new Proxy({}, {
    get(_, k) { const v = get(), x = v[k]; return typeof x === 'function' ? x.bind(v) : x; },
    set(_, k, val) { get()[k] = val; return true; },
    has(_, k) { return k in get(); },
  });
}
