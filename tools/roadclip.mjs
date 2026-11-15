// Area-weighted terrain/road clipping probe. No historic ROADCLIP script was supplied.
// node tools/roadclip.mjs [assets] [report.json]
// Sample each <=1.5 m strip segment at its longitudinal midpoint, in <=1 m cross-road bands.
// Count only tile-core samples; weight by plan area. Includes asphalt/gravel/trails and widened lanes,
// excludes skirts, sidewalks and junction fans. Overlapping strips are counted separately.
// Report both any penetration (>1e-5 m) and visible penetration (>2 cm), plus worst locations.
import fs from 'node:fs';
import { makeTileData } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { roadEdge, triangleHeight } from '../game/src/ramps.js';
const assets = process.argv[2] || 'game/assets';
const W = JSON.parse(fs.readFileSync(`${assets}/world.json`));
const ab = f => { const b = fs.readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const area = (a,b,c) => Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
const totals = {}, worst = [];
for (const [tx,tz] of W.tiles) {
  const data = await readTileData(async f => ab(`${assets}/tiles/${tx}_${tz}/${f}`), W.packed);
  const td = makeTileData(W,tx,tz,data);
  for (const r of td.renderRoads) {
    const k = r.bridge ? 'bridge' : r.kind;
    const t = totals[k] ||= {samples:0, area:0, clippedArea:0, visibleArea:0, maxPenetration:0};
    for (let i=0;i<r.n-1;i++) {
      const A=roadEdge(r,i,1), B=roadEdge(r,i,-1), C=roadEdge(r,i+1,-1), D=roadEdge(r,i+1,1);
      const n=Math.max(1,Math.ceil(Math.max(Math.hypot(A[0]-B[0],A[1]-B[1]),Math.hypot(C[0]-D[0],C[1]-D[1]))));
      const weight=(area(A,B,C)+area(A,C,D))/n;
      for(let j=0;j<n;j++) {
        const f=(j+.5)/n, x=((A[0]+D[0])*(1-f)+(B[0]+C[0])*f)/2, z=((A[1]+D[1])*(1-f)+(B[1]+C[1])*f)/2;
        if(x<td.x0 || x>=td.x0+W.tile || z<td.z0 || z>=td.z0+W.tile)continue;
        const h=Math.max(triangleHeight(x,z,A,B,C),triangleHeight(x,z,A,C,D));
        if(!Number.isFinite(h))continue; // degenerate/self-folded road quad has no top here
        const penetration=td.terrainAt(x,z)-h;
        t.samples++; t.area+=weight;
        if(penetration>1e-5)t.clippedArea+=weight;
        if(penetration>.02)t.visibleArea+=weight;
        if(penetration>t.maxPenetration) {
          t.maxPenetration=penetration;
          worst.push({tile:`${tx}_${tz}`,kind:k,x,z,penetration});
          worst.sort((a,b)=>b.penetration-a.penetration); worst.length=Math.min(worst.length,20);
        }
      }
    }
  }
}
const total=Object.values(totals).reduce((a,t)=>{
  for(const k of ['samples','area','clippedArea','visibleArea'])a[k]=(a[k]||0)+t[k];return a;
},{});
for(const t of [...Object.values(totals),total]) {
  t.clippedPercent=100*t.clippedArea/t.area;t.visiblePercent=100*t.visibleArea/t.area;
}
const report={tiles:W.tiles.length,method:'Area-weighted midpoint samples, <=1.5 m along / <=1 m across; strip tops only; overlaps counted per strip',totals,total,worst};
console.log(JSON.stringify(report,null,2));
if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2)+'\n');
