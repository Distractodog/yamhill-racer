// Published tiles use only packed v3; Python tooling retains legacy conversion readers.
import { decodeHeightsV3 } from './heightcodec_v3.js';
import { decodeGeometry, decodeGeometrySteps } from './geometrycodec_v3.js';
import { decodeTrees } from './treecodec_v3.js';

export async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function requireV3(packed) {
  if (packed !== 3) throw new Error('Unsupported tile format: expected packed v3');
}
export function groundFile(packed) { requireV3(packed); return 'ground.webp'; }

// Preserve the makeTileData contract; only storage decoding changes.
export async function readTileData(read, packed) {
  requireV3(packed);
  const names = ['height.bin.gz', 'surface.bin.gz', 'trees.bin.gz', 'ponds.bin.gz', 'tile.json.gz'];
  const [height, sbuf, trees, pbuf, json] = await Promise.all(names.map(async name => gunzip(await read(name))));
  return { hbuf: decodeHeightsV3(height), sbuf, tbuf: decodeTrees(trees), pbuf,
    tile: decodeGeometry(JSON.parse(new TextDecoder().decode(json))) };
}
// The game's split of readTileData (world.js): readTileRaw only fetches and unzips (off the main thread); the
// decoding (~15 ms for a typical tile, up to ~150 ms for a McMinnville one) then runs as decodeTileSteps inside the
// time-sliced tile build, a piece per step, instead of all at once in a promise callback (a frame-sized stall when
// many tiles arrive at once, as after a respawn or a teleport). Same result as readTileData.
export async function readTileRaw(read, packed) {
  requireV3(packed);
  const names = ['height.bin.gz', 'surface.bin.gz', 'trees.bin.gz', 'ponds.bin.gz', 'tile.json.gz'];
  const [height, sbuf, trees, pbuf, json] = await Promise.all(names.map(async name => gunzip(await read(name))));
  return { height, sbuf, trees, pbuf, json };
}
export function* decodeTileSteps({ height, sbuf, trees, pbuf, json }) {
  const hbuf = decodeHeightsV3(height); yield 'decode-trees';
  const tbuf = decodeTrees(trees); yield 'decode-json';
  const parsed = JSON.parse(new TextDecoder().decode(json)); yield 'geometry';
  return { hbuf, sbuf, tbuf, pbuf, tile: yield* decodeGeometrySteps(parsed, { inPlace: true }) };
}

// the game's reader: fetch from a tile folder URL
export const fetchReader = dir => name => fetch(dir + name).then(r => {
  if (!r.ok) throw new Error(`${dir}${name}: ${r.status}`);
  return r.arrayBuffer();
});
