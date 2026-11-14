// Published tiles use only packed v3; Python tooling retains legacy conversion readers.
import { decodeHeightsV3 } from './heightcodec_v3.js';
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
    tile: JSON.parse(new TextDecoder().decode(json)) };
}

// the game's reader: fetch from a tile folder URL
export const fetchReader = dir => name => fetch(dir + name).then(r => {
  if (!r.ok) throw new Error(`${dir}${name}: ${r.status}`);
  return r.arrayBuffer();
});
