// Prepare a network-free copy of the real game entry for Argus's read-only browser.
// Run: node tools/tank_game_check.mjs
// Then: argus browse 'node_modules/.tank-game-check.html?view=chase' --wait-ms 10000
// Other views: side, interior, picker, night. The generated page is git-ignored.
// Three is the production version; the GUI uses Three's bundled lil-gui 0.17.0.
// This checks driving/rendering, not parity of the production GUI 0.19.2 package.
import { readFile, writeFile } from 'node:fs/promises';

function setup() {
  localStorage.setItem('yr-welcome-hidden-1', '1');
  localStorage.setItem('yr-vtype-1', JSON.stringify({ car: 'tank', bike: 'dirt', jet: 'fighter' }));
  // Suppress only the production visit counter in this isolated review.
  const fetchFile = window.fetch.bind(window);
  window.fetch = (url, options) => new URL(typeof url === 'string' ? url : url.url, location.href).href ===
    'https://yamhill-racer-relay.yamhill-racer.workers.dev/hit'
    ? Promise.resolve(new Response(null, { status: 204 })) : fetchFile(url, options);
  const sendBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) => url === 'https://yamhill-racer-relay.yamhill-racer.workers.dev/hit'
    ? true : sendBeacon(url, data);
}

async function review() {
  const report = window.tankCheck = { phase: 'loading', errors: [], view: new URLSearchParams(location.search).get('view') || 'chase' };
  addEventListener('error', e => report.errors.push(e.message));
  addEventListener('unhandledrejection', e => report.errors.push(String(e.reason)));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async (test, label) => {
    const limit = performance.now() + 30000;
    while (!test()) { if (performance.now() > limit) throw Error(`Timed out: ${label}`); await sleep(50); }
  };
  const check = (condition, message) => { if (!condition) throw Error(message); };
  try {
    await until(() => window.game?.sessionSpawn && document.querySelector('#fullmap.open canvas'), 'spawn map');
    const g = window.game, canvas = document.querySelector('#fullmap canvas');
    const map = await fetch('assets/minimap.json').then(r => r.json()), picture = new Image();
    picture.src = 'assets/minimap.jpg'; await picture.decode();
    const rect = canvas.getBoundingClientRect(), scale = Math.min(rect.width / picture.width, rect.height / picture.height);
    const clientX = rect.left + rect.width / 2 + ((-542 - map.extent[0]) / map.mpp - picture.width / 2) * scale;
    const clientY = rect.top + rect.height / 2 + ((440 - map.extent[1]) / map.mpp - picture.height / 2) * scale;
    // Exercise the real spawn-map handlers; synthetic pointers cannot acquire browser capture.
    const capture = canvas.setPointerCapture;
    canvas.setPointerCapture = () => {};
    for (const type of ['pointerdown', 'pointerup']) canvas.dispatchEvent(new PointerEvent(type, { pointerId: 1, button: 0, clientX, clientY, bubbles: true }));
    canvas.setPointerCapture = capture;
    await until(() => !g.sessionSpawn.blocked, 'campus spawn');
    document.getElementById('welcome-start')?.click();
    check(g.vehicles.current.type === 'tank', 'saved Tank selected');
    g.atmosphere.setPreset('midday', false);
    const v = g.vehicles.current, start = v.pos.clone(), spin = v.mesh.userData.wheels[0].spin.rotation.x;
    report.phase = 'driving';
    const frames = [], deadline = performance.now() + 1000;
    let last = performance.now();
    g.keys.add('KeyW');
    await new Promise(resolve => {
      function frame(now) {
        frames.push(now - last); last = now;
        if (now < deadline) requestAnimationFrame(frame); else resolve();
      }
      requestAnimationFrame(frame);
    });
    g.keys.clear();
    report.metres = v.pos.distanceTo(start); report.kmh = v.vel.length() * 3.6;
    check(report.metres > .3 && report.kmh > 5, 'Tank drives using game input');
    check(Math.abs(v.mesh.userData.wheels[0].spin.rotation.x - spin) > .1, 'road wheels animate');
    check(v.mesh.userData.wheels.every(w => w.holder.rotation.y === 0), 'tracks remain straight');
    check([...v.pos, ...v.vel, ...v.quat].every(Number.isFinite), 'finite physics');
    const { turret, barrel, muzzle } = v.mesh.userData;
    check(turret && barrel.parent === turret && muzzle.parent === barrel, 'cannon mounts');
    v.vel.set(0, 0, 0);
    const yaw = turret.rotation.y;
    g.keys.add('ArrowLeft'); g.keys.add('ArrowUp');
    await sleep(600); g.keys.clear();
    check(turret.rotation.y > yaw + .2, 'arrows traverse turret');
    check(barrel.rotation.x < -.1, 'arrows elevate barrel');
    check(v.input.throttle === 0 && v.input.brake === 0 && v.input.steer === 0, 'arrows do not drive');
    g.keys.add('KeyQ'); await sleep(100); g.keys.clear();
    check(g.weapons.core.pool.every(p => !p.active), 'tank secondary disabled');
    // Lower the barrel for a visible ground impact in the chase screenshot.
    barrel.rotation.x = .10;
    g.keys.add('KeyE'); await sleep(100); g.keys.clear();
    check(g.weapons.core.shellCooldown > 2, 'cannon fired with 2.5s reload');
    check(g.weapons.core.pool.some(p => p.kind === 'shell'), 'shell uses weapons pool');
    check(document.querySelector('.weapons-ready').textContent.startsWith('Cannon'), 'cannon HUD');
    report.turretYaw = turret.rotation.y; report.barrelPitch = -barrel.rotation.x;
    report.shellReload = g.weapons.core.shellCooldown;
    if (report.view === 'interior') g.setCam(2);
    else if (report.view === 'picker') {
      dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', bubbles: true }));
    } else if (report.view === 'side' || report.view === 'night') {
      if (report.view === 'night') g.atmosphere.setPreset('night', false);
      const render = g.renderer.render.bind(g.renderer);
      g.renderer.render = (scene, camera) => {
        if (scene === g.scene) {
          const eye = v.pos.clone().set(8, 3, report.view === 'night' ? 9 : 0), target = eye.clone().set(0, .6, .6);
          camera.position.copy(v.mesh.localToWorld(eye)); camera.lookAt(v.mesh.localToWorld(target)); camera.updateMatrixWorld();
        }
        render(scene, camera);
      };
    }
    await sleep(400);
    if (report.view === 'interior') {
      const direction = v.vel.clone().set(0, 0, 1).transformDirection(muzzle.matrixWorld);
      check(g.camera.getWorldDirection(v.vel.clone()).dot(direction) > .999, 'gunner view follows barrel');
    }
    if (report.view === 'picker') {
      const chip = document.querySelector('#veh-menu:not([hidden]) [data-kind="car"][data-type="tank"]');
      check(chip?.classList.contains('cur'), 'Tank picker entry selected');
      check(!chip.querySelector('canvas')?.classList.contains('vp-empty'), 'Tank thumbnail drawn');
    }
    if (report.view === 'night') check(g.vehicleLights.on, 'night lights active');
    check(!report.errors.length, report.errors.join('; '));
    frames.sort((a, b) => a - b);
    report.frameMedianMs = frames[Math.floor(frames.length / 2)]; report.frameP95Ms = frames[Math.floor(frames.length * .95)];
    report.phase = 'passed'; document.title = `PASS Tank game check · ${report.view}`;
    console.log('PASS Tank real game', JSON.stringify(report));
  } catch (error) {
    window.game?.keys.clear(); report.phase = 'failed'; report.errors.push(error.message);
    document.title = 'FAIL Tank game check'; console.error('FAIL Tank real game', JSON.stringify(report));
  }
}

const original = await readFile(new URL('../game/index.html', import.meta.url), 'utf8');
const html = original.replace('<head>', '<head><base href="../game/">')
  .replace('https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js', '../node_modules/three/build/three.module.js')
  .replace('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/', '../node_modules/three/examples/jsm/')
  .replace('https://cdn.jsdelivr.net/npm/lil-gui@0.19.2/dist/lil-gui.esm.min.js', '../node_modules/three/examples/jsm/libs/lil-gui.module.min.js')
  .replace(/<!-- Cloudflare Web Analytics -->[\s\S]*?<!-- End Cloudflare Web Analytics -->/, '')
  .replace('</head>', `<script>(${setup})();</script></head>`)
  .replace('</body>', `<script type="module">(${review})();</script></body>`);
await writeFile(new URL('../node_modules/.tank-game-check.html', import.meta.url), html);
console.log('Prepared node_modules/.tank-game-check.html (real game, local dependencies, no production edits)');
