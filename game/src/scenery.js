// Small local details are built only for loaded tiles and culled at 650 m.
// Store names are fictional decoration; town names and centres follow the game map.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
export const SCENERY_TOWNS = [
  { name: 'Delphian', x: -560, z: 60, color: '#315c45', subtitle: 'THE HILLTOP' },
  { name: 'Willamina', x: -3640, z: 3330, color: '#a46540', subtitle: 'TIMBER COUNTRY' },
  { name: 'Sheridan', x: 3800, z: 1400, color: '#467b84', subtitle: 'RIVER & VALLEY' },
  { name: 'Bellevue', x: 11860, z: -2110, color: '#725d88', subtitle: 'ROLLING HILLS' },
  { name: 'McMinnville', x: 19100, z: -11000, color: '#9a4f51', subtitle: 'EXPLORE DOWNTOWN' },
  { name: 'Amity', x: 18620, z: -560, color: '#87664c', subtitle: 'VALLEY ROADS' },
  { name: 'Ballston', x: 13430, z: 4790, color: '#57794f', subtitle: 'COUNTRY MILES' },
  { name: 'Perrydale', x: 13830, z: 7900, color: '#82754a', subtitle: 'OPEN COUNTRY' },
  { name: 'Whiteson', x: 19090, z: -4680, color: '#586e85', subtitle: 'TAKE THE LONG WAY' },
];
const SHOPS = ['Valley Cycle Works', 'Trailhead Coffee', 'Northwest General Store', 'Riverbend Market'];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function painted(g, hex) {
  if (g.index) { const old = g; g = old.toNonIndexed(); old.dispose(); }
  const c = new THREE.Color(hex), colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) c.toArray(colors, i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3)); g.deleteAttribute('uv'); return g;
}
function addBox(parts, x, y, z, w, h, d, color, yaw = 0) {
  const g = new THREE.BoxGeometry(w, h, d); g.rotateY(yaw); g.translate(x, y, z); parts.push(painted(g, color));
}
function merge(parts) { if (!parts.length) return null; const g = mergeGeometries(parts); parts.forEach(p => p.dispose()); return g; }
// Closest road sample with a safe shoulder offset. Restrict to this tile's interior.
export function sceneryRoadSpot(td, town) {
  let best = null, distance = Infinity;
  for (const road of td.renderRoads || []) {
    if (!road.n || road.kind === 'trail') continue;
    for (let i = 1; i < road.n - 1; i += 12) {
      const x = road.x[i], z = road.z[i], d = Math.hypot(x - town.x, z - town.z);
      if (d >= distance || d > 550) continue;
      const dx = road.x[i + 1] - road.x[i - 1], dz = road.z[i + 1] - road.z[i - 1], len = Math.hypot(dx, dz);
      if (len < .01) continue;
      const off = (road.hw || 7) + 5, sx = x + dz / len * off, sz = z - dx / len * off;
      if (sx < td.x0 + 12 || sx > td.x0 + 1988 || sz < td.z0 + 12 || sz > td.z0 + 1988) continue;
      if ((td.buildings || []).some(b => b.pts && pointInPolygon(sx, sz, b.pts))) continue;
      best = { x: sx, z: sz, yaw: Math.atan2(-dz, dx) }; distance = d;
    }
  }
  return best;
}
function pointInPolygon(x, z, pts) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [a,b] = pts[i], [d,e] = pts[j]; if ((b > z) !== (e > z) && x < (d-a)*(z-b)/(e-b)+a) c = !c; }
  return c;
}
function plaqueTexture(town, text, subtitle, mural = false) {
  // Tests can build the geometry without a DOM; actual browser always has canvas.
  if (!globalThis.document) return null;
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = mural ? 256 : 192;
  const ctx = canvas.getContext('2d'); if (!ctx) return null;
  ctx.fillStyle = town.color; ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (mural) {
    ctx.fillStyle = '#efc675'; ctx.beginPath(); ctx.arc(390, 70, 38, 0, Math.PI*2); ctx.fill();
    for (let n=0;n<3;n++) { ctx.fillStyle=['#557b65','#385b55','#294846'][n]; ctx.beginPath();ctx.moveTo(0,256);for(let x=0;x<=512;x+=16)ctx.lineTo(x,100+n*32+Math.sin(x/75+n)*30);ctx.lineTo(512,256);ctx.fill(); }
  }
  ctx.strokeStyle = '#f2e8ce'; ctx.lineWidth = 5; ctx.strokeRect(9,9,494,canvas.height-18);
  ctx.fillStyle = '#fff5dc'; ctx.textAlign = 'center'; ctx.font = `700 ${text.length > 17 ? 29 : 40}px system-ui, sans-serif`;
  ctx.fillText(text,256,mural?202:92,470); ctx.font='600 17px system-ui, sans-serif';ctx.fillText(subtitle,256,mural?233:133,470);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace=THREE.SRGBColorSpace; return texture;
}
export function createTileScenery(td) {
  const group = new THREE.Group(); group.name = 'local-scenery';
  const materials = [], textures = [], sites = [], animated = [], litWindows = [];
  const baseMat = new THREE.MeshLambertMaterial({vertexColors:true,flatShading:true}); materials.push(baseMat);
  const windowMat = new THREE.MeshBasicMaterial({color:'#ffd28b',transparent:true,opacity:0,depthWrite:false}); materials.push(windowMat);

  function plaque(parent,town,text,subtitle,w,h,y,z=0,mural=false) {
    const tex=plaqueTexture(town,text,subtitle,mural);if(tex)textures.push(tex);
    const mat=new THREE.MeshLambertMaterial({map:tex,color:tex?'#ffffff':town.color,side:THREE.DoubleSide});materials.push(mat);
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),mat);mesh.position.set(0,y,z);parent.add(mesh);return mesh;
  }
  const ownTowns=SCENERY_TOWNS.filter(t=>t.x>=td.x0&&t.x<td.x0+2000&&t.z>=td.z0&&t.z<td.z0+2000);
  for (const town of ownTowns) {
    const spot=sceneryRoadSpot(td,town);if(!spot)continue;
    const site=new THREE.Group();site.position.set(spot.x,td.terrainAt(spot.x,spot.z),spot.z);site.rotation.y=spot.yaw;group.add(site);sites.push(site);
    const parts=[];for(const x of [-2.4,2.4])addBox(parts,x,1.9,0,.18,3.8,.18,'#5c4938');addBox(parts,0,3.1,0,6,2.3,.2,town.color);
    // Short roadside fence keeps the entrance readable, set back beyond the road edge.
    for(const side of [-1,1])for(let i=0;i<4;i++){const x=side*(4+i*2.5);addBox(parts,x,.65,0,.12,1.3,.12,'#a59372');if(i<3)for(const y of [.45,1])addBox(parts,x+side*1.25,y,0,2.5,.1,.1,'#b6a17c');}
    addBox(parts,4,3.5,.6,.1,7,.1,'#b9c3c0');
    const mesh=new THREE.Mesh(merge(parts),baseMat);site.add(mesh);mesh.receiveShadow=true;
    plaque(site,town,town.name,town.subtitle,5.7,2,3.1,.12);
    const flagGeo=new THREE.PlaneGeometry(2.4,1.15,8,2);flagGeo.translate(1.2,0,0);
    const flagMat=new THREE.MeshLambertMaterial({color:town.color,side:THREE.DoubleSide});materials.push(flagMat);
    const flag=new THREE.Mesh(flagGeo,flagMat);flag.position.set(4,6.1,.6);site.add(flag);animated.push({kind:'flag',mesh:flag,site});
    // A tiny flock gives the sky life; no birds are simulated or collide with vehicles.
    const birdParts=[];for(let n=0;n<5;n++){addBox(birdParts,(n-2)*4,Math.abs(n-2)*.7,Math.abs(n-2)*4,1.9,.08,.28,'#3c4442',n%2?.15:-.15);}
    const birds=new THREE.Mesh(merge(birdParts),baseMat);birds.position.set(0,55,0);site.add(birds);animated.push({kind:'birds',mesh:birds,site,phase:town.x*.003});
    const buildings=(td.buildings||[]).filter(b=>!b.campusPart&&!b.landmarkPart&&b.pts?.length>=3).map(b=>({b,d:Math.hypot(b.pts[0][0]-town.x,b.pts[0][1]-town.z)})).filter(o=>o.d<550).sort((a,b)=>a.d-b.d).slice(0,4);
    buildings.forEach(({b},index)=>decorateBuilding(b,town,index,false));
  }
  // One existing rural footprint per tile gets barn paint; no new solid structures.
  if(!ownTowns.length){const b=(td.buildings||[]).find(b=>!b.campusPart&&!b.landmarkPart&&b.h<9&&b.pts?.length===4&&SCENERY_TOWNS.every(t=>Math.hypot(b.pts[0][0]-t.x,b.pts[0][1]-t.z)>1400));if(b)decorateBuilding(b,{name:'Valley',color:'#934b3f'},0,true);}
  function decorateBuilding(b,town,index,barn) {
    let edge=null,length=0;
    for(let i=0;i<b.pts.length;i++){const a=b.pts[i],q=b.pts[(i+1)%b.pts.length],l=Math.hypot(q[0]-a[0],q[1]-a[1]);if(l>length){length=l;edge=[a,q];}}
    if(length<7||length>70)return;
    const [[ax,az],[bx,bz]]=edge,dx=(bx-ax)/length,dz=(bz-az)/length;
    const cx=b.pts.reduce((s,p)=>s+p[0],0)/b.pts.length,cz=b.pts.reduce((s,p)=>s+p[1],0)/b.pts.length;
    const x=(ax+bx)/2,z=(az+bz)/2;let nx=-dz,nz=dx;if(nx*(x-cx)+nz*(z-cz)<0){nx=-nx;nz=-nz;}
    const y=td.terrainAt(x,z),h=clamp(b.h||5,3,12);
    const facade=new THREE.Group();facade.position.set(x+nx*.16,y,z+nz*.16);facade.rotation.y=Math.atan2(nx,nz);group.add(facade);sites.push(facade);
    if(barn){
      const parts=[];addBox(parts,0,h*.5,0,length*.85,h*.9,.08,'#9a4e42');for(const side of [-1,1])addBox(parts,side*1.6,1.6,.07,3,3.2,.1,'#674d3a');
      for(const side of [-1,1]){const g=new THREE.BoxGeometry(.12,3.8,.12);g.rotateZ(side*.75);g.translate(0,1.6,.16);parts.push(painted(g,'#e3d4ad'));}
      facade.add(new THREE.Mesh(merge(parts),baseMat));
    }else plaque(facade,town,index===3?town.name+' outdoors':SHOPS[index],index===3?'EXPLORE THE VALLEY':'YAMHILL COUNTY',Math.min(length*.8,12),index===3?3:1.25,h*.7,.05,index===3);
    // Window patches share a material but follow each facade's distance culling.
    const windowParts=[];
    for(let i=-1;i<=1;i++){const w=new THREE.PlaneGeometry(1.25,1.35);w.translate(i*2,2,.08);windowParts.push(w);}
    const windowMesh=new THREE.Mesh(merge(windowParts),windowMat);windowMesh.visible=false;litWindows.push(windowMesh);facade.add(windowMesh);
    if(index===0){
      const chimney=new THREE.Mesh(new THREE.BoxGeometry(.8,2,.8),baseMat.clone());chimney.material.vertexColors=false;chimney.material.color.set('#75665a');materials.push(chimney.material);chimney.position.set(cx,td.terrainAt(cx,cz)+h+1,cz);group.add(chimney);sites.push(chimney);
      const smokeGeo=new THREE.IcosahedronGeometry(1,0),smokeMat=new THREE.MeshLambertMaterial({color:'#c7c7bf',transparent:true,opacity:.19,depthWrite:false});materials.push(smokeMat);
      const smoke=new THREE.InstancedMesh(smokeGeo,smokeMat,5);smoke.position.copy(chimney.position);smoke.position.y+=1.5;smoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);smoke.frustumCulled=false;group.add(smoke);sites.push(smoke);animated.push({kind:'smoke',mesh:smoke,site:smoke});
    }
  }
  const m=new THREE.Matrix4(),q=new THREE.Quaternion(),p=new THREE.Vector3(),scale=new THREE.Vector3();
  let lastNight=-1;
  return {group,materials,textures,
    update(camera,time,night=0){
      if(lastNight!==night){windowMat.opacity=night*.85;for(const mesh of litWindows)mesh.visible=night>0;lastNight=night;}
      for(const site of sites)site.visible=Math.hypot(site.position.x-camera.x,site.position.z-camera.z)<650;
      for(const item of animated){if(!item.site.visible)continue;const mesh=item.mesh;
        if(item.kind==='flag'){const pos=mesh.geometry.attributes.position;for(let i=0;i<pos.count;i++){const x=pos.getX(i);pos.setZ(i,Math.sin(time*2.5-x*2)*.17*(x/2.4));}pos.needsUpdate=true;}
        if(item.kind==='birds'){mesh.position.x=Math.sin(time*.06+item.phase)*90;mesh.position.z=Math.cos(time*.06+item.phase)*90;mesh.rotation.y=-time*.06-item.phase;mesh.scale.y=1+Math.sin(time*3)*.2;}
        if(item.kind==='smoke'){for(let i=0;i<5;i++){const life=(time*.15+i/5)%1;p.set(life*5,life*11,Math.sin(life*3)*1.2);scale.setScalar(.5+life*1.6);m.compose(p,q,scale);mesh.setMatrixAt(i,m);}mesh.instanceMatrix.needsUpdate=true;}
      }
    },
  };
}
