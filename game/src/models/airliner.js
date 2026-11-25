// Playable half-scale jumbo: 36 m long, 32 m span. +z nose, +x left.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addCockpit } from './cockpit.js';
import { speedBrakePanels } from '../speedbrakes.js';

export const AIRLINER_AIRFRAME = {
  gear: [[0, 11], [2.3, -2], [-2.3, -2]], gearH: 3.2, wb: 13, poseK: 2 / 13,
  body: [[0, 0, 18], [0, .3, -18], [16, .2, -5], [-16, .2, -5], [0, 7, -15]],
  half: { x: 16, front: 18, back: -18 }, rotMax: .16, scrapeZ: -15,
  // Forgiving wings on narrow roads; trunks along the fuselage still collide.
  treeR: 1.5, treeZ: [-15, -10, -5, 0, 5, 10, 15], wing: 1.5, buildingR: 3,
  // Eye: height, forward, captain's lateral seat coordinate in the first-person deck.
  authV: 85, eye: [2.15, 13.5, .43], maxStepDistance: 2, fixedGear: false, airKmh: 950,
  chaseDistance: 2, chaseHeight: 2.8,
};

export function buildAirlinerModel() {
  const root = new THREE.Group(); root.name = 'jet-airliner';
  const mat = (color, role) => {
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
    if (role) m.userData.cosmeticRole = role;
    return m;
  };
  const body = mat('#f2f2ee','body'), trim = mat('#1f5fae','trim'), dark = mat('#202a32'), glass = mat('#263e50'), metal = mat('#899298','wheels');
  const add = (p,g,m,x=0,y=0,z=0) => { const o = new THREE.Mesh(g,m); o.position.set(x,y,z); o.castShadow=true; p.add(o); return o; };
  const box = (p,m,w,h,d,x,y,z) => add(p,new THREE.BoxGeometry(w,h,d),m,x,y,z);
  const window = (p,w,h,x,y,z,s,tilt=0) => add(p,new THREE.PlaneGeometry(w,h).rotateY(s*Math.PI/2).rotateZ(s*tilt),glass,x,y,z);
  const pivot = (x=0,y=0,z=0,p=root) => { const g=new THREE.Group();g.position.set(x,y,z);p.add(g);return g; };
  const tube = (p,m,r1,r2,len,x,y,z,segments=6) =>
    add(p,new THREE.CylinderGeometry(r1,r2,len,segments).rotateX(Math.PI/2),m,x,y,z);
  const plate = (p,m,pts,thick=.18) => {
    const shape = new THREE.Shape(pts.map(([x,z]) => new THREE.Vector2(x,z)));
    return add(p,new THREE.ExtrudeGeometry(shape,{depth:thick,bevelEnabled:false})
      .rotateX(Math.PI/2).translate(0,thick/2,0),m);
  };
  // Separate shell lets the cockpit hide occluding geometry without hiding the wings.
  const shell = pivot();
  tube(shell,body,1.6,1.6,23,0,0,1,8);
  tube(shell,body,.3,1.6,5.5,0,0,15.25,8);
  tube(shell,body,1.6,.2,7.5,0,.15,-14.25,8);
  const hump = add(shell,new THREE.SphereGeometry(1,8,4),body,0,1.05,10.8);hump.scale.set(1.35,1.45,5.7);
  for (const s of [-1,1]) {
    add(shell,new THREE.PlaneGeometry(23,.24).rotateY(s*Math.PI/2).rotateZ(s*Math.PI/8),trim,s*1.37,.57,1);
    // Window rows sit just outside the octagonal shell, not coplanar with it.
    for (let z=-9;z<=11;z+=1.05) window(shell,.37,.22,s*1.286,.77,z,s,Math.PI/8);
    for (let z=8;z<=12;z+=1.05) window(shell,.34,.2,s*1.12,1.94,z,s);
  }
  const canopy = pivot();
  for (const s of [-1,1]) {
    const pane=box(canopy,glass,1.03,.48,.06,s*.56,2.02,14.5);pane.rotation.y=s*.22;
    const side=box(canopy,glass,.06,.42,1.3,s*1.08,2.02,13.8);side.rotation.y=s*.12;
  }
  const elevator = pivot(0,.65,-14), rudder = pivot(0,1,-13);
  const aileronL=pivot(12,.1,-5), aileronR=pivot(-12,.1,-5);
  for (const s of [-1,1]) {
    const ps=points=>points.map(([x,z])=>[s*x,z]);
    plate(root,body,ps([[1.2,4],[16,-4.7],[16,-6],[2,-3.8]]),.23);
    plate(elevator,body,ps([[.5,1],[6,-2],[6,-3],[.5,-1.5]]));
    plate(s>0?aileronL:aileronR,trim,ps([[-1,0],[3,.1],[3,-.55],[-1,-.55]]),.12);
    for (const [x,z] of [[5.3,2],[10.3,-.6]]) {
      box(root,trim,.2,1.1,1.9,s*x,-.6,z-.45);
      tube(root,body,.8,.72,2.8,s*x,-1.35,z);
      tube(root,metal,.8,.8,.18,s*x,-1.35,z+1.42);
      tube(root,dark,.68,.68,.02,s*x,-1.35,z+1.52);
      tube(root,metal,.42,.28,.65,s*x,-1.35,z-1.6);
      tube(root,dark,.26,.26,.02,s*x,-1.35,z-1.94);
      add(root,new THREE.ConeGeometry(.22,.45,8).rotateX(Math.PI/2),metal,s*x,-1.35,z+1.6);
    }
    box(root,metal,.34,.18,.12,s*2.2,-.12,3.43);
  }
  const fin = new THREE.ExtrudeGeometry(new THREE.Shape([[0,0],[-4.7,0],[-3.9,6],[-2.7,6]].map(([z,y])=>new THREE.Vector2(z,y))),{depth:.2,bevelEnabled:false}).rotateY(-Math.PI/2).translate(.1,0,0);
  add(rudder,fin,trim);
  const wheels=[], rolling=[];
  for (const [i,[x,z]] of AIRLINER_AIRFRAME.gear.entries()) {
    const leg=pivot(x,-1.3,z);box(leg,metal,.15,1.35,.15,0,-.65,0);
    const holder=pivot(0,-1.4,0,leg),spin=pivot(0,0,0,holder);
    // Main gear represents paired four-wheel bogies, nose gear a twin wheel.
    for (const dx of i ? [-.65,-.25,.25,.65] : [-.24,.24]) for (const dz of i ? [-.52,.52] : [0]) {
      const axle=pivot(dx,0,dz,spin);
      add(axle,new THREE.CylinderGeometry(.5,.5,.24,6).rotateZ(Math.PI/2).rotateX(Math.PI/6),dark);
      add(axle,new THREE.CylinderGeometry(.24,.24,.255,4).rotateZ(Math.PI/2),metal);
      rolling.push({axle,i});
    }
    wheels.push({leg,holder,spin,r:.5,front:i===0});
  }
  const setGear = k => {
    for (const w of wheels) { w.leg.scale.y = Math.max(.05,k); w.leg.visible = k > .06; }
  };
  const wreckMats = [body,trim], wreckColor = 0x34363a;
  let wrecked = false, paint = [];
  const wreck = on => {
    if (on && !wrecked) paint = wreckMats.map(m => m.color.getHex());
    if (on || wrecked) wreckMats.forEach((m,i) => m.color.setHex(on ? wreckColor : paint[i]));
    wrecked = on; canopy.visible = !on;
    root.scale.set(1, on ? .65 : 1, on ? .85 : 1);
  };
  // Merge static geometry per material/pivot; individual wheel pivots survive remote batching.
  const groups = []; root.traverse(o => { if (o.isGroup) groups.push(o); });
  for (const g of groups) {
    const batches = new Map();
    for (const m of [...g.children]) if (m.isMesh) {
      m.updateMatrix();
      const geo = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()).applyMatrix4(m.matrix);
      geo.deleteAttribute('uv');
      if (!batches.has(m.material)) batches.set(m.material, []);
      batches.get(m.material).push(geo); m.geometry.dispose(); g.remove(m);
    }
    for (const [m,parts] of batches) { add(g,mergeGeometries(parts),m); parts.forEach(p => p.dispose()); }
  }
  const setSpeedBrake = speedBrakePanels(root,trim,[-1,1].flatMap(s => [4,7,10].map(x => ({
    x:s*x, y:.17, z:1.3-x*.44, w:2.3, d:.8, axis:'x', side:0, angle:1.1,
  }))));
  root.userData = {
    setGear, setSpeedBrake, wheels, noseWheel:wheels[0].holder, elevator, rudder, aileronL, aileronR,
    canopy, wreck, wreckMats, wreckColor, blob:[32,36],
    animate(vehicle) { for (const w of rolling) w.axle.rotation.x = vehicle.wheels[w.i].spin; },
    lights: {
      head:[new THREE.Vector3(2.2,-.12,3.5),new THREE.Vector3(-2.2,-.12,3.5)], tail:[],
      nav: {
        left:new THREE.Vector3(16,.2,-5), right:new THREE.Vector3(-16,.2,-5),
        tail:new THREE.Vector3(0,.3,-18), strobe:new THREE.Vector3(0,2.5,10),
      },
    },
  };
  addCockpit(root,{style:'airliner',eye:AIRLINER_AIRFRAME.eye,width:1.15,depth:.8,blockers:[shell]});
  return root;
}
