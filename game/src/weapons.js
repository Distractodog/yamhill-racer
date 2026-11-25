import * as THREE from 'three';
import { createWeaponsCore, armed, ROUND_CAP, MISSILE_CAP } from './weaponscore.js';
import { encodeShot, validShot } from './weaponswire.js';
import { buildingRoofAt } from './roofs.js';

export function createWeapons({ scene, world, effects, audio, mp, camera, canvas, vehicle, blocked }) {
  const origin = new THREE.Vector3(), velocity = new THREE.Vector3(), direction = new THREE.Vector3(), axis = new THREE.Vector3(0, 0, 1);
  const pose = new THREE.Object3D(), zero = { x: 0, y: 0, z: 0 };
  const puff = { x: 0, y: 0, z: 0, vx: 0, vy: 1, vz: 0, life: 1.4, size: .4, grow: 2, rot: 0, spin: .2, r: .2, g: .2, b: .2, alpha: .6, ground: -100000, drag: 1, lift: 1, kind: 0 };
  const chip = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, size: .12, flat: .4, ax: .2, ay: .4, wx: 4, wy: 3, drag: .8, r: .17, g: .10, b: .04, ground: 0 };
  const flashes = Array.from({ length: 32 }, () => ({ x: 0, y: 0, z: 0, life: 0, max: 0, size: 0 }));
  let flashCursor = 0, mousePrimary = false, mouseSecondary = false, shake = 0, clock = 0, wasBlocked = false;
  const tracer = new THREE.InstancedMesh(new THREE.BoxGeometry(.065, .065, 9), new THREE.MeshBasicMaterial({ color: 0xffe9a3, toneMapped: false }), ROUND_CAP);
  const missiles = new THREE.InstancedMesh(new THREE.ConeGeometry(.18, 1.8, 6).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0xd1d5d6, flatShading: true }), MISSILE_CAP);
  const fireballs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ color: 0xffa238, toneMapped: false }), flashes.length);
  const meshes = [tracer, missiles, fireballs];
  for (const mesh of meshes) { mesh.frustumCulled = false; mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(mesh); }
  const hud = document.createElement('div'); hud.className = 'weapons-hud'; hud.hidden = true;
  hud.innerHTML = '<span class="weapons-reticle" aria-hidden="true">+</span><span class="weapons-ready"></span><small>E / LMB · Cannon &nbsp; Q / RMB · Missile<br>Gamepad LB · Cannon &nbsp; RB · Missile</small>';
  const style = document.createElement('style'); style.textContent = '.weapons-hud{position:fixed;inset:50% auto auto 50%;transform:translate(-50%,-50%);pointer-events:none;color:#ddffe9;text-align:center;font:12px system-ui;text-shadow:0 1px 3px #000;z-index:4}.weapons-hud[hidden]{display:none}.weapons-reticle{display:block;font:28px monospace;line-height:28px}.weapons-ready{position:absolute;top:42px;left:50%;transform:translateX(-50%);white-space:nowrap}.weapons-hud small{position:absolute;top:65px;left:50%;transform:translateX(-50%);white-space:nowrap;font-size:10px;opacity:.8}';
  document.head.append(style); document.body.append(hud);
  const ready = hud.querySelector('.weapons-ready'), help = hud.querySelector('small');
  let hudTick = -1, hudType = '';
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
  function flash(p, size, life) { const f = flashes[flashCursor++ % flashes.length]; f.x = p.x; f.y = p.y; f.z = p.z; f.size = size; f.life = f.max = life; }
  function smoke(p, size = .4) { puff.x = p.x; puff.y = p.y; puff.z = p.z; puff.size = size; effects.puffs.spawn(puff, effects.time); }
  function sound(kind, p) { const d = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z); if (d < 900) audio.weapon?.(kind, 1 / (1 + d * d / 1600)); }
  function explosion(p, large) {
    flash(p, large ? 5 : .6, large ? .45 : .12); smoke(p, large ? 4 : .5);
    if (!large) return;
    sound('explosion', p);
    const d = Math.hypot(p.x - camera.position.x, p.y - camera.position.y, p.z - camera.position.z);
    shake = Math.max(shake, Math.max(0, 1 - d / 100) * .32);
    chip.x = p.x; chip.y = p.y; chip.z = p.z; chip.ground = world.heightAt(p.x, p.z);
    for (let i = 0; i < 12; i++) { const a = i * 2.39996; chip.vx = Math.sin(a) * 14; chip.vz = Math.cos(a) * 14; chip.vy = 5 + (i % 4) * 3; effects.chips.spawn(chip, effects.time); }
  }
  const core = createWeaponsCore({ world, roofAt: buildingRoofAt,
    onFire(p) { flash(p.p, p.kind === 'cannon' ? .45 : .8, .07); sound(p.kind, p.p); if (!p.remote) mp?.send(encodeShot(p.kind, p.n, p.p, p.v)); },
    onTrail(p) { smoke(p.p); },
    onImpact(p) {
      // Authoritative blast packets avoid a remotely broken tree making a replay overshoot its impact.
      if (p.remote && p.kind !== 'cannon') return;
      explosion(p.p, p.kind !== 'cannon');
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
      let rounds = 0, rockets = 0, balls = 0;
      for (const p of core.pool) if (p.active) {
        direction.set(p.v.x, p.v.y, p.v.z).normalize(); pose.quaternion.setFromUnitVectors(axis, direction);
        if (p.kind === 'cannon') draw(tracer, p.p, rounds++); else draw(missiles, p.p, rockets++);
      }
      pose.quaternion.identity();
      for (const f of flashes) if (f.life > 0) { f.life -= dt; if (f.life > 0) draw(fireballs, f, balls++, f.size * (.5 + .5 * f.life / f.max)); }
      tracer.count = rounds; missiles.count = rockets; fireballs.count = balls;
      for (const mesh of meshes) if (mesh.count) mesh.instanceMatrix.needsUpdate = true;
      hud.hidden = !visible;
      if (visible) {
        const label = v.type === 'heli' ? 'Rocket' : 'Missile', tick = Math.ceil(core.cooldown * 10);
        if (tick !== hudTick || label !== hudType) { hudTick = tick; ready.textContent = tick ? `${label} · ${(tick / 10).toFixed(1)} s` : `${label} READY`; }
        if (label !== hudType) { hudType = label; help.innerHTML = `E / LMB · Cannon &nbsp; Q / RMB · ${label}<br>Gamepad LB · Cannon &nbsp; RB · ${label}`; }
      }
    },
    shakeCamera(dt) { if (shake > 0) { camera.position.x += Math.sin(clock * 127) * shake; camera.position.y += Math.cos(clock * 103) * shake; shake = Math.max(0, shake - dt); } },
    dispose() {
      off?.(); canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('contextmenu', context);
      removeEventListener('pointerup', up); removeEventListener('pointercancel', clearInput); removeEventListener('blur', clearInput); removeEventListener('visibilitychange', clearInput);
      hud.remove(); style.remove(); for (const m of meshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    },
  };
}
