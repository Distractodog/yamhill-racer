// One road mesh per block, instead of one mesh per strip batch.
// roads.js still builds the triangles, so markings, vertex colours, and the shared
// road material stay as they are. A block is a 250 m square. Batches are grouped
// by the midpoint of each strip, and only batches that already belong to one tile
// are combined (the caller runs this once per tile).
// A long slice stays on its own. Folding it into a block would make that block's
// detailed mesh cover the whole slice, so markings would be drawn much farther away.

const CELL = 250;
const LONG = 400;

export function mergeRoadBatches(batches) {
  const groups = new Map();
  const alone = [];
  for (const batch of batches) {
    if (batch.length === 1 && batch[0].b - batch[0].a >= LONG) { alone.push(batch); continue; }
    let sx = 0, sz = 0, n = 0;
    for (const part of batch) {
      const i = part.a + ((part.b - part.a) >> 1);
      sx += part.r.x[i]; sz += part.r.z[i]; n++;
    }
    const key = Math.floor((sx / n) / CELL) + ',' + Math.floor((sz / n) / CELL);
    let list = groups.get(key);
    if (!list) groups.set(key, list = []);
    for (const part of batch) list.push(part);
  }
  return [...groups.values(), ...alone];
}

// roadLOD builds the near and far meshes. Give each one a bounding sphere now so a
// block outside the camera is culled without waiting for the first frame that sees it.
export function placeRoadBlock(tile, material, batch, roadLOD) {
  const lod = roadLOD(tile, material, batch);
  lod.traverse(o => { if (o.isMesh && o.geometry) o.geometry.computeBoundingSphere(); });
  return lod;
}
