// TRV3: see tools/treecodec_v3.py. Output retains the existing [x,z,h,type] contract.
export function decodeTrees(buffer) {
  const a = new Uint8Array(buffer), v = new DataView(buffer);
  if (a.length < 20 || a[0] !== 84 || a[1] !== 82 || a[2] !== 86 || a[3] !== 51) throw new Error('Invalid tree header');
  const n = v.getUint32(4, true), tx = v.getInt32(8, true), tz = v.getInt32(12, true), ne = v.getUint32(16, true);
  if (a.length !== 20 + n * 9 + ne * 12) throw new Error('Invalid tree payload length');
  const out = new ArrayBuffer(n * 16), dv = new DataView(out), h0 = 20 + n * 5;
  for (let i = 0; i < n; i++) {
    const flags = a[20 + n * 4 + i], j = i * 16;
    if (flags & 248) throw new Error('Unknown tree flags');
    dv.setFloat32(j, tx * 2000 - 1000 + ((a[20 + i] | (a[20 + n + i] << 8)) * 2 + ((flags >> 1) & 1)) * .02, true);
    dv.setFloat32(j + 4, tz * 2000 - 1000 + ((a[20 + n * 2 + i] | (a[20 + n * 3 + i] << 8)) * 2 + ((flags >> 2) & 1)) * .02, true);
    for (let b = 0; b < 4; b++) dv.setUint8(j + 8 + b, a[h0 + b * n + i]);
    dv.setFloat32(j + 12, flags & 1, true);
  }
  const seen = new Set();
  for (let i = 0, j = 20 + n * 9; i < ne; i++, j += 12) {
    const index = v.getUint32(j, true);
    if (index >= n || seen.has(index)) throw new Error('Invalid tree exception index');
    seen.add(index);
    dv.setFloat32(index * 16, v.getFloat32(j + 4, true), true);
    dv.setFloat32(index * 16 + 4, v.getFloat32(j + 8, true), true);
  }
  for (let i = 0; i < n * 16; i += 4) if (!Number.isFinite(dv.getFloat32(i, true))) throw new Error('Nonfinite decoded tree');
  return out;
}
