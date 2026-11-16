// Small flat-shaded type models. +z is forward. Cosmetic roles match the Garage paint controls.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { WHEEL_POS } from './carmodel.js';

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
  const root=new THREE.Group();root.name=`car-${type}`;
  const bodyPivot=new THREE.Group();root.add(bodyPivot);
  const paint=material('#e8402f','body'),trim=material('#ffffff','trim'),black=material('#20242a'),glass=material('#263b49'),rim=material('#d9dce2','wheels');
  const w=1.0*p.width, nose=2.12*p.length, tail=-2.05*p.length;
  let lampY=.25;
  if(type==='sports') {
    hull(bodyPivot,paint,[[nose,w*.85,-.22,.04],[1.1,w,-.22,.28],[-.6,w,-.22,.35],[tail,w*.92,-.17,.26]]);
    hull(bodyPivot,glass,[[.95,.78,.28,.29,.66],[.10,.79,.30,.73,.59],[-.9,.8,.30,.76,.58],[-1.36,.8,.30,.33,.72]]);
    box(bodyPivot,paint,1.18,.045,.95,0,.77,-.4);
    for(const s of [-1,1]){box(bodyPivot,black,.08,.18,.66,s*w,.05,-.66);box(bodyPivot,trim,.09,.05,2.1,s*(w-.1),-.15,-.05);}
    box(bodyPivot,black,w*1.75,.09,.24,0,-.19,nose);lampY=.11;
  } else {
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
    if(type==='suv')for(const s of [-1,1])box(bodyPivot,black,.08,.10,1.9,s*w*.64,tall+.13,-.6);
    if(type==='hatch')box(bodyPivot,trim,w*1.8,.06,.23,0,tall+.08,tail+.27);
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
export function buildSportBikeModel() {
  const root=new THREE.Group();root.name='bike-sport';
  const lean=new THREE.Group();lean.position.y=-.54;root.add(lean);
  const body=new THREE.Group();body.position.y=.54;lean.add(body);
  const paint=material('#ff7a1a','body'),trim=material('#f2f2ee','trim'),black=material('#1d1f24'),metal=material('#8a9099','wheels'),glass=material('#263b49');
  hull(body,paint,[[.95,.19,-.02,.38,.16],[.5,.31,-.27,.50,.25],[-.25,.24,-.28,.28,.20],[-.65,.14,-.12,.22,.12]]);
  hull(body,paint,[[.4,.22,.25,.45],[-.1,.24,.25,.50],[-.42,.15,.23,.32]]);
  hull(body,glass,[[.87,.16,.37,.39],[.52,.22,.40,.67,.17],[.35,.21,.40,.62,.17]]);
  box(body,black,.32,.07,.55,0,.35,-.43);
  hull(body,paint,[[-.56,.18,.27,.39],[-.97,.09,.36,.45,.06]]);
  for(const s of [-1,1]){box(body,trim,.025,.18,.48,s*.29,.04,.16);box(body,black,.04,.12,.20,s*.30,.21,.25);}
  box(body,metal,.10,.10,.55,-.21,-.12,-.55,-.2);
  const bars=new THREE.Group();bars.position.set(0,.37,.48);body.add(bars);
  for(const s of [-1,1])box(bars,metal,.05,.63,.05,s*.10,-.28,.06,-.25);
  box(bars,black,.6,.035,.035,0,.08,0);
  const wheels=[wheel(body,black,metal,0,-.2,.72,.34,.16,true),wheel(body,black,metal,0,-.2,-.73,.34,.21,false)];
  const rider=new THREE.Group();rider.position.set(0,.42,-.30);body.add(rider);
  const jacket=material('#f2f2ee','jacket'),gloves=material('#20242a','gloves'),helmet=material('#ff7a1a','helmet');
  // Tucked torso is built into the model; the existing rider animation adds only a small nod.
  box(rider,jacket,.36,.46,.22,0,.25,.19,1.05);
  for(const s of [-1,1]) {
    box(rider,jacket,.12,.38,.13,s*.20,-.04,.06,1.05);
    box(rider,black,.11,.33,.12,s*.22,-.25,.10,-.5);
    box(rider,jacket,.10,.32,.10,s*.22,.26,.42,-.75);
    box(rider,gloves,.10,.09,.10,s*.28,.07,.72);
  }
  mesh(rider,new THREE.IcosahedronGeometry(.18,1),helmet,0,.42,.48);
  box(rider,glass,.25,.09,.10,0,.43,.64);
  const lamp=material('#fff2c9'),tail=material('#b92025');
  for(const s of [-1,1])box(body,lamp,.13,.08,.04,s*.115,.25,.93);
  box(body,tail,.15,.06,.035,0,.40,-.97);
  batch(body);batch(rider);batch(bars);
  root.userData={lean,bars,wheels,rider,blob:[.9,2.1],lightMount:body,lights:{head:[new THREE.Vector3(0,.25,.97)],tail:[new THREE.Vector3(0,.40,-1)]},
    decalPanels:[[.3,.2,.312,.04,.16,0,Math.PI/2],[.3,.2,-.312,.04,.16,0,-Math.PI/2]]};
  return root;
}
