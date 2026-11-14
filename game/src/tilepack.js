// Packed tile files (tools/tilefmt.py), used by the game (world.js) and the Node tests.
// world.json "packed": 1 → height.bin.gz (float32 bytes split into 4 planes, then gzip), surface.bin.gz, ponds.bin.gz,
// tile.json.gz, trees.bin (raw), ground.jpg. Version 2 stores trees.bin.gz with the same 4-byte-plane shuffle.
// Without the flag: the plain files (height.bin, …, ground.png).
// GitHub Pages serves .gz as plain bytes (no Content-Encoding), so they are unpacked here with DecompressionStream
// (built into browsers and Node 18+): it runs as a stream, in chunks, so a tile never stalls a frame for long.

export async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

// height planes back to float32 order: [b0 b0 b0 … | b1 b1 … | b2 … | b3 …] → [b0 b1 b2 b3, b0 b1 b2 b3, …]
export function unshuffle4(buf) {
  const a = new Uint8Array(buf), n = a.length >> 2, o = new Uint8Array(a.length);
  for (let i = 0, j = 0; i < n; i++, j += 4) { o[j] = a[i]; o[j + 1] = a[n + i]; o[j + 2] = a[2 * n + i]; o[j + 3] = a[3 * n + i]; }
  return o.buffer;
}

// file name of the ground picture in a tile folder
export const groundFile = packed => packed ? 'ground.jpg' : 'ground.png';

// read(name) → Promise<ArrayBuffer> of that file in the tile's folder (fetch in the game, fs in tests).
// Returns exactly what makeTileData expects: { hbuf, sbuf, tbuf, pbuf, tile }.
export async function readTileData(read, packed) {
  if (!packed) {
    const [hbuf, sbuf, tbuf, pbuf, tj] = await Promise.all(['height.bin', 'surface.bin', 'trees.bin', 'ponds.bin', 'tile.json'].map(read));
    return { hbuf, sbuf, tbuf, pbuf, tile: JSON.parse(new TextDecoder().decode(tj)) };
  }
  const [h, s, trees, p, tj] = await Promise.all(['height.bin.gz', 'surface.bin.gz', packed >= 2 ? 'trees.bin.gz' : 'trees.bin', 'ponds.bin.gz', 'tile.json.gz'].map(read));
  const [hz, sbuf, tbuf, pbuf, tjson] = await Promise.all([gunzip(h), gunzip(s), packed >= 2 ? gunzip(trees).then(unshuffle4) : trees, gunzip(p), gunzip(tj)]);
  return { hbuf: unshuffle4(hz), sbuf, tbuf, pbuf, tile: JSON.parse(new TextDecoder().decode(tjson)) };
}

// the game's reader: fetch from a tile folder URL
export const fetchReader = dir => name => fetch(dir + name).then(r => {
  if (!r.ok) throw new Error(`${dir}${name}: ${r.status}`);
  return r.arrayBuffer();
});
