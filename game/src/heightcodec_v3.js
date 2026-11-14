// H3Q0 flag8 restores original float32 bits; legacy flag0 remains readable.
export function decodeHeightsV3(buffer) {
  const v = new DataView(buffer);
  if (v.byteLength < 16 || v.getUint32(0, true) !== 0x30513348) throw Error('Invalid v3 height header');
  const n = v.getUint16(4, true), flags = v.getUint16(6, true), base = v.getFloat32(8, true), count = v.getUint32(12, true);
  if (!n || (flags !== 0 && flags !== 8) || !Number.isFinite(base)) throw Error('Unsupported height header');
  if (flags === 8) {
    const length = n*n;
    if (v.getUint32(8,true) !== 0 || count !== 0 || v.byteLength !== 16 + 4*length) throw Error('Invalid lossless height payload');
    const bits = new Uint32Array(length);
    for (let i = 0; i < length; i++) {
      const zig = (v.getUint8(16+i) | (v.getUint8(16+length+i) << 8) |
        (v.getUint8(16+2*length+i) << 16) | (v.getUint8(16+3*length+i) << 24)) >>> 0;
      bits[i] = ((zig >>> 1) ^ -(zig & 1)) >>> 0;
    }
    // Reverse vertical differencing twice, then horizontal once. Each store
    // wraps modulo 2^32; sums are exact within JavaScript's integer range.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = n; i < length; i++) bits[i] = (bits[i] + bits[i-n]) >>> 0;
    }
    for (let row = 0; row < n; row++) {
      for (let col = 1; col < n; col++) {
        const i = row*n+col; bits[i] = (bits[i] + bits[i-1]) >>> 0;
      }
    }
    const out = new ArrayBuffer(length*4), result = new DataView(out);
    for (let i = 0; i < length; i++) {
      result.setUint32(i*4, bits[i], true);
      if (!Number.isFinite(result.getFloat32(i*4, true))) throw Error('Nonfinite decoded heights');
    }
    return out;
  }
  const end = 16 + 2*n*n;
  if (v.byteLength !== end + count*8) throw Error('Invalid legacy height payload');
  const q = new Uint16Array(n*n), out = new Float32Array(n*n);
  for (let i = 0; i < q.length; i++) {
    const zig = v.getUint16(16+2*i, true), residual = (zig >>> 1) ^ -(zig & 1);
    const left = i%n ? q[i-1] : 0, up = i>=n ? q[i-n] : 0, diagonal = i>=n && i%n ? q[i-n-1] : 0;
    q[i] = (left+up-diagonal+residual) & 65535;
    out[i] = base+q[i]*.02;
  }
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const index = v.getUint32(end+8*i, true), value = v.getFloat32(end+8*i+4, true);
    if (index >= out.length || !Number.isFinite(value) || seen.has(index)) throw Error('Invalid height correction');
    seen.add(index); out[index] = value;
  }
  for (const value of out) if (!Number.isFinite(value)) throw Error('Nonfinite decoded heights');
  return out.buffer;
}
