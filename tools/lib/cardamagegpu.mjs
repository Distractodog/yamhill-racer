// distractodog supplementary GPU readback: render the SAME scene/camera within one task,
// with no world/effects/lighting tick between phases. Only the car is moved/damaged/reset.
// Canvas pixels contain no DOM HUD. This is correctness evidence, never a timed GPU benchmark.
export async function probeDentUploads(options = {}) {
  const THREE = await import('three');
  const c = options.car || game.vehicles.current, renderer = options.renderer || game.renderer;
  const scene = options.scene || game.scene, camera = (options.camera || dentShots.camera).clone();
  const step = options.step || (options.car ? c.step : dentShots.rawStep) || c.step;
  const display = options.display || dentShots.display, site = options.site || dentShots.site;
  const width = options.width || 640, height = options.height || 400;
  camera.aspect = width / height; camera.updateProjectionMatrix();
  const target = new THREE.WebGLRenderTarget(width, height), previous = renderer.getRenderTarget();
  const viewport = renderer.getViewport(new THREE.Vector4()), scissor = renderer.getScissor(new THREE.Vector4()), scissorTest = renderer.getScissorTest();
  const render = options.render || renderer.render.bind(renderer), images = {}, pixels = {}, stages = [];
  function stand(repair) {
    if (repair) c.reset(display.x, display.z, display.yaw);
    else { c.pos.set(display.x, c.world.heightAt(display.x, display.z) + (c.typePhysics ? c.t.restLength + c.typePhysics.radius : .75), display.z); c.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), display.yaw); }
    c.vel.set(0, 0, 0); c.ang.set(0, 0, 0); c.latAcc = c.lonAcc = c.steer = 0;
    c.mesh.userData.bodyPivot.rotation.set(0, 0, 0);
    c.wheels.forEach(w => { w.spin = 0; w.comp = w.prevComp = 0; w.contact = false; w.terrainHeight = undefined; });
    c.savePrev(); c.interpolate(0);
  }
  function capture(name, reference = false) {
    const t = performance.now(); if (!reference) c.syncMesh(1 / 60); const synced = performance.now();
    renderer.setRenderTarget(target); renderer.setViewport(0, 0, width, height); renderer.setScissorTest(false);
    const swapped = [];
    // Independent cold upload reference: identical production CPU geometry, fresh GL buffers.
    // This exposes partial upload ranges even when changed normals alone alter some pixels.
    if (reference) c.mesh.traverse(o => { if (o.isMesh) { const original = o.geometry; o.geometry = original.clone(); swapped.push([o, original]); } });
    try { render(scene, camera); } finally { for (const [mesh, original] of swapped) { mesh.geometry.dispose(); mesh.geometry = original; } }
    const submitted = performance.now();
    const p = new Uint8Array(width * height * 4); renderer.readRenderTargetPixels(target, 0, 0, width, height, p);
    pixels[name] = p;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) image.data.set(p.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4);
    ctx.putImageData(image, 0, 0); if (!name.startsWith('moving-')) images[name] = canvas.toDataURL('image/png');
    stages.push({ name, syncMs: synced - t, renderSubmitMs: submitted - synced, sites: c.damage.sites.length,
      revision: c.damage.revision, applied: c.damage.applied });
  }
  function difference(a, b) {
    let count = 0, max = 0;
    const threshold = options.pixelChannelThreshold ?? 24;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(...[0, 1, 2].map(k => Math.abs(a[i + k] - b[i + k])));
      max = Math.max(max, d); if (d > threshold) count++;
    }
    return { pixels: count, fraction: count / (width * height), maxChannel: max, threshold };
  }
  try {
    stand(true); capture('pristine-warm'); capture('pristine');
    // Production collision helper, without a synthetic damage call or vertex injection.
    function collide() {
      c.pos.set(site.x + site.nx * 1.45 * (c.typePhysics?.width ?? 1), .75 + c.world.heightAt(site.x, site.z), site.z + site.nz * 1.45 * (c.typePhysics?.width ?? 1));
      c.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-site.nx, -site.nz));
      c.vel.set(-site.nx * 45, 0, -site.nz * 45); c.grounded = true; c.damage.step(.3); c.collideBuildings();
    }
    function moveSuspension() {
      // Actual fixed-step acceleration/braking changes the wheel/arm pose before the next
      // deformation/reset. A still pose can accidentally avoid the partial-upload bug.
      c.vel.set(0, 0, 12);
      for (let i = 0; i < 18; i++) {
        c.savePrev(); step.call(c, 1 / 120, { throttle: i < 9 ? 1 : 0, brake: i >= 9 ? 1 : 0, steer: .3, handbrake: false });
        c.interpolate(1); capture(`moving-${stages.length}`);
      }
    }
    collide();
    const contactSites = c.damage.sites.length;
    stand(false); capture('dented-first');
    // Real sync/render interleaving exercises race-car moving linkage upload ranges.
    for (let i = 0; i < 4; i++) capture(`dented-sync-${i}`);
    moveSuspension(); collide(); stand(false); capture('repeated-first'); capture('repeated-first-reference', true);
    for (let i = 0; i < 4; i++) capture(`repeated-sync-${i}`);
    capture('dented-reference', true);
    moveSuspension();
    const t = performance.now(); stand(true); const resetCpuMs = performance.now() - t;
    capture('reset-first'); for (let i = 0; i < 4; i++) capture(`reset-sync-${i}`);
    capture('reset-reference', true);
    const dentFirstUpload = difference(pixels['repeated-first'], pixels['repeated-first-reference']);
    const dentUpload = difference(pixels['repeated-sync-3'], pixels['dented-reference']);
    const resetUpload = difference(pixels['reset-sync-3'], pixels['reset-reference']);
    const dent = difference(pixels.pristine, pixels['repeated-sync-3']);
    const repair = difference(pixels.pristine, pixels['reset-sync-3']);
    const repairFirst = difference(pixels.pristine, pixels['reset-first']);
    return { author: 'distractodog', evidence: 'actual syncMesh/render/readback; production collision helper; scene and lighting fixed in one task; DOM HUD excluded',
      width, height, stages, contactSites, resetCpuMs, dent, repair, repairFirst, dentFirstUpload, dentUpload, resetUpload, images,
      pass: dentFirstUpload.pixels <= (options.maxUploadMismatchPixels ?? 0) && dentUpload.pixels <= (options.maxUploadMismatchPixels ?? 0) && resetUpload.pixels <= (options.maxUploadMismatchPixels ?? 0) && contactSites > 0 && dent.pixels >= (options.minDentPixels ?? 8) && repair.pixels <= (options.maxRepairPixels ?? 0) && repairFirst.pixels <= (options.maxRepairPixels ?? 0) };
  } finally {
    renderer.setRenderTarget(previous); renderer.setViewport(viewport); renderer.setScissor(scissor); renderer.setScissorTest(scissorTest); target.dispose();
  }
}
