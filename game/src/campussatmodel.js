// Extra athletics surfaces merged into the track's two existing draw calls.
import { APRON, COURTS, courtXZ } from './campussat.js';
const RED=[.59,.25,.22],GREEN=[.28,.46,.36],WHITE=[.91,.92,.88];
export function addSatelliteSurfaces(base,top,ground) {
  const patch=(quad,col,lift=.045)=> {
    const [a,b,c,d]=quad,at=(s,t)=> {
      const x=(a[0]*(1-s)+b[0]*s)*(1-t)+(d[0]*(1-s)+c[0]*s)*t;
      const z=(a[1]*(1-s)+b[1]*s)*(1-t)+(d[1]*(1-s)+c[1]*s)*t;
      return [x,ground(x,z)+lift,z];
    };
    const n=Math.ceil(Math.max(Math.hypot(a[0]-b[0],a[1]-b[1]),Math.hypot(a[0]-d[0],a[1]-d[1]))/2);
    for(let i=0;i<n;i++)for(let j=0;j<n;j++)base.quad(at(i/n,j/n),at((i+1)/n,j/n),at((i+1)/n,(j+1)/n),at(i/n,(j+1)/n),col);
  };
  patch(APRON,[.65,.66,.63]);
  const rectangle=(u0,u1,v0,v1,col,lift)=>patch([[u0,v0],[u1,v0],[u1,v1],[u0,v1]].map(p=>courtXZ(...p)),col,lift);
  rectangle(-COURTS.L/2,COURTS.L/2,-COURTS.W/2,COURTS.W/2,RED,.045);
  const line=(u0,u1,v0,v1)=> {
    const p=(u,v)=>{const [x,z]=courtXZ(u,v);return [x,ground(x,z)+.075,z];};
    top.quad(p(u0,v0),p(u1,v0),p(u1,v1),p(u0,v1),WHITE);
  };
  for(const u of [-17,17])for(const v of [-8.4,8.4]) {
    rectangle(u-11.89,u+11.89,v-5.485,v+5.485,GREEN,.06);
    for(const e of [-5.485,-4.115,4.115,5.485])line(u-11.89,u+11.89,v+e-.04,v+e+.04);
    for(const e of [-11.89,11.89])line(u+e-.04,u+e+.04,v-5.485,v+5.485);
    for(const e of [-6.4,6.4])line(u+e-.04,u+e+.04,v-4.115,v+4.115);
    line(u-6.4,u+6.4,v-.04,v+.04);
    const p=(vv,h)=>{const [x,z]=courtXZ(u,v+vv);return [x,ground(x,z)+h,z];};
    // Dark low-poly net with a bright tape; opaque, no extra material/program.
    top.quad(p(-6,.1),p(6,.1),p(6,1.05),p(-6,1.05),[.20,.24,.22]);
    top.quad(p(-6,1.05),p(6,1.05),p(6,1.1),p(-6,1.1),WHITE);
  }
}
