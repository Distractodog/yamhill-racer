// The full map (minimap.js) while it is zoomed or dragged: every frame draws only the picture (mapimage.js levels and
// cached patches, street imagery already shown) and the last still drawing of the roads / buildings / names moved and
// scaled to the new view. Once the view has stayed put for SETTLE_MS it is drawn properly again (and new detail is
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
// Where a drawing made of view `snap` ({ ox, oy, s, w, h }: canvas px of picture pixel 0, canvas px per picture pixel,
// its size) goes in the view (ox, oy, s): [x, y, w, h] in canvas px, or null when it would be scaled too far.
export function snapshotPlace(snap, ox, oy, s, maxUp = SNAPSHOT_MAX_UP, maxDown = SNAPSHOT_MAX_DOWN) {
  if (!snap) return null;
  const k = s / snap.s;
  if (!(k <= maxUp && k >= 1 / maxDown)) return null;
  return [ox - snap.ox * k, oy - snap.oy * k, snap.w * k, snap.h * k];
}
