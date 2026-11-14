// Pure road graph queries. Zero-width edges join tile seams; junction links are selectable road surfaces.
export function project(point, a, b) {
  const dx = b[0]-a[0], dz = b[1]-a[1], l2 = dx*dx+dz*dz;
  const t = l2 ? Math.max(0, Math.min(1, ((point[0]-a[0])*dx+(point[1]-a[1])*dz)/l2)) : 0;
  const p = [a[0]+dx*t, a[1]+dz*t];
  return { point: p, t, distance: Math.hypot(point[0]-p[0], point[1]-p[1]) };
}
export function createRoadGraph({ nodes, edges }) {
  const adj = nodes.map(() => []), bins = new Map(), CELL = 100;
  edges.forEach(([a,b,w], id) => {
    const length = Math.hypot(nodes[a][0]-nodes[b][0], nodes[a][1]-nodes[b][1]);
    adj[a].push([b,length]); adj[b].push([a,length]);
    if (!w) return;
    for (let x=Math.floor(Math.min(nodes[a][0],nodes[b][0])/CELL); x<=Math.floor(Math.max(nodes[a][0],nodes[b][0])/CELL); x++)
      for (let z=Math.floor(Math.min(nodes[a][1],nodes[b][1])/CELL); z<=Math.floor(Math.max(nodes[a][1],nodes[b][1])/CELL); z++) {
        const key = `${x},${z}`;
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push(id);
      }
  });
  function snap(x,z,tolerance=0,height=null) {
    let best = null;
    const ids = new Set();
    for (let bx=Math.floor(x/CELL)-1; bx<=Math.floor(x/CELL)+1; bx++)
      for (let bz=Math.floor(z/CELL)-1; bz<=Math.floor(z/CELL)+1; bz++)
        for (const id of bins.get(`${bx},${bz}`) || []) ids.add(id);
    for (const id of ids) {
      const [a,b,w] = edges[id], p = project([x,z],nodes[a],nodes[b]);
      if (height !== null && Number.isFinite(nodes[a][2]) && Math.abs(height-(nodes[a][2]+p.t*(nodes[b][2]-nodes[a][2]))) > 5) continue;
      if (p.distance <= w/2+tolerance && (!best || p.distance < best.distance)) best = { ...p, id, a, b };
    }
    return best;
  }
  function route(start,end) {
    // Virtual endpoints connect to BOTH ends of their containing segments.
    const distance = new Float64Array(nodes.length).fill(Infinity), prev = new Int32Array(nodes.length).fill(-1);
    const heap = [];
    function push(item) {
      let i=heap.length; heap.push(item);
      while(i) { const p=(i-1)>>1; if(heap[p][0]<=item[0]) break; heap[i]=heap[p]; i=p; } heap[i]=item;
    }
    function pop() {
      const top=heap[0], last=heap.pop();
      if(heap.length) { let i=0; while(i*2+1<heap.length) { let c=i*2+1; if(c+1<heap.length && heap[c+1][0]<heap[c][0]) c++; if(heap[c][0]>=last[0]) break; heap[i]=heap[c]; i=c; } heap[i]=last; }
      return top;
    }
    const dist = (a,b) => Math.hypot(a[0]-b[0],a[1]-b[1]);
    for (const n of [start.a,start.b]) { distance[n]=dist(start.point,nodes[n]); push([distance[n],n]); }
    let best = start.id===end.id ? dist(start.point,end.point) : Infinity, finish=-1;
    while(heap.length) {
      const [d,n]=pop(); if(d>best) break; if(d!==distance[n]) continue;
      if(n===end.a || n===end.b) { const total=d+dist(nodes[n],end.point); if(total<best) { best=total; finish=n; } }
      for(const [m,len] of adj[n]) if(d+len<distance[m]) { distance[m]=d+len; prev[m]=n; push([d+len,m]); }
    }
    if(!Number.isFinite(best)) return null;
    const points=[end.point];
    for(let n=finish;n!==-1;n=prev[n]) points.push(nodes[n].slice(0,2));
    points.push(start.point); points.reverse();
    return { points: points.filter((p,i)=>!i || dist(p,points[i-1])>0.01), distance: best };
  }
  return { snap, route };
}

export function routeProgress(points,x,z) {
  let best=null, remaining=0;
  for(let i=points.length-2;i>=0;i--) {
    const p=project([x,z],points[i],points[i+1]);
    const tail=Math.hypot(points[i+1][0]-p.point[0],points[i+1][1]-p.point[1]);
    if(!best || p.distance<best.distance) best={...p,index:i,remaining:remaining+tail};
    remaining+=Math.hypot(points[i+1][0]-points[i][0],points[i+1][1]-points[i][1]);
  }
  return best;
}
