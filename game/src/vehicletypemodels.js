// Small flat-shaded type models. +z is forward. Cosmetic roles match the Garage paint controls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WHEEL_POS } from './carmodel.js';
import { buildTruckModel } from './models/truck.js';
import { buildSportsCarModel } from './models/sportscar.js';
export { buildSportBikeModel } from './models/sportbike.js';

function material(color, role) {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
  if (role) m.userData.cosmeticRole = role;
  return m;
}
function mesh(parent, geometry, mat, x = 0, y = 0, z = 0, rx = 0) {
  const m = new THREE.Mesh(geometry, mat); m.position.set(x,y,z); m.rotation.x = rx;
  m.castShadow = true; parent.add(m); return m;
}
const box = (p, m, w,h,d,x,y,z,rx=0) => mesh(p,new THREE.BoxGeometry(w,h,d),m,x,y,z,rx);
// Trapezoid cross sections, capped and flat shaded; ordered from nose to tail.
function hull(parent, mat, sections) {
  const points = [], rings = sections.map(([z,w,b,t,tw=w]) => [[-w,b,z],[w,b,z],[tw,t,z],[-tw,t,z]]);
  const tri = (a,b,c) => points.push(...a,...b,...c);
  for (let j=1;j<rings.length;j++) for(let i=0;i<4;i++) {
    const a=rings[j-1][i], b=rings[j][i], c=rings[j][(i+1)%4], d=rings[j-1][(i+1)%4];
    tri(a,b,c);tri(a,c,d);
  }
  tri(rings[0][0],rings[0][1],rings[0][2]);tri(rings[0][0],rings[0][2],rings[0][3]);
  const r=rings.at(-1);tri(r[0],r[2],r[1]);tri(r[0],r[3],r[2]);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(points,3));g.computeVertexNormals();
  return mesh(parent,g,mat);
}
// Merge static pieces by material: inexpensive at distance without extra per-frame LOD work.
function batch(group) {
  const batches=new Map();
  for(const child of [...group.children]) if(child.isMesh) {
    child.updateMatrix(); const geometry=(child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone()).applyMatrix4(child.matrix);
    geometry.deleteAttribute('uv');
    if(!batches.has(child.material))batches.set(child.material,[]);
    batches.get(child.material).push(geometry);child.geometry.dispose();group.remove(child);
  }
  for(const [mat,parts] of batches){mesh(group,mergeGeometries(parts),mat);parts.forEach(p=>p.dispose());}
}
function wheel(parent, tyre, rim, x,y,z,r,width,front) {
  const holder=new THREE.Group();holder.position.set(x,y,z);parent.add(holder);
  const spin=new THREE.Group();holder.add(spin);
  mesh(spin,new THREE.CylinderGeometry(r,r,width,12).rotateZ(Math.PI/2),tyre);
  mesh(spin,new THREE.CylinderGeometry(r*.64,r*.64,width+.025,8).rotateZ(Math.PI/2),rim);
  return {holder,spin,restY:y,r,front};
}
export function buildTypeCarModel(type, p, suspension) {
  if (type === 'truck') return buildTruckModel(p, suspension);
  if (type === 'sports') return buildSportsCarModel(p, suspension);
  const root=new THREE.Group();root.name=`car-${type}`;
  const bodyPivot=new THREE.Group();root.add(bodyPivot);
  const paint=material('#e8402f','body'),trim=material('#ffffff','trim'),black=material('#20242a'),glass=material('#263b49'),rim=material('#d9dce2','wheels');
  const w=1.0*p.width, nose=2.12*p.length, tail=-2.05*p.length;
  let lampY=.25;
  {
    const tall=type==='hatch'?.85:type==='suv'?1.25:1.42, rear=type==='truck'?-.15:tail+.17;
    hull(bodyPivot,paint,[[nose,w*.91,-.17,.34],[nose-.55,w,-.17,.48],[tail,w,-.17,.44]]);
    hull(bodyPivot,glass,[[.94,w*.88,.45,.47],[.48,w*.88,.45,tall,w*.73],[rear,w*.88,.45,tall,w*.73],[rear-.23,w*.88,.45,.48]]);
    box(bodyPivot,paint,w*1.5,.09,.48-rear,0,tall+.02,(.48+rear)/2);
    for(const s of [-1,1]) {
      box(bodyPivot,paint,.09,tall-.42,.11,s*w*.84,(tall+.42)/2,-.25);
      box(bodyPivot,black,.10,.16,nose-tail-.1,s*w,-.14,(nose+tail)/2);
      box(bodyPivot,trim,.21,.12,.24,s*(w+.05),.63,.65);
    }
    if(type==='truck') {
      box(bodyPivot,black,w*1.65,.08,1.9,0,.42,tail+1.02);
      for(const s of [-1,1])box(bodyPivot,paint,.18,.42,1.95,s*(w-.09),.60,tail+1);
      box(bodyPivot,paint,w*2,.42,.16,0,.60,tail+.05);
      box(bodyPivot,trim,w*2.05,.16,.20,0,-.08,nose+.05);
    }
    box(bodyPivot,black,w*1.05,.23,.025,0,.21,nose+.015);lampY=.29;
  }
  const head=[],taillights=[],headMaterial=material('#fff2c9'),tailMaterial=material('#b92025');
  for(const s of [-1,1]) {
    box(bodyPivot,headMaterial,.33,.10,.035,s*w*.68,lampY,nose+.025);
    box(bodyPivot,tailMaterial,.30,.12,.035,s*w*.72,.28,tail-.025);
    head.push(new THREE.Vector3(s*w*.68,lampY,nose+.06));taillights.push(new THREE.Vector3(s*w*.72,.28,tail-.06));
  }
  const wheels=WHEEL_POS.map(([x,y,z,front])=>wheel(root,black,rim,x*p.width,y,z*p.length,p.radius,type==='truck'?.46:.30,front));
  // Match the parked suspension stance in Garage previews, especially the lifted truck.
  for (const w of wheels) w.holder.position.y += .3 - suspension.restLength + p.mass * 24 / (4 * suspension.springK);
  batch(bodyPivot);
  root.userData={bodyPivot,wheels,lightMount:bodyPivot,lights:{head,tail:taillights},blob:[2.4*p.width,4.6*p.length],
    // Decals live on the hood, not inside the enclosed body.
    decalPanels:[[.55,.55,0,type==='sports'?.25:.49,1.28*p.length,-Math.PI/2+(type==='sports'?.23:0)]]};
  return root;
}
