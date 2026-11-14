// TRV3: see tools/treecodec_v3.py. Output retains the existing [x,z,h,type] contract.
export function decodeTrees(buffer) {
  const a = new Uint8Array(buffer), v = new DataView(buffer);
  if (a.length < 20 || a[0] !== 84 || a[1] !== 82 || a[2] !== 86 || a[3] !== 51) throw new Error('Invalid tree header');
  const n = v.getUint32(4, true), tx = v.getInt32(8, true), tz = v.getInt32(12, true), ne = v.getUint32(16, true);
  if (ne === 0xffffffff) return decodeExact(a, v, n, tx, tz);
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

// Exact TRV3 subtype: XOR successive x/z float bits, separated into byte planes.
function decodeExact(a, v, n, tx, tz) {
  if(a.length!==20+n*13)throw Error('Invalid exact tree payload length');
  const out=new ArrayBuffer(n*16),dv=new DataView(out);
  for(let axis=0;axis<3;axis++){
    const o=20+axis*n*4;let previous=0;
    for(let i=0;i<n;i++){
      let bits=(a[o+i]|(a[o+n+i]<<8)|(a[o+2*n+i]<<16)|(a[o+3*n+i]<<24))>>>0;
      if(axis<2){bits=(bits^previous)>>>0;previous=bits;}
      dv.setUint32(i*16+axis*4,bits,true);
    }
  }
  const x0=tx*2000-1000,z0=tz*2000-1000;
  for(let i=0;i<n;i++){
    const flag=a[20+n*12+i];if(flag>2)throw Error('Invalid exact tree type flags');
    dv.setUint32(i*16+12,flag===1?0x3f800000:flag===2?0x80000000:0,true);
    const x=dv.getFloat32(i*16,true),z=dv.getFloat32(i*16+4,true),h=dv.getFloat32(i*16+8,true);
    if(!Number.isFinite(x)||!Number.isFinite(z)||!Number.isFinite(h))throw Error('Nonfinite decoded trees');
    if(x<x0||x>x0+2000||z<z0||z>z0+2000)throw Error('Tree outside tile core');
  }
  return out;
}
