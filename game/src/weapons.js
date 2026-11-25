import * as THREE from 'three';
import { createWeaponsCore, armed, ROUND_CAP, MISSILE_CAP } from './weaponscore.js';
import { encodeShot, validShot } from './weaponswire.js';
import { buildingRoofAt } from './roofs.js';

// Caller updates the camera matrices after its chase/cockpit pose; out is reused every frame.
export function projectWeaponAim(mesh, camera, out) {
  const muzzle = mesh.userData.guns?.[0];
  if (!muzzle) return false;
  out.copy(muzzle); out.z += 600;
  out.applyMatrix4(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
  if (out.z >= 0) return false;
  out.applyMatrix4(camera.projectionMatrix);
  return Math.abs(out.x) <= 1 && Math.abs(out.y) <= 1;
}

export function createWeapons({ scene, world, effects, audio, mp, camera, canvas, vehicle, blocked }) {
  const origin = new THREE.Vector3(), velocity = new THREE.Vector3(), direction = new THREE.Vector3(), axis = new THREE.Vector3(0, 0, 1);
  const aim = new THREE.Vector3(), hot = new THREE.Color(0xfff4cf), flame = new THREE.Color(0xffa52d);
  const pose = new THREE.Object3D(), zero = { x: 0, y: 0, z: 0 };
  const puff = { x: 0, y: 0, z: 0, vx: 0, vy: 1, vz: 0, life: 1.4, size: .4, grow: 2, rot: 0, spin: .2, r: .2, g: .2, b: .2, alpha: .6, ground: -100000, drag: 1, lift: 1, kind: 0 };
  const column = { ...puff, life: 1.6, size: 9, grow: 4, vy: 3, lift: 2, r: .025, g: .022, b: .02, alpha: .95 };
  const dust = { ...puff, life: .9, size: .7, grow: 3, vy: 1, lift: .2, r: .24, g: .17, b: .09, alpha: .65 };
  const chip = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: .12, flat: .4, ax: .2, ay: .4, wx: 4, wy: 3, drag: .8, r: .17, g: .10, b: .04, ground: 0 };
  const flashes = Array.from({ length: 32 }, () => ({ x: 0, y: 0, z: 0, life: 0, max: 0, size: 0, bright: false }));
  const clouds = Array.from({ length: 48 }, () => ({ x: 0, y: 0, z: 0, life: 0, size: 0 }));
  let cloudCursor = 0;
  let flashCursor = 0, mousePrimary = false, mouseSecondary = false, shake = 0, clock = 0, wasBlocked = false;
  const tracer = new THREE.InstancedMesh(new THREE.BoxGeometry(.065, .065, 9), new THREE.MeshBasicMaterial({ color: 0xffe9a3, toneMapped: false }), ROUND_CAP);
  const missiles = new THREE.InstancedMesh(new THREE.ConeGeometry(.18, 1.8, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd1d5d6, flatShading: true }), MISSILE_CAP);
  const fireballs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, fog: false }), flashes.length);
  // Low-poly volume keeps the smoke legible at long range; shared sprites soften its edges.
  const smokeVolumes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshBasicMaterial({ color: 0x292622, transparent: true, opacity: .8, depthWrite: false }), clouds.length);
  fireballs.setColorAt(0, flame); // Allocate instance colours once.
  const meshes = [tracer, missiles, fireballs, smokeVolumes];
  for (const mesh of meshes) { mesh.frustumCulled = false; mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(mesh); }
  const hud = document.createElement('div'); hud.className = 'weapons-hud'; hud.hidden = true;
  hud.innerHTML = '<span class="weapons-reticle" aria-hidden="true">+</span><span class="weapons-ready"></span>';
  const help = document.createElement('div'); help.className = 'weapons-help'; help.hidden = true;
  const style = document.createElement('style'); style.textContent = '.weapons-hud,.weapons-help{position:fixed;pointer-events:none;color:#ddffe9;font:11px system-ui;text-shadow:0 1px 3px #000;z-index:4}.weapons-hud{transform:translate(-50%,-50%)}.weapons-hud[hidden],.weapons-help[hidden]{display:none}.weapons-reticle{display:block;font:28px monospace;line-height:28px}.weapons-ready{position:absolute;top:8px;left:25px;white-space:nowrap}.weapons-help{bottom:24px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:clamp(8px,1.5vw,11px)}';
  document.head.append(style); document.body.append(hud, help);
  const ready = hud.querySelector('.weapons-ready');
  let hudTick = -1, hudType = '', hintVehicle = null, hintType = '', hintTime = 0, hudVisible = false, aimX = NaN, aimY = NaN;
  function clearInput() { mousePrimary = mouseSecondary = false; }
  function down(e) {
    if (blocked() || !armed(vehicle())) return;
    if (e.button === 0) mousePrimary = true;
    if (e.button === 2) mouseSecondary = true;
    if (e.button === 0 || e.button === 2) e.preventDefault();
  }
  function up(e) { if (e.button === 0) mousePrimary = false; if (e.button === 2) mouseSecondary = false; }
  function context(e) { if (!blocked() && armed(vehicle())) e.preventDefault(); }
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('contextmenu', context);
  addEventListener('pointerup', up); addEventListener('pointercancel', clearInput); addEventListener('blur', clearInput); addEventListener('visibilitychange', clearInput);
  function flash(p, size, life, bright = false, lift = 0) { const f = flashes[flashCursor++ % flashes.length]; f.x = p.x; f.y = p.y + lift; f.z = p.z; f.size = size; f.bright = bright; f.life = f.max = life; }
  function smoke(p, size = .4) { puff.x = p.x; puff.y = p.y; puff.z = p.z; puff.size = size; effects.puffs.spawn(puff, effects.time); }
  function sound(kind, p) { const d = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z); if (d < 900) audio.weapon?.(kind, 1 / (1 + d * d / 1600)); }
  function explosion(p, large, terrain = false) {
    if (!large) {
      if (terrain) { dust.x = p.x; dust.y = p.y + .15; dust.z = p.z; dust.ground = p.y; effects.puffs.spawn(dust, effects.time); }
      else { flash(p, .6, .12); smoke(p, .5); }
      return;
    }
    flash(p, 9, .85, false, 3);
    flash(p, 11, .14, true, 3);
    // A rising column, with all particles written once into the shared fixed-capacity pool.
    for (let i = 0; i < 6; i++) {
      const c = clouds[cloudCursor++ % clouds.length];
      c.x = p.x + (i % 2 ? 1 : -1); c.y = p.y + 3 + i * 3; c.z = p.z; c.life = 3.2; c.size = 3.5 + i * .35;
    }
    column.x = p.x; column.z = p.z; column.ground = p.y - 1;
    for (let wave = 0; wave < 4; wave++) for (let i = 0; i < 6; i++) {
      column.birth = effects.time + wave * .6; column.y = p.y + i * 3 + wave * 2; column.size = 9 + i * .5;
      effects.puffs.spawn(column, effects.time);
    }
    sound('explosion', p);
    const d = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);
    shake = Math.max(shake, Math.max(0, 1 - d / 100) * .32);
    chip.x = p.x; chip.y = p.y; chip.z = p.z; chip.ground = world.heightAt(p.x, p.z);
    for (let i = 0; i < 12; i++) { const a = i * 2.39996; chip.vx = Math.sin(a) * 14; chip.vz = Math.cos(a) * 14; chip.vy = 5 + (i % 4) * 3; effects.chips.spawn(chip, effects.time); }
  }
  const core = createWeaponsCore({ world, roofAt: buildingRoofAt,
    onFire(p) { flash(p.p, p.kind === 'cannon' ? .45 : .8, .07); sound(p.kind, p.p); if (!p.remote) mp?.send(encodeShot(p.kind, p.n, p.p, p.v)); },
    onTrail(p) { smoke(p.p); },
    onImpact(p, hit) {
      // Authoritative blast packets avoid a remotely broken tree making a replay overshoot its impact.
      if (p.remote && p.kind !== 'cannon') return;
      explosion(p.p, p.kind !== 'cannon', hit.type === 'terrain');
      if (!p.remote && p.kind !== 'cannon') mp?.send(encodeShot('blast', p.n, p.p, zero));
    },
  });
  const off = mp?.on('shot', m => {
    if (m.from === mp.me.id || !validShot(m) || blocked()) return;
    origin.fromArray(m.p); velocity.fromArray(m.v);
    if (m.k === 'blast') { for (const p of core.pool) if (p.remote && p.from === m.from && p.n === m.n) p.active = false; explosion(origin, true); }
    else core.spawn(m.k, origin, velocity, true, m.from, m.n);
  });
  function fire(kind) {
    const v = vehicle(), anchors = v.mesh.userData[kind === 'cannon' ? 'guns' : 'missiles'];
    if (!anchors?.length) return;
    origin.copy(anchors[0]).applyMatrix4(v.mesh.matrixWorld);
    direction.set(0, 0, 1).transformDirection(v.mesh.matrixWorld);
    velocity.copy(direction).multiplyScalar(kind === 'cannon' ? 1000 : 280).add(v.vel);
    core.spawn(kind, origin, velocity);
  }
  function draw(mesh, p, n, scale = 1) {
    pose.position.set(p.x, p.y, p.z); pose.scale.setScalar(scale); pose.updateMatrix(); mesh.setMatrixAt(n, pose.matrix);
  }
  return {
    core, clearInput,
    update(dt, keys, pad) {
      const v = vehicle(), locked = blocked(), visible = !locked && armed(v) && v.mode !== 'crashed';
      if (locked) { clearInput(); if (!wasBlocked) core.clear(); }
      wasBlocked = locked;
      core.control(dt, v, keys.has('KeyE') || mousePrimary || !!pad?.buttons[4]?.pressed,
        keys.has('KeyQ') || mouseSecondary || !!pad?.buttons[5]?.pressed, locked, fire);
      core.step(dt); clock += dt;
      let rounds = 0, rockets = 0, balls = 0, smokeCount = 0;
      for (const p of core.pool) if (p.active) {
        direction.set(p.v.x, p.v.y, p.v.z).normalize(); pose.quaternion.setFromUnitVectors(axis, direction);
        if (p.kind === 'cannon') draw(tracer, p.p, rounds++); else draw(missiles, p.p, rockets++);
      }
      pose.quaternion.identity();
      for (const f of flashes) if (f.life > 0) { f.life -= dt; if (f.life > 0) { fireballs.setColorAt(balls, f.bright ? hot : flame); draw(fireballs, f, balls++, f.size * (.65 + .35 * f.life / f.max)); } }
      for (const c of clouds) if (c.life > 0) {
        c.life = Math.max(0, c.life - dt); c.y += dt * 2.5;
        if (c.life > 0) draw(smokeVolumes, c, smokeCount++, (c.size + (3.2 - c.life) * 1.2) * Math.min(1, c.life / .5));
      }
      smokeVolumes.count = smokeCount;
      tracer.count = rounds; missiles.count = rockets; fireballs.count = balls;
      for (const mesh of meshes) if (mesh.count) mesh.instanceMatrix.needsUpdate = true;
      if (balls) fireballs.instanceColor.needsUpdate = true;
      hudVisible = visible;
      if (!visible) hud.hidden = true;
      if (hintVehicle !== v || hintType !== v.type) {
        hintVehicle = v; hintType = v.type; hintTime = armed(v) ? 8 : 0;
      }
      help.hidden = !visible || hintTime <= 0;
      if (visible) hintTime = Math.max(0, hintTime - dt);
      if (visible) {
        const label = v.type === 'heli' ? 'Rocket' : 'Missile', tick = Math.ceil(core.cooldown * 10);
        if (tick !== hudTick || label !== hudType) { hudTick = tick; ready.textContent = tick ? `${label} · ${(tick / 10).toFixed(1)} s` : `${label} READY`; }
        if (label !== hudType) { hudType = label; help.textContent = `Hold E / LMB / LB · Cannon    Press Q / RMB / RB · ${label}`; }
      }
    },
    shakeCamera(dt) {
      if (shake > 0) { camera.position.x += Math.sin(clock * 127) * shake; camera.position.y += Math.cos(clock * 103) * shake; shake = Math.max(0, shake - dt); }
      // main.js calls this after updating either camera, so projection uses this frame's actual view.
      camera.updateMatrixWorld();
      hud.hidden = !hudVisible || !projectWeaponAim(vehicle().mesh, camera, aim);
      if (!hud.hidden) {
        const x = Math.round((aim.x + 1) * 5000) / 100, y = Math.round((1 - aim.y) * 5000) / 100;
        if (x !== aimX) { aimX = x; hud.style.left = x + '%'; }
        if (y !== aimY) { aimY = y; hud.style.top = y + '%'; }
      }
    },
    dispose() {
      off?.(); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('contextmenu', context);
      removeEventListener('pointerup', up); removeEventListener('pointercancel', clearInput); removeEventListener('blur', clearInput); removeEventListener('visibilitychange', clearInput);
      hud.remove(); help.remove(); style.remove(); for (const m of meshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    },
  };
}
