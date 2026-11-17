// The registry is also the layout format's allowlist. Local +z is forward; y is the piece's base.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RAMP_LEN, rampShape } from '../data.js';
import { buildRoads } from '../roads.js';
import { buildBridgeSteps } from '../bridges.js';
import { buildCampusGeometry } from '../campusmodel.js';
import { coniferGeometry, broadleafGeometry } from '../world.js';

const definitions = [
  ['ramp-small', 'Small jump', 'Ramps', 6, 16, 1.1, 'jump'],
  ['ramp-medium', 'Medium jump', 'Ramps', 9, RAMP_LEN, 2.2, 'jump'],
  ['ramp-huge', 'Huge jump', 'Ramps', 16, 62, 8.8, 'jump'],
  ['kicker', 'Kicker', 'Ramps', 7, 10, 4, 'wedge'],
  ['quarter-pipe', 'Quarter-pipe', 'Ramps', 12, 12, 8, 'quarter'],
  ['half-pipe', 'Half-pipe', 'Ramps', 20, 24, 6, 'half'],
  ['banked-curve', 'Banked curve', 'Ramps', 24, 24, 5, 'bank'],
  ['wedge', 'Wedge', 'Ramps', 10, 20, 4, 'wedge'],
  ['platform', 'Platform', 'Ramps', 16, 16, 3, 'box'],
  ['road-straight', 'Straight road', 'Roads', 10, 30, .12, 'road'],
  ['road-curve', 'Curved road', 'Roads', 24, 24, .12, 'curve'],
  ['road-up', 'Road uphill', 'Roads', 10, 30, 5, 'up'],
  ['road-down', 'Road downhill', 'Roads', 10, 30, 5, 'down'],
  ['bridge', 'Bridge span', 'Roads', 12, 36, 4, 'bridge'],
  ['wall', 'Wall', 'Obstacles', 12, 1, 4, 'box'],
  ['barrier', 'Barrier', 'Obstacles', 6, .8, 1.2, 'box'],
  ['cone', 'Cone', 'Obstacles', 1, 1, 1.2, 'cone'],
  ['tyres', 'Tyre stack', 'Obstacles', 2, 2, 1.8, 'tyres'],
  ['boost', 'Boost pad', 'Race', 8, 8, .08, 'boost'],
  ['checkpoint', 'Checkpoint arch', 'Race', 14, 1, 7, 'arch'],
  ['start', 'Start line', 'Race', 12, 2, .04, 'start'],
  ['conifer', 'Conifer', 'Scenery', 4, 4, 14, 'tree'],
  ['broadleaf', 'Broadleaf', 'Scenery', 8, 8, 12, 'tree'],
  ['house', 'House', 'Buildings', 10, 14, 5, 'building'],
  ['shop', 'Shop', 'Buildings', 16, 12, 5, 'building'],
  ['barn', 'Barn', 'Buildings', 14, 22, 7, 'building'],
  ['pool', 'Water pool', 'Scenery', 18, 24, 3, 'pool'],
];
const cache = new Map();
export const PIECES = definitions.map(([id, name, category, w, l, h, shape]) => ({
  id, name, category, w, l, h, shape, scalable: true,
  surface: category === 'Roads' ? 3 : 6,
  collider: shape === 'tree' ? 'tree' : shape === 'pool' ? 'water' : ['box', 'building', 'cone', 'tyres', 'arch'].includes(shape) ? 'solid' : 'surface',
  build() { return model(this); },
}));
export const BY_ID = new Map(PIECES.map(p => [p.id, p]));
export const CATEGORIES = [...new Set(PIECES.map(p => p.category))];
export function localPoint(p, x, z) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw), dx = x - p.x, dz = z - p.z;
  return [(dx * c - dz * s) / p.scale, (dx * s + dz * c) / p.scale];
}
export function worldPoint(p, x, y, z) {
  const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
  return [p.x + (x * c + z * s) * p.scale, p.y + y * p.scale, p.z + (z * c - x * s) * p.scale];
}
export function snapPlacement(p, enabled, fine = false) {
  if (!enabled) return { ...p };
  const angle = (fine ? 1 : 15) * Math.PI / 180;
  return { ...p, x: Math.round(p.x), z: Math.round(p.z), y: p.y, yaw: Math.round(p.yaw / angle) * angle };
}
export function housePart(d) {
  return { pts: [[-d.w/2,-d.l/2],[d.w/2,-d.l/2],[d.w/2,d.l/2],[-d.w/2,d.l/2]], h: d.h,
    wall: d.id === 'barn' ? [.57,.24,.18] : [.73,.69,.58],
    roof: { type: d.id === 'shop' ? 'flat' : 'gable', pitch: 25, color: [.24,.27,.29] },
    win: { rows: 1, every: 3, margin: 1, sh: 3, sill: 1, w: 1.2, h: 1.5, color: [.26,.39,.43] }, doors: [] };
}
// A shared triangulation is used for both drawing and collision (including curved/banked pieces).
export function surfaceTriangles(d) {
  if (cache.has(d.id)) return cache.get(d.id);
  const tris = [], add = (a,b,c,e) => tris.push([a,b,c], [a,c,e]);
  if (['curve','bank'].includes(d.shape)) {
    const inner = 10, outer = 22, n = 24;
    const point = (r, i) => { const a = i / n * Math.PI / 2; return [r * Math.cos(a) - 11, d.shape === 'bank' ? (r-inner)/(outer-inner)*d.h : d.h, r*Math.sin(a)-11]; };
    for(let i=0;i<n;i++) add(point(inner,i),point(inner,i+1),point(outer,i+1),point(outer,i));
  } else {
    const n = ['quarter','half','jump'].includes(d.shape) ? 64 : 1;
    const height = (x,z) => {
      const t = (z + d.l/2)/d.l;
      if(d.shape==='jump') return rampShape(t*RAMP_LEN)[0] * d.h/2.2;
      if(['wedge','up'].includes(d.shape)) return d.h*t;
      if(d.shape==='down') return d.h*(1-t);
      if(d.shape==='quarter') return d.h*(1-Math.sqrt(Math.max(0,1-t*t)));
      if(d.shape==='half') return d.h*(1-Math.sqrt(Math.max(0,1-(x/(d.w/2))**2)));
      return d.h;
    };
    const nx = d.shape==='half' ? n : 1, nz = d.shape==='half' ? 1 : n;
    for(let i=0;i<nx;i++) for(let j=0;j<nz;j++) {
      const x=-d.w/2+d.w*i/nx, X=-d.w/2+d.w*(i+1)/nx, z=-d.l/2+d.l*j/nz, Z=-d.l/2+d.l*(j+1)/nz;
      add([x,height(x,z),z],[x,height(x,Z),Z],[X,height(X,Z),Z],[X,height(X,z),z]);
    }
  }
  cache.set(d.id,tris); return tris;
}
export function triangleSample(tris, x, z) {
  for(const [a,b,c] of tris) {
    const ux=b[0]-a[0], uz=b[2]-a[2], vx=c[0]-a[0], vz=c[2]-a[2], det=ux*vz-uz*vx;
    if(Math.abs(det)<1e-9) continue;
    const dx=x-a[0], dz=z-a[2], u=(dx*vz-dz*vx)/det, v=(ux*dz-uz*dx)/det;
    if(u < -1e-7 || v < -1e-7 || u+v > 1+1e-7) continue;
    const uy=b[1]-a[1], vy=c[1]-a[1];
    return { h:a[1]+u*uy+v*vy, gx:(uy*vz-vy*uz)/det, gz:(vy*ux-uy*vx)/det };
  }
  return null;
}
const material = new THREE.MeshLambertMaterial({vertexColors:true, side:THREE.DoubleSide});
const models = new Map();
function paint(g, color) {
  const c=new THREE.Color(color), a=new Float32Array(g.attributes.position.count*3);
  for(let i=0;i<a.length;i+=3) { a[i]=c.r;a[i+1]=c.g;a[i+2]=c.b; }
  g.setAttribute('color',new THREE.BufferAttribute(a,3)); return g;
}
function model(d) {
  if(models.has(d.id)) return models.get(d.id);
  const group=new THREE.Group();
  const mesh=(g,col)=>{ const m=new THREE.Mesh(col === undefined ? g : paint(g,col),material); m.castShadow=m.receiveShadow=true;group.add(m);return m; };
  const box=(w,h,l,x,y,z,col)=>mesh(new THREE.BoxGeometry(w,h,l).translate(x,y,z),col);
  if(d.shape==='tree') {
    mesh((d.id==='conifer'?coniferGeometry():broadleafGeometry()).scale(d.w,d.h,d.w));
  } else if(d.category==='Roads') {
    const n=d.shape==='curve'?25:Math.ceil(d.l/1.5)+1;
    const r={n,kind:'asphalt',osm:'primary',hw:d.shape==='curve'?6:d.w/2,sw:[0,0],x:[],z:[],y:[],c:[],lx:[],lz:[],bridge:d.shape==='bridge'};
    for(let i=0;i<n;i++) {
      const t=i/(n-1),a=t*Math.PI/2;
      r.x.push(d.shape==='curve'?16*Math.cos(a)-11:0);r.z.push(d.shape==='curve'?16*Math.sin(a)-11:-d.l/2+t*d.l);
      r.y.push(d.shape==='up'?t*d.h:d.shape==='down'?(1-t)*d.h:d.h);r.c.push(0);
      r.lx.push(d.shape==='curve'?Math.cos(a):1);r.lz.push(d.shape==='curve'?Math.sin(a):0);
    }
    group.add(buildRoads({},material,[{r,a:0,b:n-1}]));
    if(d.shape==='bridge') {
      const steps=buildBridgeSteps({renderRoads:[r],terrainAt:()=>0},material);let result;while(!(result=steps.next()).done);
      result.value.near.visible=true;group.add(result.value.near);result.value.far.geometry.dispose();group.userData.bridgePiers=result.value.report.piers;
    }
  } else if(d.shape==='building') mesh(buildCampusGeometry({floor:0,parts:[housePart(d)]},()=>0));
  else if(d.shape==='arch') {
    box(1,d.h,1,-d.w/2+.5,d.h/2,0,0xe6bd42);box(1,d.h,1,d.w/2-.5,d.h/2,0,0xe6bd42);
    box(d.w,1,1,0,d.h-.5,0,0xe6bd42);
  } else if(d.shape==='cone') mesh(new THREE.ConeGeometry(.5,d.h,8).translate(0,d.h/2,0),0xf17630);
  else if(d.shape==='tyres') for(let i=0;i<3;i++) mesh(new THREE.TorusGeometry(.68,.3,6,12).rotateX(Math.PI/2).translate(0,.3+i*.6,0),0x24282b);
  else {
    const top=surfaceTriangles(d), pos=[];
    for(const tri of top) pos.push(...tri.flat());
    // Closed side skirts, from precisely the same top edges.
    const edges=new Map();
    for(const tri of top) for(let i=0;i<3;i++) {
      const a=tri[i],b=tri[(i+1)%3],key=[a.join(','),b.join(',')].sort().join('|');
      if(edges.has(key)) edges.delete(key); else edges.set(key,[a,b]);
    }
    if(d.shape!=='pool') for(const [a,b] of edges.values()) pos.push(...a,...b,b[0],0,b[2],...a,b[0],0,b[2],a[0],0,a[2]);
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.computeVertexNormals();
    const col=d.shape==='pool'?0x348fa7:d.shape==='boost'?0x56d29b:d.category==='Roads'?0x42464b:d.category==='Ramps'?0xc7a53b:0x8d9297;
    const m=mesh(g,col);
    if(d.shape==='pool') { m.material=material.clone(); m.material.transparent=true;m.material.opacity=.7; }
    // Road markings and ramp chevrons stay in this cached prototype and are instanced together.
    if(d.category==='Roads' && !['curve','bank'].includes(d.shape)) for(let z=-d.l/2+3;z<d.l/2;z+=6) {
      const h=triangleSample(top,0,z)?.h ?? d.h;
      box(.16,.015,2,0,h+.02,z,0xe2ce7c);
    }
    if(['jump','wedge','boost'].includes(d.shape)) for(const x of [-d.w*.35,d.w*.35]) for(let z=-d.l*.35;z<d.l*.4;z+=3) {
      const h=triangleSample(top,x,z)?.h ?? 0;box(.3,.025,.7,x,h+.025,z,0x24282b);
    }
    if(d.shape==='pool') {
      box(d.w,.25,d.l,0,-.125,0,0xa7b1ad);
      for(const x of [-d.w/2,d.w/2])box(.4,d.h+.3,d.l+.4,x,(d.h+.3)/2,0,0xa7b1ad);
      for(const z of [-d.l/2,d.l/2])box(d.w,d.h+.3,.4,0,(d.h+.3)/2,z,0xa7b1ad);
    }
    if(d.shape==='bridge') for(const x of [-d.w/2,d.w/2]) box(.25,1.1,d.l,x,d.h+.55,0,0xb6b9b9);
    if(d.shape==='start') for(let x=-d.w/2+.5;x<d.w/2;x++) for(let z=-.5;z<1;z++) box(1,.015,1,x,d.h+.02,z,((Math.round(x)+Math.round(z))%2)?0xf0f0e8:0x222428);
  }
  // Merge trim/markings into the same draw call as their piece before instancing.
  if (group.children.length > 1 && d.shape !== 'pool') {
    const geometries = group.children.map(m => {
      const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry;
      g.deleteAttribute('uv'); return g;
    });
    const merged = mergeGeometries(geometries);
    if (merged) { for (const m of [...group.children]) group.remove(m); mesh(merged); }
    for (const g of geometries) g.dispose();
  }
  models.set(d.id,group);return group;
}
