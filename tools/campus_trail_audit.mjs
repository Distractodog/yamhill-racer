// Audit every trail sample in the campus tile and its eight neighbours, without a renderer.
// node tools/campus_trail_audit.mjs --out /tmp/campus-trails.json
import fs from 'node:fs';
import { readTileData } from '../game/src/tilepack.js';
import { makeTileData } from '../game/src/data.js';
const assets = process.env.YR_ASSETS || 'game/assets';
const W = JSON.parse(fs.readFileSync(`${assets}/world.json`));
const outIndex=process.argv.indexOf('--out'),out=outIndex>=0?process.argv[outIndex+1]:null;
const report = { tiles: [], strips: [], issues: [], coverage: 'Every rendered trail strip in the campus tile and its eight neighbours; sample/edge geometry, not a visual driving approval.' };
for (const [tx,tz] of W.tiles.filter(([x,z]) => Math.abs(x)<=1 && Math.abs(z)<=1)) {
  const key = `${tx}_${tz}`;
  const data = await readTileData(async f => { const b=fs.readFileSync(`${assets}/tiles/${key}/${f}`); return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); },W.packed);
  const td = makeTileData(W,tx,tz,data);
  report.tiles.push(key);
  for (const r of td.renderRoads) {
    if(r.kind!=='trail') continue;
    const row={tile:key,strip:r.id,width:r.hw*2,samples:r.n,start:[r.x[0],r.z[0]],end:[r.x.at(-1),r.z.at(-1)],buried:0,floating:0,folds:0,maxGrade:0};
    for(let i=0;i<r.n;i++) {
      for(const side of [-1,0,1]) {
        const x=r.x[i]+r.lx[i]*r.hw*side,z=r.z[i]+r.lz[i]*r.hw*side,y=r.y[i]+r.c[i]*r.hw*side;
        const gap=y-td.terrainAt(x,z);
        if(-gap>row.buried){row.buried=-gap;row.buriedAt=[x,z];}
        if(gap>row.floating){row.floating=gap;row.floatingAt=[x,z];}
      }
      if(i===r.n-1)continue;
      const dx=r.x[i+1]-r.x[i],dz=r.z[i+1]-r.z[i],len=Math.hypot(dx,dz);
      const grade=Math.abs(r.y[i+1]-r.y[i])/Math.max(.001,len);
      if(grade>row.maxGrade){row.maxGrade=grade;row.gradeAt=[r.x[i],r.z[i]];}
      // A strip edge travelling backwards relative to its centreline is a folded offset ribbon.
      for(const s of [-1,1]) {
        const ex=dx+(r.lx[i+1]-r.lx[i])*r.hw*s,ez=dz+(r.lz[i+1]-r.lz[i])*r.hw*s;
        if(ex*dx+ez*dz < -1e-4){row.folds++;row.foldAt=[r.x[i],r.z[i]];}
      }
    }
    row.junctionGap=0;
    for(const i of [0,r.n-1]) {
      // Tile cuts connect to the neighbouring strip, not a local junction polygon.
      if(Math.min(Math.abs(r.x[i]-td.x0),Math.abs(r.x[i]-td.x0-2000),Math.abs(r.z[i]-td.z0),Math.abs(r.z[i]-td.z0-2000))<.03)continue;
      const rings=td.renderJunctions.filter(j=>Math.hypot(j.c[0]-r.x[i],j.c[1]-r.z[i])<40).flatMap(j=>j.ring);
      if(!rings.length){(row.unjoinedEnds||=[]).push([r.x[i],r.z[i]]);continue;}
      for(const side of [-1,1]) {
        const x=r.x[i]+r.lx[i]*r.hw*side,z=r.z[i]+r.lz[i]*r.hw*side;
        const d=Math.min(...rings.map(p=>Math.hypot(p[0]-x,p[1]-z)));
        if(d>row.junctionGap){row.junctionGap=d;row.junctionAt=[x,z];}
      }
    }
    if(process.argv.includes('--paths'))row.points=data.tile.paths[r.id]?.pts;
    report.strips.push(row);
    if(row.buried>.15||row.floating>.5||row.folds||row.maxGrade>.65||row.junctionGap>.5)report.issues.push(row);
  }
}
if(out)fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({tiles:report.tiles,strips:report.strips.length,issues:report.issues.length,worstBuried:[...report.strips].sort((a,b)=>b.buried-a.buried).slice(0,8),worstFolds:[...report.strips].sort((a,b)=>b.folds-a.folds).slice(0,8)},null,2));
