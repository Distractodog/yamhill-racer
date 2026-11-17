// Tile loading for world.js: fetch → build (a generator, stepped within each frame's time budget) → finish.
// A tile that fails anywhere (download, a corrupt file throwing while it is decoded in a build step, a build step, a
// build that returns nothing, finish) is dropped cleanly: its job leaves the queue, whatever it had built so far is
// freed (free(job): the build puts its partial output on job.partial), it stops counting as loading, and it may be
// tried again `retryMs` later. Before, an error inside a build step threw out of the frame loop and left the tile
// "loading" for good: it never came, and it held one of the three streaming slots.
//   const q = createTileQueue({ fetch: job => data, build: (job, data) => generator, finish: (job, value) => {}, free: job => {} });
//   q.start(key, { tx, tz }, sync?)  ·  q.update(budgetMs, job => distance)  ·  q.pending()  ·  q.loading  ·  q.slowStep
// A tile's download: its data and its ground bitmaps (loadBitmaps() → a list of promises, one per bitmap) in parallel.
// If any part fails, every bitmap made is closed: those already there, and those that arrive after the failure
// (otherwise each failed tile left up to four 1024² bitmaps behind).
export async function fetchTileParts(loadData, loadBitmaps) {
  let failed = false;
  const made = [];
  const keep = b => { if (failed) b?.close?.(); else made.push(b); return b; };
  const bitmaps = Promise.resolve().then(loadBitmaps).then(list => Promise.all(list.map(p => Promise.resolve(p).then(keep))));
  try {
    const [data, img] = await Promise.all([Promise.resolve().then(loadData), bitmaps]);
    return { data, img };
  } catch (e) {
    failed = true; made.splice(0).forEach(b => b?.close?.());
    throw e;
  }
}

export function createTileQueue({ fetch, build, finish, free = () => {}, now = () => performance.now(), retryMs = 3000,
  warn = (...a) => console.warn(...a) }) {
  const loading = new Set(), failedAt = new Map(), jobs = [];
  let carry = 0;                            // ms of last frame's budget left because the next step didn't fit
  const stepCost = new Map();               // step kind (what the generator yielded before it) -> recent cost, ms
  const slowStep = { label: '', ms: 0 };    // this frame's slowest build step (tools/lib/hitchprobe.mjs reads it)
  const drop = job => { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); };
  function fail(job, e) {
    warn(`tile ${job.k}:`, e);
    drop(job);
    try { job.gen?.return(); } catch {}
    try { free(job); } catch (e2) { warn(`tile ${job.k}: freeing a failed build:`, e2); }
    job.failed = true; loading.delete(job.k); failedAt.set(job.k, now());
  }
  // one build step: 'more' | 'done' | 'failed'
  function stepOnce(job) {
    let r;
    try { r = job.gen.next(); } catch (e) { fail(job, e); return 'failed'; }
    if (!r.done) { job.next = r.value; return 'more'; }
    drop(job);
    if (!r.value) { fail(job, new Error('the build returned nothing')); return 'failed'; }
    try { finish(job, r.value); } catch (e) { job.partial = r.value; fail(job, e); return 'failed'; }
    loading.delete(job.k); failedAt.delete(job.k);
    return 'done';
  }
  return {
    loading, failedAt, jobs, slowStep,
    pending: () => loading.size + jobs.length,
    canStart: k => !loading.has(k) && (failedAt.get(k) ?? -Infinity) <= now() - retryMs,
    // sync: build it all at once as soon as it has arrived (the start-up tiles)
    start(k, info = {}, sync = false) {
      if (!this.canStart(k)) return null;
      loading.add(k);
      const job = { ...info, k, gen: null, next: undefined, partial: null, failed: false };
      return Promise.resolve().then(() => fetch(job)).then(data => {
        job.gen = build(job, data);
        if (sync) { while (stepOnce(job) === 'more'); } else jobs.push(job);
      }).catch(e => { if (!job.failed) fail(job, e); });
    },
    // Each step's cost is remembered by the label the job yielded just before it (that label tells which piece comes
    // next); a step only starts if its usual cost still fits in what is left of this frame's budget. The first step
    // of a frame always runs, so the queue never stalls. order(job): nearest first.
    // The cost kept is a cautious one (it jumps up at once and falls slowly), so with a tile cut into many small steps a
    // frame used to stop ~1/4 of its budget early (McMinnville: 3.7 of 5 ms a frame on average, tools/ground_lag_sim.mjs
    // --teleport). What a frame leaves because the next step didn't fit is carried to the next frame (up to
    // CARRY_MAX_MS), so the builder gets its whole budget on average without bigger frames.
    update(budget, order = null) {
      if (order && jobs.length > 1) jobs.sort((p, q) => order(p) - order(q));
      slowStep.ms = 0;
      const t0 = now(), total = budget + carry;
      for (let first = true; jobs.length; first = false) {
        const t = now(), j = jobs[0], label = j.next;
        if (!first && t - t0 + (stepCost.get(label) || 0) > total) break;
        stepOnce(j);
        const d = now() - t, c = stepCost.get(label);
        stepCost.set(label, c === undefined ? d : Math.max(d, c * 0.9 + d * 0.1));   // falls slowly, jumps up at once
        if (d > slowStep.ms) { slowStep.ms = d; slowStep.label = label || 'decode-height'; }
      }
      carry = jobs.length ? Math.min(CARRY_MAX_MS, Math.max(0, total - (now() - t0))) : 0;
    },
    get carry() { return carry; },
  };
}

// The tile builder's time for one frame (ms). base: its budget for a 60 Hz frame (world.js: 5 ms, up to 9 at speed,
// plus a respawn hold's extra); frameMs: the recent frame interval. A frame slower than 60 Hz (a GPU-bound Retina
// screen, a busy machine) gets proportionally more, up to FRAME_MAX_MS, so the world loads as many ms a second at 40 fps
// as at 60 instead of a third slower; 60 Hz and faster screens keep base (a 120 Hz one builds twice a 60 Hz frame's).
export const REF_FRAME_MS = 1000 / 60, FRAME_MAX_MS = 9, CARRY_MAX_MS = 2.5;
export function frameBudget(base, frameMs = REF_FRAME_MS) {
  const scaled = base * Math.min(Math.max(frameMs, REF_FRAME_MS), 100) / REF_FRAME_MS;
  return Math.max(base, Math.min(scaled, FRAME_MAX_MS));
}
