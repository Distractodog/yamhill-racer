// The full map (minimap.js) while it is zoomed or dragged: every frame draws only the picture (mapimage.js levels and
// cached patches, street imagery already shown) at pixel ratio 1 and the last still drawing of the roads / buildings /
// names moved and scaled to the new view. Once the view has stayed put for SETTLE_MS it is drawn properly again (and new detail is
// requested), exactly as when it never moved. Pure: tested by tools/mapview_test.mjs.
export const SETTLE_MS = 150;
export const SNAPSHOT_MAX_UP = 2.5;      // stretched more than this the old drawing is blurrier than the picture under it
export const SNAPSHOT_MAX_DOWN = 8;      // shrunk more than this it is a speck
// step(viewKey, ms) every frame: true when the view is still (unchanged for `delay` ms, or the first frame after reset)
export function createSettle(delay = SETTLE_MS) {
  let key = null, moved = -Infinity;
  return {
    step(next, now) { if (key !== null && next !== key) moved = now; key = next; return now - moved >= delay; },
    reset() { key = null; moved = -Infinity; },
  };
}
// Wheel / + − zoom eases to its goal instead of jumping a notch at a time: each frame covers 1 − e^(−dt/τ) of what is
// left (in log zoom, so in and out feel the same); ~95 % after 3τ = 120 ms. Returns the next zoom and whether it arrived.
export const ZOOM_EASE_MS = 40;
export function easeZoom(zoom, goal, dtMs, tau = ZOOM_EASE_MS) {
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau), next = zoom * (goal / zoom) ** k;
  return Math.abs(Math.log(goal / next)) < 2e-3 ? { zoom: goal, done: true } : { zoom: next, done: false };
}
// a mouse wheel notch eases; a trackpad's stream of small deltas (pinch = ctrlKey, two-finger scroll) is applied as it
// comes, so it stays continuous and under the fingers
export const wheelEases = e => !e.ctrlKey && (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40);
// While the map is being zoomed / dragged it draws at most at pixel ratio MOVING_DPR (¼ of the pixels on a Retina
// screen) and the still view is drawn sharp at the full ratio once it settles.
export const MOVING_DPR = 1;
export const drawRatio = (dpr, moving) => moving ? Math.min(dpr, MOVING_DPR) : dpr;
// busy: input within QUIET_MS (a gesture, or one that just ended). The game holds its world building, warm-up and
// map detail parsing meanwhile (main.js, mapdetail.js), so the map gets the main thread. touch(now) on each input event.
export const QUIET_MS = 300;
export function createQuiet(delay = QUIET_MS) {
  let last = -Infinity;
  return { touch(now) { last = now; }, busy(now) { return now - last < delay; }, reset() { last = -Infinity; } };
}
// main.js: draw the 3D view this frame? Map closed: always. Full map open: it holds its last frame (one is drawn if
// there is none yet), except in a multiplayer game mid-game (not the spawn map), where it is redrawn every
// BEHIND_MAP_MS so the other players behind the map don't freeze; never while the map is busy (zoomed / dragged).
export const BEHIND_MAP_MS = 250;
export function draw3D({ open, drawn, multiplayer, spawn, busy, now, last }) {
  if (!open || !drawn) return true;
  return multiplayer && !spawn && !busy && now - last >= BEHIND_MAP_MS;
}
// Where a drawing made of view `snap` ({ ox, oy, s, w, h }: canvas px of picture pixel 0, canvas px per picture pixel,
// its size) goes in the view (ox, oy, s): [x, y, w, h] in canvas px, or null when it would be scaled too far.
export function snapshotPlace(snap, ox, oy, s, maxUp = SNAPSHOT_MAX_UP, maxDown = SNAPSHOT_MAX_DOWN) {
  if (!snap) return null;
  const k = s / snap.s;
  if (!(k <= maxUp && k >= 1 / maxDown)) return null;
  return [ox - snap.ox * k, oy - snap.oy * k, snap.w * k, snap.h * k];
}
