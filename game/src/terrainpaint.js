// Clip ground paint to the same 4 m triangles used by the near terrain mesh.
// Sampling only a decal's corners lets its faces cut through hills between them.
// Shared triangulation also keeps lane paint consistently above its red base.
export function terrainPaintQuad(a, b, c, d, ground, lift, emit, step = 4) {
  const polygon = [a, b, c, d].map(p => [p[0], p[2]]);
  const xs = polygon.map(p => p[0]), zs = polygon.map(p => p[1]);
  const x0 = Math.floor(Math.min(...xs) / step) * step, x1 = Math.max(...xs);
  const z0 = Math.floor(Math.min(...zs) / step) * step, z1 = Math.max(...zs);
  const cross = (a,b,p) => (b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
  function clip(poly, a, b) {
    const out=[];
    for(let i=0;i<poly.length;i++) {
      const p=poly[i], q=poly[(i+1)%poly.length], dp=cross(a,b,p), dq=cross(a,b,q);
      if(dp>=-1e-8) out.push(p);
      if((dp>=0)!==(dq>=0)) { const t=dp/(dp-dq); out.push([p[0]+t*(q[0]-p[0]),p[1]+t*(q[1]-p[1])]); }
    }
    return out;
  }
  for(let z=z0;z<z1;z+=step) for(let x=x0;x<x1;x+=step) {
    const h00=ground(x,z), h10=ground(x+step,z), h01=ground(x,z+step), h11=ground(x+step,z+step);
    const corners=[[x,z],[x+step,z],[x,z+step],[x+step,z+step]];
    for(const [ids,upper] of [[[0,1,2],false],[[1,3,2],true]]) {
      let poly=polygon;
      for(let i=0;i<3 && poly.length;i++) poly=clip(poly,corners[ids[i]],corners[ids[(i+1)%3]]);
      const point=([px,pz])=>{
        const u=(px-x)/step,v=(pz-z)/step;
        const h=upper ? h11+(1-u)*(h01-h11)+(1-v)*(h10-h11) : h00+u*(h10-h00)+v*(h01-h00);
        return [px,h+lift,pz];
      };
      for(let i=1;i<poly.length-1;i++) {
        if(Math.abs(cross(poly[0],poly[i],poly[i+1]))<1e-9) continue;
        // Terrain faces point up (clockwise when viewed in the x/z plane).
        const p=point(poly[0]),q=point(poly[i]),r=point(poly[i+1]);
        if(cross(poly[0],poly[i],poly[i+1])>0) emit(p,r,q); else emit(p,q,r);
      }
    }
  }
}
