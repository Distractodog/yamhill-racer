import { roadHalfWidth, roadEdge, triangleHeight } from './ramps.js';
// Ramp mesh helpers. All work happens at tile construction, never in the frame loop.
// Arc lengths refer to the complete prepared strip, including when a road batch slices it.
const arcs = new WeakMap();
export function roadArc(r) {
  if (r.s) return r.s;
  if (arcs.has(r)) return arcs.get(r);
  const s = [0];
  for (let i = 1; i < r.n; i++) s.push(s[i - 1] + Math.hypot(r.x[i] - r.x[i - 1], r.z[i] - r.z[i - 1]));
  arcs.set(r, s); return s;
}
export function laneWidth(r, s, side, wedgeOnly = false) {
  let w = 0;
  for (const [sd, a, b, wa, wb] of r.widen || []) {
    if (sd !== side || s < a - 1e-5 || s > b + 1e-5 || (wedgeOnly && wa === wb)) continue;
    w = Math.max(w, wa + (wb - wa) * Math.max(0, Math.min(1, (s - a) / (b - a))));
  }
  return w;
}
export function roadPoint(r, arc, s, o, lift = 0) {
  let lo = 0, hi = r.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arc[m] <= s) lo = m; else hi = m; }
  const t = Math.max(0, Math.min(1, (s - arc[lo]) / Math.max(1e-9, arc[hi] - arc[lo])));
  const f = a => a[lo] + (a[hi] - a[lo]) * t;
  const x=f(r.x)+f(r.lx)*o, z=f(r.z)+f(r.lz)*o;
  let y=f(r.y)+f(r.c)*o;
  if (r.widen) {
    const A=roadEdge(r,lo,1), B=roadEdge(r,lo,-1), C=roadEdge(r,hi,-1), D=roadEdge(r,hi,1);
    const h=Math.max(triangleHeight(x,z,A,B,C),triangleHeight(x,z,A,C,D)); if(Number.isFinite(h)) y=h;
  }
  return [x,y+lift,z];
}
export function addQuad(P, C, q, rgb) {
  const [a, b, c, d] = q;
  const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  for (const p of up >= 0 ? [a, b, c, a, c, d] : [a, d, c, a, c, b]) { P.push(...p); C.push(...rgb); }
}

const contexts = new WeakMap();
function context(D) {
  if (contexts.has(D)) return contexts.get(D);
  const lanes = [], grid = new Map(), cell = 30;
  for (const r of D.renderRoads || []) {
    if (r.kind !== 'asphalt') continue;
    const arc = roadArc(r), pad = r.hw + Math.max(0, ...(r.widen || []).flatMap(q => q.slice(3))) + 1;
    for (let i = 0; i < r.n - 1; i++) {
      const seg = { r, arc, i };
      for (let x = Math.floor((Math.min(r.x[i], r.x[i + 1]) - pad) / cell); x <= Math.floor((Math.max(r.x[i], r.x[i + 1]) + pad) / cell); x++)
        for (let z = Math.floor((Math.min(r.z[i], r.z[i + 1]) - pad) / cell); z <= Math.floor((Math.max(r.z[i], r.z[i + 1]) + pad) / cell); z++) {
          const k = x + ',' + z; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(seg);
        }
      const ranges = (r.widen || []).filter(([, a, b, wa, wb]) => wa === wb && arc[i + 1] >= a && arc[i] <= b);
      if (ranges.length) lanes.push({ ...seg, ranges });
    }
  }
  const noses = [];
  for (const r of D.renderRoads || []) for (const q of r.widen || []) {
    const [side,a,b,wa,wb] = q; if (wa !== wb) continue;
    const joint = (r.widen || []).find(w => w[0]===side && w[3]!==w[4] && (Math.abs(w[1]-a)<.1 || Math.abs(w[2]-a)<.1 || Math.abs(w[1]-b)<.1 || Math.abs(w[2]-b)<.1));
    if (!joint) continue;
    const atA = Math.abs(joint[1]-a)<.1 || Math.abs(joint[2]-a)<.1;
    const s = atA ? b : a, dir = atA ? 1 : -1, tip = roadPoint(r,roadArc(r),s,side*r.hw,.02);
    const outerTip=roadPoint(r,roadArc(r),s,side*(r.hw+wa-.675),.02);
    const nose = {r,s,side,dir,tip,outerTip}; let best = Infinity;
    for (const rr of D.renderRoads || []) {
      if (!rr.osm?.includes('_link')) continue;
      const arc = roadArc(rr);
      for (let i=0;i<rr.n-1;i++) {
        const dx=rr.x[i+1]-rr.x[i], dz=rr.z[i+1]-rr.z[i], L=Math.hypot(dx,dz);
        const t=Math.max(0,Math.min(1,((tip[0]-rr.x[i])*dx+(tip[2]-rr.z[i])*dz)/(L*L)));
        const off=((tip[0]-rr.x[i])*dz-(tip[2]-rr.z[i])*dx)/L;
        const d=Math.hypot(tip[0]-rr.x[i]-t*dx,tip[2]-rr.z[i]-t*dz);
        const score=Math.abs(d-rr.hw); if(score>=best || Math.abs(tip[1]-rr.y[i])>2) continue;
        best=score; nose.ramp={r:rr,s:arc[i]+t*L,side:Math.sign(off),dir:1};
        const next=roadPoint(r,roadArc(r),Math.max(0,Math.min(roadArc(r).at(-1),s+dir)),0);
        const here=roadPoint(r,roadArc(r),s,0);
        nose.ramp.dir=Math.sign(dx*(next[0]-here[0])+dz*(next[2]-here[2])) || 1;
      }
    }
    noses.push(nose);
  }
  const out = { lanes, grid, noses }; contexts.set(D, out); return out;
}
// Where paving overlaps, keep paint on its outer boundary rather than through another lane.
export function rampNoses(D) { return context(D).noses; }
function coveredEdge(D, r, p) {
  for (const { r: other, arc, i } of context(D).grid.get(Math.floor(p[0] / 30) + ',' + Math.floor(p[2] / 30)) || []) {
    if (other === r || (!r.osm?.includes('_link') && other.osm?.includes('_link'))) continue;
    const dx = other.x[i + 1] - other.x[i], dz = other.z[i + 1] - other.z[i], L2 = dx * dx + dz * dz;
    const t = ((p[0] - other.x[i]) * dx + (p[2] - other.z[i]) * dz) / L2;
    if (t < 0 || t > 1) continue;
    const off = ((p[0] - other.x[i]) * dz - (p[2] - other.z[i]) * dx) / Math.sqrt(L2);
    if (Math.abs(p[1] - other.y[i] - other.c[i] * off) > 2) continue;
    const extra = other.widen ? laneWidth(other, arc[i] + t * Math.sqrt(L2), Math.sign(off)) : 0;
    if (Math.abs(off) < other.hw + extra + .5) return true;
  }
  return false;
}
// Both ramp edge lines begin at the gore nose. Before that point the main road draws the outer edge;
// its dashed lane separator replaces the ramp's inner edge. Test the ramp centre, not each paint edge.
function besideLane(D, p) {
  for (const { r, arc, i, ranges } of context(D).lanes) {
    const dx = r.x[i + 1] - r.x[i], dz = r.z[i + 1] - r.z[i], L2 = dx * dx + dz * dz;
    const t = ((p[0] - r.x[i]) * dx + (p[2] - r.z[i]) * dz) / L2;
    if (t < 0 || t > 1) continue;
    const off = ((p[0] - r.x[i]) * dz - (p[2] - r.z[i]) * dx) / Math.sqrt(L2), s = arc[i] + t * Math.sqrt(L2);
    if (Math.abs(p[1] - (r.y[i] + r.c[i] * off)) > 2) continue;
    if (ranges.some(([side, a, b, w]) => s >= a && s <= b && off * side > r.hw && off * side < r.hw + w + 0.2)) return true;
  }
  return false;
}

// A single full-width quad per physics segment, with exactly the physics diagonal.
// Widened roads retain every sample in both LODs, including the taper boundary samples from prepRoad.
export function laneWedges(r, a, b, far, P, C, asphalt) {
  for (let i = a; i < b; i++) {
    const v = (i, side) => { const [x,z,y] = roadEdge(r,i,side); return [x,y,z]; };
    addQuad(P,C,[v(i,1),v(i,-1),v(i+1,-1),v(i+1,1)],asphalt);
  }
}

export function rampStripMarks(D, r, a, b, P, C, white, edges = () => true) {
  const arc = roadArc(r), link = r.osm?.split(':')[0].endsWith('_link');
  const quad = (s, t, o0, o1, p0 = o0, p1 = o1) => addQuad(P, C,
    [roadPoint(r, arc, s, o0, .02), roadPoint(r, arc, s, o1, .02),
      roadPoint(r, arc, t, p1, .02), roadPoint(r, arc, t, p0, .02)], white);
  // Split at lane-range boundaries and 1 m dash boundaries as well as the original samples.
  const cuts = new Set(arc.slice(a, b + 1));
  for (const [, s, t] of r.widen || []) for (const q of [s, t]) if (q > arc[a] && q < arc[b]) cuts.add(q);
  for (let s = Math.ceil(arc[a]); s < arc[b]; s++) cuts.add(s);
  const noses = context(D).noses.flatMap(n => n.r===r ? [{...n,main:true}] : n.ramp?.r===r ? [{...n.ramp,tip:n.tip,outerTip:n.outerTip,main:false}] : []);
  for (const n of noses) for (const d of [-6,0,6,18]) { const q=n.s+n.dir*d; if(q>arc[a]&&q<arc[b]) cuts.add(q); }
  const edge = (s, side, w, inner=false) => {
    let centre=side*(r.hw+w-.675), width=.35, p=roadPoint(r,arc,s,centre,.02);
    for(const n of noses) {
      const d=(s-n.s)*n.dir;
      if(n.side!==side) {
        if(!n.main && d>=0 && d<=6) {
          const atNose=roadPoint(r,arc,n.s,side*(r.hw-.675),.02);
          p=p.map((v,k)=>v+(n.outerTip[k]-atNose[k])*(1-d/6));
        }
        continue;
      }
      if(d < (n.main && inner ? -6 : 0) || d>18 || (n.main && w>0 && !inner))continue;
      const t=Math.min(1,Math.abs(d)/6), normal=roadPoint(r,arc,s,centre,.02);
      const boundary=roadPoint(r,arc,s,side*r.hw,.02), noseBoundary=roadPoint(r,arc,n.s,side*r.hw,.02);
      p=normal.map((v,k)=>v*t+(boundary[k]+n.tip[k]-noseBoundary[k])*(1-t));
      width=.35*Math.min(1,Math.abs(d)/18);
    }
    const normal=roadPoint(r,arc,s,centre+side*width/2,.02), base=roadPoint(r,arc,s,centre,.02);
    const delta=normal.map((v,k)=>v-base[k]);
    return [p.map((v,k)=>v+delta[k]),p.map((v,k)=>v-delta[k])];
  };
  const solid = (s,t,side,wa,wb,inner=false) => {const A=edge(s,side,wa,inner),B=edge(t,side,wb,inner);addQuad(P,C,[A[0],A[1],B[1],B[0]],white);};
  const folded = [];
  for (let i=a;i<b;i++) for(const side of [1,-1]) {
    const A=roadPoint(r,arc,arc[i],side*(r.hw+laneWidth(r,arc[i],side)-.675));
    const B=roadPoint(r,arc,arc[i+1],side*(r.hw+laneWidth(r,arc[i+1],side)-.675));
    if((B[0]-A[0])*(r.x[i+1]-r.x[i])+(B[2]-A[2])*(r.z[i+1]-r.z[i])<0) folded.push([side,arc[i]-2,arc[i+1]+2]);
  }
  const ss = [...cuts].sort((x, y) => x - y);
  for (let i = 0; i < ss.length - 1; i++) {
    const s = ss[i], t = ss[i + 1], mid = (s + t) / 2;
    const centre = roadPoint(r, arc, mid, 0);
    if (!edges(centre[0],centre[2])) continue;
    if (link && besideLane(D, roadPoint(r, arc, mid, 0)) && !noses.some(n=>!n.main && (mid-n.s)*n.dir>=0 && (mid-n.s)*n.dir<18)) continue;
    for (const side of [1, -1]) {
      if(folded.some(([sd,a,b])=>sd===side && mid>=a && mid<=b) && !noses.some(n=>(n.side===side || !n.main) && Math.abs(mid-n.s)<18))continue;
      const w = laneWidth(r, mid, side);
      // At the end of the full lane the main edge resumes beside the gore; the ramp takes over its outer edge.
      const wa = w > 0 ? laneWidth(r, s, side) : 0, wb = w > 0 ? laneWidth(r, t, side) : 0;
      const nearNose = noses.some(n=>(n.side===side || !n.main) && Math.abs(mid-n.s)<18);
      if (nearNose || ![s, mid, t].some(u => coveredEdge(D, r, roadPoint(r, arc, u, side * (r.hw + laneWidth(r, u, side) - .675))))) solid(s,t,side,wa,wb);
      const incoming = noses.some(n=>n.main && n.side===side && (mid-n.s)*n.dir<0 && (mid-n.s)*n.dir>=-6);
      if(incoming && w>0) solid(s,t,side,0,0,true);
      if (w > 1.4 && !incoming && Math.floor(mid) % 4 === 0) quad(s, t, side * (r.hw - .15), side * (r.hw + .15));
    }
  }
}

// The baker writes each gore as main-edge samples followed by reversed ramp-edge samples. Consecutive
// pieces share cross edges. The road strokes own the V; this drawer adds only interior chevrons.
export function goreMarks(j, P, C, white) {
  const R = j.ring, n = R.length, m = Math.ceil(n / 2), rows = [];
  for (let i = 0; i < m; i++) {
    const a = R[i], b = n % 2 && i === 0 ? a : R[n - 1 - i + (n % 2)];
    rows.push([[a[0], a[2] + .025, a[1]], [b[0], b[2] + .025, b[1]]]);
  }
  const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
  const width = row => Math.hypot(row[1][0] - row[0][0], row[1][2] - row[0][2]);
  const inset = (row, d) => mix(row[0], row[1], Math.min(.5, d / Math.max(1e-6, width(row))));
  // The continuous main-edge / ramp-inner-edge strokes form the V at their shared nose.
  // Drawing a second V inside the gore would leave a gap to those strokes and double the paint.
  // Chevrons stay well inside the V formed by the road strokes. Narrow gores need no additional paint.
  let dist = 0, last = -6;
  for (let i = 1; i < rows.length - 1; i++) {
    dist += Math.hypot(rows[i][0][0] - rows[i - 1][0][0], rows[i][0][2] - rows[i - 1][0][2]);
    if (dist - last < 6 || width(rows[i]) < 2.8 || width(rows[i - 1]) < 2) continue;
    const tip = mix(...rows[i - 1], .5), A = inset(rows[i], .9), B = inset([...rows[i]].reverse(), .9);
    // The two arms share a miter edge at the apex, with no overlapping paint.
    const centre = mix(...rows[i], .5), L = Math.hypot(centre[0] - tip[0], centre[2] - tip[2]);
    const shift = p => [p[0] + (centre[0] - tip[0]) / L * .25, p[1], p[2] + (centre[2] - tip[2]) / L * .25];
    const inner = shift(tip);
    addQuad(P, C, [A, shift(A), inner, tip], white);
    addQuad(P, C, [tip, inner, shift(B), B], white); last = dist;
  }
}
