// Progressive 2D map detail, independent of the 3D world's streaming radius.
// Only visible tile JSON is requested; heights, textures and tree data are never loaded here.
import { gunzip } from './tilepack.js';
import { CAMPUS, partPts } from './campus.js';
import { LANDMARKS } from './landmarks.js';
export const MAP_DETAIL_LIMITS = { tiles: 20, concurrent: 3, minPixelsPerMetre: .28 };
const MAJOR = /^(motorway|trunk|primary|secondary|tertiary)(:|$)/;
const NAMED_BUILDINGS = [...CAMPUS, ...LANDMARKS].map(b => ({ name: b.name, polygons: b.parts.map(partPts), x: b.floorAt[0], z: b.floorAt[1] }));
export function mapDetailLevel(ppm) { return ppm < .28 ? 0 : ppm < .7 ? 1 : ppm < 1.7 ? 2 : 3; }
export function mapVisibleTiles(bounds, tileSize, available, limit = MAP_DETAIL_LIMITS.tiles) {
  const [x0,z0,x1,z1]=bounds,cx=(x0+x1)/2,cz=(z0+z1)/2,out=[];
  for(let tz=Math.floor((z0+tileSize/2)/tileSize);tz<=Math.floor((z1+tileSize/2)/tileSize);tz++)for(let tx=Math.floor((x0+tileSize/2)/tileSize);tx<=Math.floor((x1+tileSize/2)/tileSize);tx++){
    const key=`${tx}_${tz}`;if(available.has(key))out.push({key,tx,tz,d:(tx*tileSize-cx)**2+(tz*tileSize-cz)**2});
  }
  return out.sort((a,b)=>a.d-b.d).slice(0,limit);
}
function boundsOf(points) { let x0=Infinity,z0=Infinity,x1=-Infinity,z1=-Infinity;for(const [x,z]of points){x0=Math.min(x0,x);z0=Math.min(z0,z);x1=Math.max(x1,x);z1=Math.max(z1,z);}return [x0,z0,x1,z1]; }
const intersects=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
// Douglas-Peucker retains bends and endpoints while avoiding thousands of nearly collinear 2 m samples.
export function simplifyMapLine(points,tolerance=1) {
  if(points.length<3)return points;
  const keep=new Uint8Array(points.length),stack=[[0,points.length-1]];keep[0]=keep[points.length-1]=1;
  while(stack.length){const[a,b]=stack.pop(),[ax,az]=points[a],[bx,bz]=points[b],dx=bx-ax,dz=bz-az,len=dx*dx+dz*dz;let max=tolerance*tolerance,index=-1;
    for(let i=a+1;i<b;i++){const[x,z]=points[i],u=len?Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/len)):0,d=(x-ax-u*dx)**2+(z-az-u*dz)**2;if(d>max){max=d;index=i;}}
    if(index>=0){keep[index]=1;stack.push([a,index],[index,b]);}
  }
  return points.filter((_,i)=>keep[i]);
}
export function prepareMapTile(raw) {
  const roads=(raw.paths||[]).filter(p=>p.pts?.length>1).map(p=>({kind:p.kind,major:MAJOR.test(p.cls||''),width:Math.max(1,Number(p.w)||4),name:typeof p.name==='string'?p.name:null,pts:simplifyMapLine(p.pts),fine:simplifyMapLine(p.pts,.15),bounds:boundsOf(p.pts)}));
  const buildings=(raw.buildings||[]).filter(b=>b.pts?.length>=3).map(b=>({pts:b.pts,bounds:boundsOf(b.pts),name:typeof b.name==='string'?b.name:null}));
  const junctions=(raw.junctions||[]).filter(j=>j.ring?.length>=3).map(j=>({kind:j.kind,pts:j.ring.map(p=>[p[0],p[1]]),bounds:boundsOf(j.ring)}));
  return {roads,buildings,junctions};
}
const trace=(ctx,points,close=false)=>{ctx.beginPath();for(let i=0;i<points.length;i++){const [x,z]=points[i];i?ctx.lineTo(x,z):ctx.moveTo(x,z);}if(close)ctx.closePath();};
export function createMapDetail(base='./assets/', { fetcher=globalThis.fetch, now=()=>performance.now() }={}) {
  let manifest=null,available=new Set(),revision=0,active=0,clock=0,disposed=false,wanted=[],lastView='',lastRequest='',nextRetryCheck=0,manifestError=false;
  const cache=new Map(),failures=new Map(),pending=new Map();
  const ready=fetcher(base+'world.json').then(r=>{if(!r.ok)throw new Error('Map manifest');return r.json();}).then(w=>{if(disposed)return;manifest=w;available=new Set(w.tiles.map(([x,z])=>`${x}_${z}`));revision++;lastView='';lastRequest='';}).catch(()=>{manifestError=true;revision++;});
  function trim(){while(cache.size>MAP_DETAIL_LIMITS.tiles){const protectedKeys=new Set(wanted.map(t=>t.key));const candidates=[...cache].filter(([k])=>!protectedKeys.has(k)).sort((a,b)=>a[1].used-b[1].used);const entry=candidates[0]||[...cache].sort((a,b)=>a[1].used-b[1].used)[0];cache.delete(entry[0]);}}
  function pump(){
    if(disposed||!manifest)return;
    for(const tile of wanted){if(active>=MAP_DETAIL_LIMITS.concurrent)break;if(cache.has(tile.key)||pending.has(tile.key)||(failures.get(tile.key)||0)>now())continue;
      const controller=new AbortController();pending.set(tile.key,controller);active++;
      const file=manifest.packed?'tile.json.gz':'tile.json';
      fetcher(`${base}tiles/${tile.key}/${file}`,{signal:controller.signal}).then(async r=>{if(!r.ok)throw new Error('Map detail');return manifest.packed?JSON.parse(new TextDecoder().decode(await gunzip(await r.arrayBuffer()))):r.json();})
        .then(raw=>{if(disposed)return;failures.delete(tile.key);cache.set(tile.key,{...prepareMapTile(raw),tx:tile.tx,tz:tile.tz,used:++clock});trim();revision++;})
        .catch(e=>{if(e.name!=='AbortError'){failures.set(tile.key,now()+30000);revision++;}})
        .finally(()=>{pending.delete(tile.key);active--;pump();});
    }
  }
  function update(bounds,ppm){
    if(disposed)return;
    const request=mapDetailLevel(ppm)+':'+bounds.join(',');
    if(request===lastRequest){if(now()>=nextRetryCheck){nextRetryCheck=now()+1000;pump();}return;}
    lastRequest=request;nextRetryCheck=now()+1000;
    const nextWanted=manifest&&mapDetailLevel(ppm)>0?mapVisibleTiles(bounds,manifest.tile||2000,available):[];
    const viewKey=mapDetailLevel(ppm)+':'+nextWanted.map(t=>t.key).join(',');
    if(viewKey!==lastView){lastView=viewKey;wanted=nextWanted;
      const keys=new Set(wanted.map(t=>t.key));for(const[k,c]of pending)if(!keys.has(k))c.abort();for(const t of wanted){const entry=cache.get(t.key);if(entry)entry.used=++clock;}
    }
    pump();
  }
  function draw(ctx,{bounds,ppm,d,map}){
    const level=mapDetailLevel(ppm/d);if(!level||!manifest)return;
    const tileSize=manifest.tile||2000,visible=mapVisibleTiles(bounds,tileSize,available),entries=visible.map(t=>cache.get(t.key)).filter(Boolean);
    ctx.save();
    // A calm vector land layer replaces the blurry raster only where detail has arrived.
    const alpha=Math.min(1,Math.max(0,(ppm/d-.28)/.25));
    for(const tile of entries){const [x,y]=map(tile.tx*tileSize-tileSize/2,tile.tz*tileSize-tileSize/2);ctx.fillStyle=`rgba(215,226,207,${alpha*.97})`;ctx.fillRect(x,y,tileSize*ppm+.5,tileSize*ppm+.5);}
    // World coordinates retain a single exact transform shared by pins and the raster.
    const [ox,oy]=map(0,0);ctx.translate(ox,oy);ctx.scale(ppm,ppm);ctx.lineJoin=ctx.lineCap='round';
    const roads=entries.flatMap(t=>t.roads).filter(r=>intersects(r.bounds,bounds)&&(level>1||r.kind!=='trail'));
    for(const r of roads){trace(ctx,level>=3?r.fine:r.pts);ctx.setLineDash(r.kind==='trail'?[3/ppm*d,3/ppm*d]:[]);ctx.strokeStyle=r.kind==='trail'?'#7b9670':r.major?'#c1aa6a':'#b0b5a9';ctx.lineWidth=Math.max(r.width,(r.major?3:2)*d/ppm)+2*d/ppm;ctx.stroke();}
    for(const r of roads){trace(ctx,level>=3?r.fine:r.pts);ctx.setLineDash(r.kind==='trail'?[3/ppm*d,3/ppm*d]:[]);ctx.strokeStyle=r.kind==='trail'?'#f0ead2':r.kind==='gravel'?'#f0e8d4':r.major?'#ffe9a3':'#fcfcf3';ctx.lineWidth=Math.max(r.width,(r.major?3:2)*d/ppm);ctx.stroke();}
    ctx.setLineDash([]);
    for(const tile of entries)for(const j of tile.junctions){if(!intersects(j.bounds,bounds)||j.kind==='trail')continue;trace(ctx,j.pts,true);ctx.fillStyle=j.kind==='gravel'?'#f0e8d4':'#fcfcf3';ctx.fill();}
    if(level>=2){for(const tile of entries)for(const b of tile.buildings){if(!intersects(b.bounds,bounds))continue;trace(ctx,b.pts,true);ctx.fillStyle='#d2cabe';ctx.strokeStyle='#a99f91';ctx.lineWidth=.8*d/ppm;ctx.fill();ctx.stroke();}
      for(const b of NAMED_BUILDINGS){if(!intersects([b.x-130,b.z-130,b.x+130,b.z+130],bounds))continue;for(const polygon of b.polygons){trace(ctx,polygon,true);ctx.fillStyle='#c6bba9';ctx.strokeStyle='#8c8275';ctx.lineWidth=1*d/ppm;ctx.fill();ctx.stroke();}}
    }
    ctx.restore();
    if(level>=2){
      const occupied=[];
      const text=(name,x,z,size=11)=>{const [a,b]=map(x,z);if(a<20*d||b<20*d||a>ctx.canvas.width-20*d||b>ctx.canvas.height-20*d)return;ctx.font=`600 ${size*d}px system-ui,sans-serif`;const w=ctx.measureText(name).width+12*d,h=18*d,box=[a-w/2,b-h/2,a+w/2,b+h/2];if(occupied.some(o=>intersects(o,box)))return;occupied.push(box);ctx.textAlign='center';ctx.textBaseline='middle';ctx.lineWidth=3*d;ctx.strokeStyle='#f7f8efe8';ctx.strokeText(name,a,b);ctx.fillStyle='#3d4d42';ctx.fillText(name,a,b);};
      for(const b of NAMED_BUILDINGS)if(intersects([b.x,b.z,b.x,b.z],bounds))text(b.name,b.x,b.z,level===3?12:10);
      if(level>=3)for(const tile of entries){for(const b of tile.buildings)if(b.name&&intersects(b.bounds,bounds))text(b.name,(b.bounds[0]+b.bounds[2])/2,(b.bounds[1]+b.bounds[3])/2);for(const r of tile.roads)if(r.name&&intersects(r.bounds,bounds)){const p=r.pts[Math.floor(r.pts.length/2)];text(r.name,...p);}}
    }
  }
  return {ready,update,draw,get revision(){return revision;},get stats(){return {cached:cache.size,pending:pending.size,wanted:wanted.length,failed:wanted.filter(t=>failures.has(t.key)).length,manifestError};},
    dispose(){disposed=true;for(const c of pending.values())c.abort();cache.clear();wanted=[];},
  };
}
