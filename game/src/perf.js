// Optional readout: open the game with ?perf. The tick updates the text twice a second
// and does no work that allocates on the frames in between.
//
// Cost at McMinnville NE 3rd (x=19451, z=-11032, yaw=-1.573), headless Chrome, 1280×760.
// One group hidden at a time, 1.5 s sample, before the block merge:
//   all               16.7 ms   344 calls   1340711 tris   0% of frames over 20 ms
//   roads hidden      16.7 ms   270 calls    692905 tris   74 calls, about half the triangles
//   junctions hidden  16.7 ms   334 calls   1136912 tris
//   terrain hidden    16.7 ms   311 calls   1211533 tris
//   trees hidden      16.7 ms   344 calls   1340711 tris   instanced trees were off this view
//   buildings hidden  16.7 ms   340 calls   1170091 tris
//   water hidden      16.7 ms   342 calls   1333893 tris
//
// After merging road batches into 250 m blocks, 20 s bench:
//   McMinnville   1400707 tris   333 calls   16.7 ms   0%
//   Sheridan      1106513 tris   298 calls   16.7 ms   0%
//   Willamina      869295 tris   249 calls   16.7 ms   0%
//   campus         567095 tris   151 calls   16.7 ms   0%
// The same spots before the merge were 344 / 301 / 250 / 153 calls, still 16.7 ms and 0%.
//
// What was tried: the block merge is the change that shipped. Draw calls fell and the frame
// stayed on the 16.7 ms cap. Triangles rose a little because a block's detailed mesh stays
// up until the whole block is far. Buildings were already one mesh per tile (4 calls here).
// Shadows already cover 75 m, inside the 100 m cap. Far road markings already drop past
// about 350 m in roads.js. A further merge was not worth the extra triangles.

const OFF = () => {};

export function installPerf(renderer) {
  if (typeof location === 'undefined' || !/[?&]perf\b/.test(location.search)) return OFF;
  const el = document.createElement('pre');
  el.id = 'perf';
  el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:40;margin:0;padding:6px 8px;'
    + 'background:rgba(0,0,0,.72);color:#e8f0e8;font:12px/1.4 ui-monospace,monospace;pointer-events:none;border-radius:6px;';
  document.body.append(el);
  let last = 0, left = 0, frames = 0, acc = 0;
  return function tick() {
    const now = performance.now();
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    frames++; acc += dt; left += dt;
    if (left < 0.5) return;
    left = 0;
    const info = renderer.info.render;
    el.textContent = Math.round(frames / acc) + ' fps  ' + info.calls + ' calls  ' + info.triangles + ' tris';
    frames = 0; acc = 0;
  };
}
