// Flat sports surfaces share the terrain grid and surface queries with vehicles.
import { APRON, courtPoly, standAt } from './campussat.js';
export function polygonDistance(poly,x,z) {
  let inside=false,d=Infinity;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++) {
    const a=poly[j],b=poly[i],dx=b[0]-a[0],dz=b[1]-a[1];
    if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])inside=!inside;
    const t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));
    d=Math.min(d,Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t));
  }
  return inside?0:d;
}
export const standPoly=[[-34,-4.8],[34,-4.8],[34,4.8],[-34,4.8]].map(([u,v])=>standAt(u,v));
export function levelPolygon(td,poly,y) {
  const xs=poly.map(p=>p[0]),zs=poly.map(p=>p[1]),blend=8;
  const j0=Math.max(0,Math.floor((Math.min(...xs)-blend-td.gx0)/td.hs)),j1=Math.min(td.NN-1,Math.ceil((Math.max(...xs)+blend-td.gx0)/td.hs));
  const i0=Math.max(0,Math.floor((Math.min(...zs)-blend-td.gz0)/td.hs)),i1=Math.min(td.NN-1,Math.ceil((Math.max(...zs)+blend-td.gz0)/td.hs));
  for(let i=i0;i<=i1;i++)for(let j=j0;j<=j1;j++) {
    const d=polygonDistance(poly,td.gx0+j*td.hs,td.gz0+i*td.hs);
    // One grid-cell margin makes interpolated triangles flat all the way to the edge.
    const t=Math.min(1,Math.max(0,(d-4)/4)),w=t*t*(3-2*t),k=i*td.NN+j;
    td.H[k]=y+(td.H[k]-y)*w;
  }
}
export function applySatelliteGround(td,trackLevel,runways) {
  // These additions all belong to 0_0, matching the track mesh's tile ownership.
  if(td.tx!==0||td.tz!==0)return;
  const courtLevel=td.terrainAt(...courtPoly[0]);
  for(const p of [standPoly,APRON,...runways])levelPolygon(td,p,trackLevel);
  levelPolygon(td,courtPoly,courtLevel);
  const base=td.surfaceAt;
  td.surfaceAt=(x,z,y)=> {
    if(x>-650&&x<-590&&z>-10&&z<90&&polygonDistance(APRON,x,z)===0)return 6;
    if(x>-490&&x<-430&&z>-205&&z<-120&&polygonDistance(courtPoly,x,z)===0)return 7;
    return base(x,z,y);
  };
}
// Save only nearby samples; then rebase baked roads/junctions after athletics terrain leveling.
// The old implementation changed H after preparing strips, leaving strips buried under the new slope.
export function athleticsRoadSnapshot(td) {
  const near=(x,z)=>x>-710&&x<-400&&z>-230&&z<170;
  const samples=[];
  for(const r of [...td.roads,...td.renderRoads])for(let i=0;i<r.n;i++) {
    if(r.bridge||!near(r.x[i],r.z[i]))continue;
    const x=r.x[i],z=r.z[i],dx=r.lx[i]*r.hw,dz=r.lz[i]*r.hw;
    samples.push({r,i,x,z,dx,dz,l:td.terrainAt(x+dx,z+dz),r0:td.terrainAt(x-dx,z-dz)});
  }
  const points=[];
  for(const j of [...(td.sourceJunctions||[]),...(td.renderJunctions||[])]) {
    // Render/source arrays can share objects. Avoid applying the delta twice.
    for(const p of [j.c,...j.ring])if(near(p[0],p[1])&&!points.some(q=>q.p===p))points.push({p,y:td.terrainAt(p[0],p[1])});
  }
  // Physics junctions are separate decoded arrays, exposed by data.js for this one-time repair.
  for(const j of td.physicsJunctions||[])for(const p of [j.c,...j.ring])if(near(p[0],p[1])&&!points.some(q=>q.p===p))points.push({p,y:td.terrainAt(p[0],p[1])});
  return ()=> {
    for(const s of samples) {
      const {r,i,x,z,dx,dz}=s,dl=td.terrainAt(x+dx,z+dz)-s.l,dr=td.terrainAt(x-dx,z-dz)-s.r0;
      if(Math.abs(dl)+Math.abs(dr)<1e-7)continue;
      r.y[i]+=(dl+dr)/2; r.c[i]+=(dl-dr)/(2*r.hw);
    }
    for(const {p,y}of points)p[2]+=td.terrainAt(p[0],p[1])-y;
  };
}
