// Motocross silhouette and mechanical detail; all animation pivots match the original bike.
import * as THREE from 'three';
import { material, mesh, box, hull, sideShape, batch, lod } from './truckbikeparts.js';

// Tube ends meet other parts; open ends avoid spending triangles on hidden caps.
function rod(parent, mat, a, b, radius, segments = 5) {
  const start = new THREE.Vector3(...a), delta = new THREE.Vector3(...b).sub(start);
  const part = mesh(parent,new THREE.CylinderGeometry(radius,radius,delta.length(),segments,1,true),mat);
  part.position.copy(start).addScaledVector(delta,.5);
  part.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());
  return part;
}
export function buildDirtBikeModel() {
  const root = new THREE.Group(); root.name = 'bike';
  const lean = new THREE.Group(); lean.position.y = -.54; root.add(lean);
  const body = new THREE.Group(); body.position.y = .54; lean.add(body);
  const paint = material('#ff7a1a','body'), trim = material('#f2f2ee','trim'), rim = material('#8a9099','wheels');
  const black = material('#1d1f24'), metal = material('#727e88'), gold = material('#bba16a'), glass = material('#274351');
  const helmet = material('#ff7a1a','helmet'), jersey = material('#f2f2ee','jacket'), gloves = material('#1d1f24','gloves');
  const lamp = material('#fff0d1'), tail = material('#c52337');
  function chassis(detail) {
    const g = new THREE.Group();
    hull(g,paint,[[.46,.10,.16,.34,.13],[.26,.19,.12,.40,.15],[-.04,.13,.18,.36,.11]]);
    hull(g,black,[[.03,.105,.33,.39],[-.29,.14,.31,.40],[-.63,.10,.34,.41]]);
    hull(g,paint,[[-.54,.13,.32,.36],[-.79,.115,.35,.40],[-.98,.07,.32,.35]]);
    box(g,tail,.08,.03,.03,0,.328,-.985);
    box(g,metal,.22,.18,.23,0,-.09,.03);
    mesh(g,new THREE.CylinderGeometry(.105,.105,.27,8).rotateZ(Math.PI/2),metal,0,-.12,-.06);
    box(g,black,.16,.15,.15,0,.035,.10,-.2);
    for (const s of [-1,1]) {
      // Open twin cradle frame, raised rear subframe and long alloy swingarm.
      rod(g,metal,[s*.12,.29,.38],[s*.12,-.24,.13],.025,4);
      rod(g,metal,[s*.12,-.24,.13],[s*.12,-.17,-.30],.025,4);
      rod(g,metal,[s*.12,-.17,-.30],[s*.12,.27,-.06],.025,4);
      rod(g,metal,[s*.12,.27,-.06],[s*.12,.32,-.64],.018,4);
      rod(g,metal,[s*.11,-.13,-.23],[s*.11,-.20,-.73],.035,4);
      // Plate faces retain the original Garage decal planes at x=+/-.174.
      sideShape(g,trim,[[-.26,.30],[-.59,.31],[-.64,.15],[-.38,.10]],s>0?.16:-.173,.013);
      sideShape(g,paint,[[.40,.31],[.16,.36],[.02,.16],[.24,.10]],s>0?.183:-.20,.017);
      box(g,metal,.14,.025,.065,s*.23,-.19,-.15);
      if(detail) {
        box(g,black,.016,.035,.44,s*.12,-.12,-.50);
        for(let i=0;i<3;i++)box(g,black,.014,.018,.15,s*.119,-.025+i*.035,.09);
      }
    }
    rod(g,gold,[0,.23,-.19],[0,-.12,-.43],.035,6);
    if(detail)for(let i=0;i<1;i++)mesh(g,new THREE.TorusGeometry(.043,.009,3,5).rotateX(-.6),black,0,.16-i*.045,-.24-i*.03);
    // High routed header and silencer, outside the right side panel.
    rod(g,metal,[-.12,-.03,.16],[-.24,.04,.29],.028,5);
    rod(g,metal,[-.24,.04,.29],[-.24,.15,-.31],.038,5);
    rod(g,metal,[-.23,.18,-.37],[-.23,.25,-.77],.064,6);
    rod(g,black,[-.23,.25,-.77],[-.23,.265,-.83],.042,6);
    return g;
  }
  lod(body,chassis(true),chassis(false),38);
  const bars = new THREE.Group(); bars.position.set(0,.42,.5); bars.rotation.x = -.45; body.add(bars);
  const steering = new THREE.Group(); bars.add(steering);
  for(const s of [-1,1]) {
    rod(steering,gold,[s*.09,-.46,0],[s*.09,.04,0],.025,6);
    rod(steering,metal,[s*.09,-.69,0],[s*.09,-.31,0],.018,5);
    box(steering,trim,.055,.28,.055,s*.09,-.51,.025);
    rod(steering,metal,[s*.05,.035,0],[s*.24,.10,.015],.018,5);
    rod(steering,black,[s*.24,.10,.015],[s*.36,.10,.015],.026,6);
    rod(steering,metal,[s*.26,.105,.075],[s*.34,.105,.09],.008,4);
  }
  box(steering,metal,.24,.025,.075,0,-.07,0);
  box(steering,trim,.22,.16,.04,0,-.02,.06);
  box(steering,lamp,.11,.06,.02,0,0,.09);
  // Raised mudguard follows the bars; it leaves daylight above the knobby tyre.
  hull(steering,paint,[[.48,.055,-.27,-.24],[.24,.10,-.23,-.20],[-.02,.09,-.24,-.21],[-.18,.06,-.29,-.26]]);
  batch(steering);
  const wheels = [];
  for(const [z,front] of [[.72,true],[-.73,false]]) {
    const holder = new THREE.Group(); holder.position.set(0,-.2,z); body.add(holder);
    const spin = new THREE.Group(); holder.add(spin);
    // Tyre and rim remain the first two meshes for Garage paint and wheel-profile queries.
    const tyreParts = new THREE.Group(), rimParts = new THREE.Group();
    const width=front?.11:.14;
    mesh(tyreParts,new THREE.LatheGeometry([[.25,-width/2],[.328,-width/2],[.328,width/2],[.25,width/2]].map(p=>new THREE.Vector2(...p)),12).rotateZ(Math.PI/2),black);
    for(let k=0;k<6;k++) {
      const a=k*Math.PI/3;
      const lug=box(tyreParts,black,front?.12:.15,.018,.075,0,.327*Math.cos(a),.327*Math.sin(a));lug.rotation.x=a;
    }
    mesh(rimParts,new THREE.TorusGeometry(.25,.018,3,12).rotateY(Math.PI/2),rim);
    mesh(rimParts,new THREE.CylinderGeometry(.057,.057,.16,6).rotateZ(Math.PI/2),rim);
    for(let k=0;k<5;k++) {
      const a=k*Math.PI*2/5;
      rod(rimParts,rim,[0,.045*Math.cos(a+.4),.045*Math.sin(a+.4)],[0,.25*Math.cos(a),.25*Math.sin(a)],.008,3);
    }
    batch(tyreParts); batch(rimParts); spin.add(...[...tyreParts.children],...[...rimParts.children]);
    const disc = new THREE.Group();
    mesh(disc,new THREE.TorusGeometry(.116,.018,3,10).rotateY(Math.PI/2),metal,.084,0,0); batch(disc);
    lod(spin,disc,new THREE.Group(),38);
    wheels.push({holder,spin,r:.34,front,restY:-.2});
  }
  const rider = new THREE.Group(); rider.position.set(0,.42,-.2); body.add(rider);
  const person = new THREE.Group();
  // Pose authored at syncMesh's resting +.12 rad rider pitch; hands wrap the bar ends, boots sit on pegs.
  const R=(x,y,z)=>new THREE.Vector3(x,y-.42,z+.2).applyAxisAngle(new THREE.Vector3(1,0,0),-.12).toArray();
  for(const s of [-1,1]) {
    rod(person,jersey,R(s*.11,.40,-.25),R(s*.22,.12,.05),.075,5);
    rod(person,black,R(s*.22,.12,.05),R(s*.23,-.14,-.13),.055,5);
    const boot=mesh(person,new THREE.BoxGeometry(.105,.14,.18),black,...R(s*.23,-.13,-.10));boot.rotation.x=-.12;
    rod(person,jersey,R(s*.16,.82,-.05),R(s*.26,.62,.19),.061,5);
    rod(person,jersey,R(s*.26,.62,.19),R(s*.32,.51,.47),.048,5);
    mesh(person,new THREE.IcosahedronGeometry(.056,0),gloves,...R(s*.32,.51,.47));
  }
  hull(person,jersey,[[.13,.17,.06,.47,.19],[-.15,.14,.03,.39,.15]]);
  // Helmet shell, dark goggle opening, protruding peak and full chin protection.
  rod(person,black,R(0,.83,.05),R(0,.95,.08),.055,4);
  const head=mesh(person,new THREE.IcosahedronGeometry(.17,1),helmet,...R(0,1.04,.09));head.scale.set(1,1.08,1.1);
  mesh(person,new THREE.BoxGeometry(.235,.075,.08),black,...R(0,1.04,.245));
  mesh(person,new THREE.BoxGeometry(.19,.045,.025),glass,...R(0,1.045,.291));
  mesh(person,new THREE.BoxGeometry(.24,.025,.21),helmet,...R(0,1.16,.24));
  mesh(person,new THREE.BoxGeometry(.16,.075,.13),helmet,...R(0,.94,.245));
  batch(person); rider.add(person);
  root.userData = {lean,bars,wheels,rider,blob:[.9,2.0],lightMount:body,lights:{
    head:[new THREE.Vector3(0,0,.10)],tail:[new THREE.Vector3(0,.328,-1)],mounts:{head:bars},
    lens:{head:[[[-.055,-.03,.10],[.055,-.03,.10],[.055,.03,.10],[-.055,.03,.10]]],
      tail:[[[-.04,.313,-1],[.04,.313,-1],[.04,.343,-1],[-.04,.343,-1]]]},
    beam:[new THREE.Vector3(0,.42+.1*Math.sin(.45),.5+.1*Math.cos(.45))]}};
  return root;
}
