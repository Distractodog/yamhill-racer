// Decode H3Q0 heights into the existing float32 grid used by terrain and physics.
export function decodeHeightsV3(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 16 || v.getUint32(0, true) !== 0x30513348) throw Error('Invalid v3 height header');
  const n = v.getUint16(4, true), flags = v.getUint16(6, true), base = v.getFloat32(8, true), count = v.getUint32(12, true);
  const end = 16 + 2*n*n;
  if (!n || flags || !Number.isFinite(base) || v.byteLength !== end + count*8) throw Error('Invalid v3 height payload');
  const q = new Uint16Array(n*n), out = new Float32Array(n*n);
  for (let i=0; i<q.length; i++) {
    const zig = v.getUint16(16+2*i, true), residual = (zig >>> 1) ^ -(zig & 1);
    const left = i%n ? q[i-1] : 0, up = i>=n ? q[i-n] : 0, diagonal = i>=n && i%n ? q[i-n-1] : 0;
    q[i] = (left+up-diagonal+residual) & 65535;
    out[i] = base+q[i]*.02;
  }
  for (let i=0; i<count; i++) {
    const index = v.getUint32(end+8*i, true), value = v.getFloat32(end+8*i+4, true);
    if (index >= out.length || !Number.isFinite(value)) throw Error('Invalid v3 height correction');
    out[index] = value;
  }
  return out.buffer;
}
