// Pure, coordinate-seeded selection: independent of tile/build order and frame time.
function random(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
}
export function buildingSeed(points) {
  return String(Math.floor(random(points.map(p => p.map(n => n.toFixed(2)).join(',')).sort().join(';')) * 4294967296));
}
// Negative = unlit, otherwise the night value at which this pane switches on.
export function windowThreshold(seed, x, y, z) {
  const key = `${seed}/${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}`;
  const fraction = .4 + .3 * random(seed);
  return random(key) < fraction ? .12 + .6 * random(key + '/dusk') : -1;
}
