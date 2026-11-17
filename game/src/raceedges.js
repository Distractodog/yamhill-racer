// Outside boundary of the joined route strips. At a hairpin or a widened junction, raw offsets can cross the
// road itself. Clip those internal portions against the other strips; rendering and collision share the result.
export function raceEdges(points) {
  const edges = [-1, 1].map(side => points.map(([x, z, hw], i) => {
    const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
    return [x + side * dz / len * hw, z - side * dx / len * hw];
  }));
  const grid = new Map(), cell = 24, strips = [];
  function cells(poly, fn) {
    const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
    for (let x = Math.floor(Math.min(...xs) / cell); x <= Math.floor(Math.max(...xs) / cell); x++)
      for (let z = Math.floor(Math.min(...zs) / cell); z <= Math.floor(Math.max(...zs) / cell); z++) fn(`${x},${z}`);
  }
  for (let i = 0; i < points.length - 1; i++) {
    const poly = [edges[0][i], edges[1][i], edges[1][i+1], edges[0][i+1]];
    strips.push(poly); cells(poly, key => { if (!grid.has(key)) grid.set(key, new Set()); grid.get(key).add(i); });
  }
  function inside(x, z, poly) {
    let hit = false;
    for (let i=0,j=poly.length-1; i<poly.length; j=i++) {
      const a=poly[i], b=poly[j];
      if ((a[1]>z)!==(b[1]>z) && x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0]) hit=!hit;
    }
    return hit;
  }
  const result = [];
  for (const edge of edges) for (let i=0; i<edge.length-1; i++) {
    const a=edge[i], b=edge[i+1], dx=b[0]-a[0], dz=b[1]-a[1];
    if (Math.hypot(dx,dz)<0.01) continue;
    const nearby = new Set(); cells([a,b], key => { for (const j of grid.get(key)||[]) if(j!==i) nearby.add(j); });
    const cuts=[0,1];
    for(const j of nearby) {
      const poly=strips[j];
      for(let k=0;k<4;k++) {
        const c=poly[k],d=poly[(k+1)%4],ex=d[0]-c[0],ez=d[1]-c[1],det=dx*ez-dz*ex;
        if(Math.abs(det)<1e-8)continue;
        const t=((c[0]-a[0])*ez-(c[1]-a[1])*ex)/det;
        const u=((c[0]-a[0])*dz-(c[1]-a[1])*dx)/det;
        if(t>1e-8&&t<1-1e-8&&u>=0&&u<=1)cuts.push(t);
      }
    }
    cuts.sort((a,b)=>a-b);
    for(let k=1;k<cuts.length;k++) {
      const lo=cuts[k-1],hi=cuts[k]; if(hi-lo<1e-8)continue;
      const mid=(lo+hi)/2,x=a[0]+dx*mid,z=a[1]+dz*mid;
      if([...nearby].some(j=>inside(x,z,strips[j])))continue;
      result.push({ax:a[0]+dx*lo,az:a[1]+dz*lo,bx:a[0]+dx*hi,bz:a[1]+dz*hi,index:i});
    }
  }
  return result;
}
