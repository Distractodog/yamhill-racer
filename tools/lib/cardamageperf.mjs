// distractodog technical guardrails, not owner-approved appearance or hardware targets.
// Override any default with YR_DENT_LIMITS='{"impactCpuP95AddedMs":4,...}'.
export const DEFAULT_DENT_LIMITS = Object.freeze({
  impactCpuP95AddedMs: 4, repeatedCpuP95AddedMs: 4, repairCpuP95AddedMs: 4, movingCpuP95AddedMs: 2, frameP95AddedMs: 8,
  frameWorstAddedMs: 20, slow33AddedPoints: 10, slow20AddedPoints: 10,
  pixelChannelThreshold: 24, minDentPixels: 8, maxRepairPixels: 0, maxUploadMismatchPixels: 0,
});
export function dentLimits(json = '{}') {
  const overrides = JSON.parse(json), limits = { ...DEFAULT_DENT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits) || !Number.isFinite(value) || value < 0) throw Error(`distractodog invalid limit ${key}=${value}`);
    limits[key] = value;
  }
  return limits;
}
export function distribution(values) {
  if (!values.length || values.some(x => !Number.isFinite(x))) throw Error('distractodog missing/nonfinite timing samples');
  const sorted = [...values].sort((a, b) => a - b), at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { count: sorted.length, median: at(.5), p95: at(.95), worst: sorted.at(-1) };
}
export function summarizeFrames(frames) {
  const intervals = frames.map(f => Math.max(f.intervalBeforeMs ?? f.intervalAfterMs, f.intervalAfterMs));
  const frame = distribution(intervals);
  return { frameMs: frame, intervalBeforeMs: distribution(frames.map(f => f.intervalBeforeMs ?? f.intervalAfterMs)), intervalAfterMs: distribution(frames.map(f => f.intervalAfterMs)), cpuMs: distribution(frames.map(f => f.stepMs + f.syncMs + f.renderMs + (f.repairMs || 0))),
    stepMs: distribution(frames.map(f => f.stepMs)), repairMs: distribution(frames.map(f => f.repairMs || 0)),
    damageUpdateMs: distribution(frames.map(f => f.damageMs)), syncMeshMs: distribution(frames.map(f => f.syncMs)),
    renderSubmitMs: distribution(frames.map(f => f.renderMs)),
    slow20Percent: intervals.filter(ms => ms > 20).length / frames.length * 100,
    slow33Percent: intervals.filter(ms => ms > 33.3).length / frames.length * 100 };
}
export function compareFrames(baseline, enabled, kind, limits) {
  const a = summarizeFrames(baseline), b = summarizeFrames(enabled);
  const added = { cpuMedianMs: b.cpuMs.median - a.cpuMs.median, cpuWorstMs: b.cpuMs.worst - a.cpuMs.worst,
    damageUpdateP95Ms: b.damageUpdateMs.p95 - a.damageUpdateMs.p95, syncMeshP95Ms: b.syncMeshMs.p95 - a.syncMeshMs.p95,
    renderSubmitP95Ms: b.renderSubmitMs.p95 - a.renderSubmitMs.p95, frameMedianMs: b.frameMs.median - a.frameMs.median,
    slow20Points: b.slow20Percent - a.slow20Percent, cpuP95Ms: b.cpuMs.p95 - a.cpuMs.p95, frameP95Ms: b.frameMs.p95 - a.frameMs.p95,
    frameWorstMs: b.frameMs.worst - a.frameMs.worst, slow33Points: b.slow33Percent - a.slow33Percent };
  const cpuLimit = limits[`${kind}CpuP95AddedMs`];
  if (!Number.isFinite(cpuLimit)) throw Error(`distractodog unknown timing kind ${kind}`);
  const checks = [
    ['cpuP95Ms', cpuLimit],
    ['frameP95Ms', limits.frameP95AddedMs], ['frameWorstMs', limits.frameWorstAddedMs], ['slow33Points', limits.slow33AddedPoints], ['slow20Points', limits.slow20AddedPoints],
  ].map(([metric, limit]) => ({ metric, limit, actual: added[metric], pass: added[metric] <= limit }));
  return { baseline: a, enabled: b, added, checks, pass: checks.every(c => c.pass) };
}

// Installed with page.evaluate: production methods remain intact and are restored per type.
export function installDentTiming() {
  const s = dentShots, c = game.vehicles.current;
  const original = { step: c.step, impact: c.recordImpact, sync: c.syncMesh, update: c.damage.update };
  const frame = () => s.frame ||= { stepMs: 0, syncMs: 0, damageMs: 0, renderMs: 0, repairMs: 0, impact: false };
  s.rawStep = original.step;
  s.restore = () => { c.step = original.step; c.recordImpact = original.impact; c.syncMesh = original.sync; c.damage.update = original.update; };
  c.recordImpact = function(...args) {
    if (s.running && args[7] === 'building') {
      s.contacts.push({ point: args.slice(0, 3), normal: args.slice(3, 6), speed: args[6], source: args[7] });
      frame().impact = true;
    }
    // Baseline changes only the optional cosmetic hook. The same collision code still runs.
    if (s.mode !== 'baseline') return original.impact.apply(this, args);
  };
  c.damage.update = function(...args) {
    const f = frame(), t = performance.now();
    try { return original.update.apply(this, args); } finally { f.damageMs += performance.now() - t; }
  };
  c.syncMesh = function(...args) {
    const f = frame(), t = performance.now(), before = this.damage.applied;
    try { return original.sync.apply(this, args); }
    finally {
      f.syncMs += performance.now() - t; f.dirty = before !== this.damage.applied; f.revision = this.damage.revision; f.applied = this.damage.applied;
      if (s.running || s.measure) {
        const wheels = this.mesh.userData.wheels;
        f.wheelY = wheels.map(w => w.holder.position.y); f.compression = this.wheels.map(w => w.comp);
        f.position = this.pos.toArray(); f.sites = this.damage.sites.length;
      }
    }
  };
  c.step = function(dt) {
    // Hold only photographic poses. Every measured impact/moving run executes real physics.
    if (!s.running) { this.damage.step(dt); return; }
    const f = frame(), t = performance.now();
    const input = { throttle: s.kind === 'moving' && s.steps < 60 ? .6 : 0,
      brake: s.kind === 'moving' && s.steps >= 60 ? .6 : 0, steer: 0, handbrake: false };
    original.step.call(this, dt, input); f.stepMs += performance.now() - t; s.steps++;
    if (s.contacts.length && !s.contactPhysics) {
      s.contactPhysics = { steps: s.steps, pos: this.pos.toArray(), vel: this.vel.toArray(), quat: this.quat.toArray(), ang: this.ang.toArray() };
      s.stopStep = s.steps + (s.measure ? 36 : 0);
    }
    if (s.steps >= (s.kind === 'moving' ? 120 : s.stopStep ?? 600)) {
      s.running = false; s.finished = true;
      s.finalPhysics = { steps: s.steps, pos: this.pos.toArray(), vel: this.vel.toArray(), quat: this.quat.toArray(), ang: this.ang.toArray() };
    }
  };
}
