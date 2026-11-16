// Lifted crew-cab pickup. Wheel mounts/radii come from the existing type, never from new physics.
import * as THREE from 'three';
import { WHEEL_POS } from '../carmodel.js';
import { material, mesh, box, rod, hull, sideShape, lod, wheel } from './truckbikeparts.js';

export function buildTruckModel(p, suspension) {
  const root = new THREE.Group(); root.name = 'car-truck';
  const bodyPivot = new THREE.Group(); root.add(bodyPivot);
  const paint = material('#e8402f','body'), trim = material('#ffffff','trim'), rim = material('#d9dce2','wheels');
  const rubber = material('#1d1e22'), dark = material('#252b32'), steel = material('#727e87'), glass = material('#213744');
  const lamp = material('#fff1cf'), red = material('#c52c35'), amber = material('#eb9a28');
  const parkedOffset = .3 - suspension.restLength + p.mass * 24 / (4 * suspension.springK);
  const wheels = WHEEL_POS.map(([x,y,z,front]) => {
    const w = wheel(root,rubber,rim,{x:x*p.width,y:y+parkedOffset,z:z*p.length,r:p.radius,width:.48,front});
    w.restY = y; return w;
  });
  const archRadius = .82;
  function body(detail) {
    const group = new THREE.Group();
    // Narrow ladder frame leaves daylight above the oversized tyres.
    for (const s of [-1,1]) box(group,dark,.13,.17,4.8,s*.65,-.16,0);
    box(group,steel,1.6,.09,.8,0,-.17,1.9,.12); // front skid plate
    hull(group,paint,[[2.62,1.04,.31,.70,.98],[2.14,1.07,.31,.80,1.02],[.76,1.07,.31,.83,1.0]]);
    hull(group,paint,[[.86,1.09,.02,.85,1.04],[-1.03,1.09,.02,.86,1.04]]);
    // Separate glasshouse, pillars and roof: four doors, raked screen, upright rear window.
    hull(group,glass,[[.86,1.02,.84,.86,.97],[.36,1.02,.84,1.63,.89],[-.91,1.02,.84,1.63,.89],[-1.04,1.02,.84,.91,.99]]);
    hull(group,paint,[[.40,.91,1.61,1.70,.85],[-.95,.91,1.61,1.70,.85]]);
    for (const s of [-1,1]) {
      rod(group,paint,[s*1.025,.84,.85],[s*.89,1.65,.36],.055);
      rod(group,paint,[s*1.025,.84,-1.03],[s*.89,1.65,-.92],.065);
      rod(group,paint,[s*1.03,.84,-.29],[s*.90,1.65,-.29],.045);
      box(group,dark,.26,.10,1.85,s*1.20,-.20,-.05); // steps clear both wheel openings
      box(group,trim,.025,.065,1.74,s*1.103,.17,-.04);
      box(group,dark,.22,.16,.26,s*1.23,1.03,.63);
      rod(group,dark,[s*1.02,.97,.60],[s*1.22,1.03,.63],.045);
      box(group,steel,.025,.12,.20,s*1.349,1.03,.62); // mirror glass
    }
    // Open bed: floor, front bulkhead, side walls and a separate tailgate. No lid.
    box(group,dark,2.06,.10,1.46,0,.24,-1.83);
    box(group,paint,2.18,.60,.10,0,.53,-1.08);
    box(group,paint,2.30,.60,.12,0,.53,-2.61);
    box(group,dark,2.32,.055,.14,0,.85,-2.61);
    for (const s of [-1,1]) {
      box(group,paint,.14,.34,1.48,s*1.10,.67,-1.85);
      box(group,dark,.18,.055,1.48,s*1.10,.865,-1.85);
      // Interior wheel tubs visible from above.
      box(group,dark,.23,.25,.94,s*.93,.40,-1.70);
    }
    // Cut-out side panels terminate at each faceted arch; a full slab would fill the opening.
    for (const w of wheels) {
      const s = Math.sign(w.holder.position.x), cy = w.holder.position.y, z = w.holder.position.z;
      const arc = [];
      for (let i = 0; i <= 8; i++) { const a = i*Math.PI/8; arc.push([z+Math.cos(a)*archRadius,cy+Math.sin(a)*archRadius]); }
      const top = w.front ? .76 : .82;
      sideShape(group,paint,[[z-archRadius,top],[z+archRadius,top],...arc],s>0?1.07:-1.24,.17);
      // Wide black flares follow the opening, leaving lift-kit clearance underneath.
      const outer = [], inner = [];
      for (let i = 0; i <= 8; i++) {
        const a = i*Math.PI/8;
        outer.push([z+Math.cos(a)*.92,cy+Math.sin(a)*.92]);
        inner.unshift([z+Math.cos(a)*archRadius,cy+Math.sin(a)*archRadius]);
      }
      sideShape(group,dark,[...outer,...inner],s>0?1.20:-1.62,.42);
      if (detail) {
        rod(group,steel,[s*.68,-.12,z],[s*1.2,cy,z],.055);
        rod(group,amber,[s*.95,.27,z-.12],[s*1.13,cy+.06,z+.05],.06);
        rod(group,steel,[s*1.03,.06,z-.05],[s*1.13,cy+.06,z+.05],.027);
      }
    }
    // Tall grille and segmented running lights, with a lower bar in the bumper.
    box(group,dark,1.67,.44,.08,0,.49,2.65);
    box(group,trim,1.70,.045,.035,0,.72,2.703);
    box(group,dark,2.48,.20,.22,0,.10,2.65);
    box(group,steel,1.05,.12,.23,0,-.035,2.68);
    box(group,lamp,.88,.055,.03,0,.13,2.775);
    for (const s of [-1,1]) {
      box(group,dark,.38,.35,.12,s*1.04,.51,2.65);
      box(group,lamp,.29,.07,.035,s*1.04,.65,2.72);
      box(group,lamp,.29,.07,.035,s*1.04,.38,2.72);
      box(group,lamp,.065,.22,.035,s*1.15,.515,2.72);
      box(group,red,.17,.42,.04,s*1.055,.56,-2.69);
      box(group,lamp,.16,.055,.045,s*1.055,.46,-2.694);
    }
    box(group,dark,2.44,.16,.22,0,.06,-2.69);
    box(group,trim,.45,.12,.025,0,.30,-2.678);
    box(group,dark,.32,.07,.025,0,.74,-2.678); // tailgate handle
    // Roof bar is mounted above the windshield on two short feet.
    for (const s of [-1,1]) box(group,dark,.06,.12,.12,s*.66,1.77,.31);
    box(group,dark,1.62,.14,.15,0,1.85,.31);
    box(group,lamp,1.48,.075,.025,0,1.85,.397);
    if (detail) {
      for (let i=-4;i<=4;i++) box(group,steel,.025,.33,.02,i*.17,.49,2.699);
      box(group,steel,1.54,.025,.02,0,.49,2.712);
      for (let i=-1;i<=1;i++) box(group,amber,.06,.035,.022,i*.23,.68,2.73);
      for (let i=-5;i<=5;i++) box(group,dark,.025,.09,.03,i*.13,1.85,.411);
      for (let i=-4;i<=4;i++) box(group,steel,.025,.012,1.20,i*.19,.297,-1.83);
      for (const s of [-1,1]) {
        for (const z of [.32,-.61]) box(group,dark,.035,.045,.19,s*1.104,.76,z);
        box(group,dark,.014,.62,.018,s*1.098,.43,-.27); // door shut line
        box(group,dark,.018,.06,.40,s*1.083,.65,1.23); // fender vent
        box(group,dark,.11,.035,.85,s*.69,.815,1.55,-.02);
        rod(group,steel,[s*.65,-.12,-2.20],[s*.91,-.12,-2.70],.065);
      }
    }
    return group;
  }
  lod(bodyPivot,body(true),body(false),55);
  for (const w of wheels) {
    const near = new THREE.Group(), far = new THREE.Group();
    // Beadlock ring + bolts on both faces, with recessed dark wheel centres.
    for (const s of [-1,1]) {
      mesh(near,new THREE.TorusGeometry(.35,.035,3,12).rotateY(Math.PI/2),rim,s*.257,0,0);
      mesh(near,new THREE.CylinderGeometry(.255,.255,.012,12).rotateZ(Math.PI/2),dark,s*.255,0,0);
      for (let i=0;i<5;i++) {
        const a=i*Math.PI*2/5;
        rod(near,rim,[s*.27,0,0],[s*.27,.29*Math.cos(a),.29*Math.sin(a)],.027,4);
        if (s === Math.sign(w.holder.position.x)) box(near,steel,.025,.038,.038,s*.282,.35*Math.cos(a),.35*Math.sin(a));
      }
      mesh(near,new THREE.CylinderGeometry(.10,.10,.03,6).rotateZ(Math.PI/2),rim,s*.28,0,0);
    }
    // Staggered shoulder lugs read as knobbly tyres without a dense tread mesh.
    for (let i=0;i<10;i++) for (const s of [-1,1]) {
      const a=(i+s*.18)*Math.PI/5;
      const tread=box(near,rubber,.19,.055,.14,s*.135,.593*Math.cos(a),.593*Math.sin(a)); tread.rotation.x=a;
    }
    lod(w.spin,near,far,55);
  }
  root.userData = { bodyPivot, wheels, lightMount: bodyPivot,
    lights: { head: [...[-1,1].map(s=>new THREE.Vector3(s*1.04,.65,2.75)),
      new THREE.Vector3(0,.13,2.795), ...[-1,1].map(s=>new THREE.Vector3(s*.55,1.85,.43))], tail: [-1,1].map(s=>new THREE.Vector3(s*1.055,.56,-2.72)) },
    blob: [3.25,5.6], decalPanels: [[.62,.76,0,.835,1.48,-Math.PI/2]],
    // Maximum upward displacement from each parked hub before the tyre meets its arch.
    // Includes the tread lugs and leaves 2 cm margin for the wheel-clip clamp.
    wheelArch: wheels.map(()=>archRadius-.63-.02),
  };
  return root;
}
