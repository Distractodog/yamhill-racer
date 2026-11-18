// Fully faired road bike with a tucked rider. Suspension/lean/bars use Bike.syncMesh's contract.
import * as THREE from 'three';
import { measureWheelArch } from '../wheeltravel.js';
import { material, mesh, box, hull, sideShape, batch, lod, wheel } from './truckbikeparts.js';

// Open-ended tubing: every end meets a bracket or another tube.
function rod(parent, mat, a, b, radius, segments = 6) {
  const start = new THREE.Vector3(...a), delta = new THREE.Vector3(...b).sub(start);
  const part = mesh(parent, new THREE.CylinderGeometry(radius,radius,delta.length(),segments,1,true),mat);
  part.position.copy(start).addScaledVector(delta,.5);
  part.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());
  return part;
}
// Eight-sided sections round the shoulders and lower edges without smoothing away the facets.
// Cross sections retain hull's [z, halfWidth, bottom, top, topHalfWidth] convention.
function shell(parent, mat, sections) {
  const rings = sections.map(([z,w,b,t,tw=w*.65]) => [
    [-w*.65,b,z],[w*.65,b,z],[w,b+(t-b)*.22,z],[w,b+(t-b)*.65,z],
    [tw,t,z],[-tw,t,z],[-w,b+(t-b)*.65,z],[-w,b+(t-b)*.22,z],
  ]), points=[];
  const tri=(a,b,c)=>points.push(...a,...b,...c);
  for(let j=1;j<rings.length;j++)for(let i=0;i<8;i++) {
    const k=(i+1)%8, a=rings[j-1], b=rings[j];
    tri(a[i],b[i],b[k]);tri(a[i],b[k],a[k]);
  }
  for(let i=1;i<7;i++) {
    tri(rings[0][0],rings[0][i],rings[0][i+1]);
    const r=rings.at(-1);tri(r[0],r[i+1],r[i]);
  }
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.Float32BufferAttribute(points,3));geometry.computeVertexNormals();
  return mesh(parent,geometry,mat);
}

export function buildSportBikeModel() {
  const root = new THREE.Group(); root.name = 'bike-sport';
  const lean = new THREE.Group(); lean.position.y = -.54; root.add(lean);
  const body = new THREE.Group(); body.position.y = .54; lean.add(body);
  const paint = material('#ff7a1a','body'), trim = material('#f2f2ee','trim'), rim = material('#8a9099','wheels');
  const rubber = material('#1d1e22'), black = material('#20252c'), metal = material('#727e88'), glass = material('#273f50');
  const darkMetal = material('#39414a'), disc = material('#9ba4aa'), seat = material('#11151b');
  const gold = material('#bfa05b'), lamp = material('#fff0d1'), tail = material('#c52337');
  const jacket = material('#f2f2ee','jacket'), gloves = material('#1d1f24','gloves'), helmet = material('#ff7a1a','helmet');
  function fairing(detail) {
    const group = new THREE.Group();
    // Angular belly pan, shoulder panels and a pointed nose leave the front tyre's swept space clear.
    shell(group,paint,[[.34,.20,-.24,.28,.19],[.17,.315,-.25,.39,.25],[-.15,.30,-.24,.30,.24],[-.32,.20,-.18,.21,.15],[-.36,.12,-.12,.19,.10]]);
    shell(group,black,[[.30,.14,-.255,-.20,.13],[-.08,.21,-.26,-.205,.18],[-.35,.12,-.19,-.14,.10]]);
    shell(group,paint,[[1.00,.10,.40,.49,.08],[.88,.22,.35,.54,.16],[.70,.29,.31,.60,.22],[.44,.33,.28,.54,.27],[.25,.29,.15,.36,.25]]);
    // Split nose intake and a black chin spoiler below the lamps.
    hull(group,black,[[1.008,.045,.395,.43,.035],[.90,.067,.36,.43,.055]]);
    hull(group,black,[[.98,.12,.37,.39,.11],[.78,.24,.30,.33,.21]]);
    // Faceted windscreen slopes back above the twin recessed headlights.
    hull(group,glass,[[.91,.14,.49,.51,.14],[.60,.21,.52,.76,.17],[.40,.20,.52,.73,.16]]);
    // Fuel tank: broad shoulders above a narrow knee cut-out.
    shell(group,paint,[[.35,.16,.29,.47,.10],[.12,.245,.25,.57,.14],[-.12,.23,.24,.53,.14],[-.33,.14,.25,.35,.09]]);
    shell(group,seat,[[-.27,.115,.325,.38,.10],[-.45,.155,.32,.39,.14],[-.63,.14,.35,.41,.12]]);
    shell(group,paint,[[-.56,.18,.31,.39,.12],[-.78,.17,.36,.46,.11],[-1.02,.065,.43,.49,.045]]);
    box(group,black,.23,.035,.20,0,.467,-.78,-.12); // pillion pad
    box(group,tail,.16,.04,.026,0,.458,-1.035);
    for (const s of [-1,1]) {
      const eye=box(group,black,.17,.095,.03,s*.15,.433,.929); eye.rotation.z=s*.16;
      const lens=box(group,lamp,.125,.038,.035,s*.15,.447,.950); lens.rotation.z=s*.16;
      // Side graphics and intake ducts sit on the broad fairing flank, below the rider's knees.
      const stripe=box(group,trim,.025,.085,.39,s*.298,.13,.04,.32); stripe.rotation.z=-s*.12;
      sideShape(group,black,[[.31,.24],[.16,.32],[-.05,.24],[.10,.20]],s>0?.316:-.325,.009);
      // Cast aluminium frame spars show through the knee cutouts.
      rod(group,darkMetal,[s*.15,.30,.39],[s*.20,.22,-.22],.037,4);
      sideShape(group,metal,[[.03,.23],[-.27,.19],[-.33,-.10],[-.21,-.13]],s>0?.20:-.225,.025);
      rod(group,metal,[s*.16,.20,.28],[s*.17,.12,-.43],.038);
      // Twin-sided alloy swingarm, rear hub to frame pivot.
      sideShape(group,metal,[[-.76,-.23],[-.76,-.15],[-.27,-.025],[-.21,-.09]],s>0?.12:-.16,.04);
      mesh(group,new THREE.CylinderGeometry(.043,.043,.014,8).rotateZ(Math.PI/2),darkMetal,s*.232,-.055,-.245);
      rod(group,black,[s*.12,.13,-.30],[s*.13,-.12,-.63],.027);
      // rear-set pegs on short brackets, outside the fairing where the rider's boots stand
      rod(group,metal,[s*.22,-.12,-.30],[s*.34,-.13,-.27],.018);
      box(group,metal,.12,.025,.06,s*.38,-.14,-.27);
      if (detail) {
        rod(group,black,[s*.21,.52,.58],[s*.40,.60,.63],.018);
        box(group,black,.12,.065,.065,s*.42,.60,.63);
        box(group,glass,.105,.045,.012,s*.42,.603,.592);
        // Recessed cooling gills and a small tail vent follow the panel outline.
        for(let i=0;i<3;i++)sideShape(group,darkMetal,[[.22-i*.057,.265],[.20-i*.057,.27],[.13-i*.057,.22],[.15-i*.057,.215]],s>0?.327:-.335,.008);
        sideShape(group,black,[[-.67,.37],[-.85,.405],[-.88,.43],[-.70,.40]],s>0?.143:-.151,.008);
        rod(group,metal,[s*.35,-.12,-.26],[s*.36,-.09,-.16],.008,4);
      }
    }
    // Visible engine and side exhaust on the right, tucked below the tail.
    mesh(group,new THREE.CylinderGeometry(.135,.135,.30,8).rotateZ(Math.PI/2),metal,0,-.055,-.06);
    rod(group,metal,[-.17,-.10,.06],[-.27,-.19,-.38],.028);
    rod(group,black,[-.27,-.17,-.34],[-.29,-.04,-.77],.075,8);
    rod(group,metal,[-.29,-.04,-.73],[-.30,-.015,-.82],.061,8);
    rod(group,black,[-.30,-.015,-.81],[-.305,-.005,-.84],.043,8);
    if (detail) {
      mesh(group,new THREE.CylinderGeometry(.055,.055,.012,10),metal,0,.574,.08);
      rod(group,gold,[0,.18,-.24],[0,-.08,-.35],.025);
      for(let i=0;i<5;i++)mesh(group,new THREE.TorusGeometry(.041,.008,3,8).rotateX(-.40),tail,0,.13-i*.033,-.26-i*.014);
      mesh(group,new THREE.CylinderGeometry(.082,.082,.018,10).rotateZ(Math.PI/2),darkMetal,-.16,-.055,-.06);
      for(let i=0;i<3;i++)box(group,metal,.018,.014,.11,-.175,-.025+i*.025,.08);
      box(group,black,.028,.035,.54,.16,-.12,-.48); // chain run
      box(group,black,.16,.065,.025,0,.48,.42,-.40); // instrument binnacle
      box(group,glass,.12,.035,.027,0,.50,.407,-.40);
    }
    return group;
  }
  lod(body,fairing(true),fairing(false),38);
  // Steering axis passes through the front hub. The wheel, fender and lower fork steer together;
  // syncMesh sets holder.y directly to the suspension drop, so no second y offset is baked in.
  const bars = new THREE.Group(); bars.name='handlebars'; bars.position.z = .72; body.add(bars);
  const wheels = [wheel(bars,rubber,rim,{y:-.2,z:0,r:.34,width:.12,front:true,sport:true}),
    wheel(body,rubber,rim,{y:-.2,z:-.73,r:.34,width:.18,front:false,sport:true})];
  const forkNear = new THREE.Group(), forkFar = new THREE.Group();
  function upperFork(group, detail) {
    for (const s of [-1,1]) {
      rod(group,gold,[s*.095,.10,-.07],[s*.095,.47,-.23],.025);
      // Clip-on bars leave the fairing sides and sit above them, where the rider's gloved hands wrap the grips.
      rod(group,black,[s*.09,.42,-.22],[s*.33,.52,-.24],.021);
      rod(group,gloves,[s*.31,.52,-.24],[s*.43,.52,-.24],.03);
      if (detail) {
        rod(group,metal,[s*.30,.535,-.29],[s*.43,.535,-.31],.009,4);
        box(group,black,.055,.045,.065,s*.26,.55,-.24);
        rod(group,black,[s*.12,.36,-.18],[s*.14,.08,-.04],.007,4);
      }
    }
    box(group,metal,.24,.035,.10,0,.39,-.20);
  }
  upperFork(forkNear,true); upperFork(forkFar,false); lod(bars,forkNear,forkFar,38);
  const lowerNear = new THREE.Group(), lowerFar = new THREE.Group();
  function lowerFork(group) {
    for (const s of [-1,1]) rod(group,metal,[s*.095,0,0],[s*.095,.35,-.145],.019);
    hull(group,paint,[[.25,.065,.29,.32],[.10,.085,.37,.40],[-.12,.085,.36,.39],[-.26,.06,.28,.31]]);
  }
  lowerFork(lowerNear); lowerFork(lowerFar); lod(wheels[0].holder,lowerNear,lowerFar,38);
  for (const w of wheels) {
    const near = new THREE.Group(), far = new THREE.Group();
    // A genuinely open five-spoke casting, rather than spokes laid on an opaque disc.
    // Keep spin.children[1] as a single Garage wheel-role mesh.
    const casting = new THREE.Group(), width=w.front?.075:.105;
    const tyreWidth=w.front?.12:.18;
    // Preserve the contact crown and outer dimensions; thin sidewalls expose the alloy rim.
    const profile=[[.235,-tyreWidth/2],[.34*.84,-tyreWidth/2],[.34,-tyreWidth*.24],
      [.34,tyreWidth*.24],[.34*.84,tyreWidth/2],[.235,tyreWidth/2]];
    w.spin.children[0].geometry.dispose();
    w.spin.children[0].geometry=new THREE.LatheGeometry(profile.map(p=>new THREE.Vector2(...p)),16).rotateZ(Math.PI/2);
    for(const s of [-1,1])mesh(casting,new THREE.TorusGeometry(.225,.012,4,16).rotateY(Math.PI/2),rim,s*(tyreWidth/2-.012),0,0);
    mesh(casting,new THREE.CylinderGeometry(.221,.221,tyreWidth-.024,16,1,true).rotateZ(Math.PI/2),rim);
    mesh(casting,new THREE.CylinderGeometry(.05,.05,width*2,8).rotateZ(Math.PI/2),rim);
    for(let i=0;i<5;i++) {
      const a=i*Math.PI*2/5;
      rod(casting,rim,[0,.045*Math.cos(a+.35),.045*Math.sin(a+.35)],
        [0,.225*Math.cos(a),.225*Math.sin(a)],.022,4);
    }
    batch(casting);
    w.spin.children[1].geometry.dispose();
    w.spin.children[1].geometry=casting.children[0].geometry;
    for(const s of (w.front?[-1,1]:[1])) {
      mesh(near,new THREE.TorusGeometry(.149,.027,3,16).rotateY(Math.PI/2),disc,s*width,0,0);
      mesh(near,new THREE.TorusGeometry(.092,.009,3,10).rotateY(Math.PI/2),darkMetal,s*width,0,0);
      for(let i=0;i<5;i++) {
        const a=i*Math.PI*2/5;
        rod(near,darkMetal,[s*width,.05*Math.cos(a),.05*Math.sin(a)],
          [s*width,.13*Math.cos(a+.2),.13*Math.sin(a+.2)],.01,4);
      }
    }
    lod(w.spin,near,far,38);
    const caliper=box(w.holder,gold,.055,.095,.045,.105,.10,-.12); caliper.name='brake-caliper';
  }
  const rider = new THREE.Group(); rider.name='rider'; rider.position.set(0,.40,-.34); body.add(rider);
  function riderParts(detail) {
    const group = new THREE.Group();
    // Authored in the body's frame (R / H convert to the rider group's origin). Bike.syncMesh pitches the rider by +.12
    // rad at rest, so the parts are turned back by that much: at rest the pose below is exactly what is drawn.
    const R = (x, y, z) => [x, y - .40, z + .34], H = sections => sections.map(([z, w, b, t, tw]) => [z + .34, w, b - .40, t - .40, tw]);
    const ball = (m, r, x, y, z) => mesh(group, new THREE.IcosahedronGeometry(r, detail ? 1 : 0), m, ...R(x, y, z));
    const limb = (m, a, b, r) => rod(group, m, R(...a), R(...b), r, 7);
    // Low racing tuck: chest flat on the tank behind the screen, hips on the seat, back sloping up to the shoulders.
    shell(group, jacket, H([[.12,.19,.60,.80,.13],[-.12,.18,.56,.78,.12],[-.34,.16,.50,.70,.11],[-.52,.14,.43,.60,.10]]));
    box(group, black, .30, .13, .22, ...R(0, .46, -.46));
    for (const s of [-1, 1]) {
      // legs stay outside the tank and fairing: thighs hug the tank sides, knees against it, boots on the pegs
      ball(black, .085, s * .13, .47, -.46);
      limb(black, [s * .13, .47, -.46], [s * .27, .39, -.27], .08);
      limb(black, [s * .27, .39, -.27], [s * .36, .25, .04], .077);
      ball(black, .08, s * .36, .25, .04);
      limb(black, [s * .36, .25, .04], [s * .37, -.01, -.31], .062);
      box(group, black, .11, .09, .27, ...R(s * .38, -.065, -.19));          // boot, ball of the foot on the peg
      // shoulder, upper arm down and out, forearm forward to the glove on the grip
      ball(jacket, .09, s * .20, .72, .03);
      limb(jacket, [s * .20, .72, .03], [s * .35, .58, .27], .068);
      ball(jacket, .068, s * .35, .58, .27);
      limb(jacket, [s * .35, .58, .27], [s * .37, .55, .47], .056);
      box(group, gloves, .10, .085, .13, ...R(s * .37, .545, .49));
      if (detail) {
        box(group, trim, .025, .08, .13, ...R(s * .435, .25, .04)); // knee slider
        ball(black,.065,s*.255,.72,.04); // shoulder armour
        box(group,trim,.018,.045,.18,...R(s*.071,.66,-.22),-.18); // suit seam
        box(group,trim,.114,.025,.09,...R(s*.38,-.015,-.16)); // boot reinforcement
      }
    }
    // Helmet, dark wraparound visor and chin bar remain separate paint roles at both LODs.
    const head = ball(helmet, .175, 0, .80, .20); head.scale.set(1, 1.05, 1.15);
    // A stable named head anchor survives the static mesh batching in lod().
    const headAnchor=new THREE.Group();headAnchor.name='rider-head';headAnchor.position.copy(head.position);
    head.position.set(0,0,0);headAnchor.add(head);group.add(headAnchor);
    hull(group, glass, H([[.388,.09,.76,.84,.105],[.335,.15,.74,.86,.15],[.27,.16,.75,.86,.16]]));
    box(group, helmet, .20, .075, .12, ...R(0, .715, .315), .16);
    if (detail) {
      // Visor pivots sit on the shell; a flat crown stripe would float above its facets.
      for(const s of [-1,1]) {
        mesh(group,new THREE.CylinderGeometry(.018,.018,.012,6).rotateZ(Math.PI/2),trim,...R(s*.172,.805,.22));
        box(group,black,.035,.018,.055,...R(s*.07,.916,.29),-.3);
      }
      shell(group,black,H([[-.05,.10,.77,.83,.06],[-.30,.09,.71,.77,.05]])); // aero hump
    }
    group.rotation.x = -.12;
    return group;
  }
  lod(rider,riderParts(true),riderParts(false),38);
  // lit lenses (lights.js) on the faces of the twin headlight boxes, tilted like them, over the outer part the nose
  // fairing leaves showing (u = along the box, outward for s*u > 0), and on the tail-lamp box
  const onLamp = (s,u,v) => { const a = s*.16; return [s*.15 + u*Math.cos(a) - v*Math.sin(a), .447 + u*Math.sin(a) + v*Math.cos(a), .9675]; };
  const showing = s => [[-.015,-1],[.0625,-1],[.0625,1],[-.015,1]].map(([u,v]) => onLamp(s,s*u,v*.019));
  root.userData = { lean, bars, wheels, rider, lightMount: body, blob: [.95,2.2],
    lights: { head: [-1,1].map(s=>new THREE.Vector3(...onLamp(s,s*.024,0))), tail: [new THREE.Vector3(0,.458,-1.048)],
      lens: { head: [-1,1].map(showing), tail: [[[-.08,.438,-1.048],[.08,.438,-1.048],[.08,.478,-1.048],[-.08,.478,-1.048]]] } },
    decalPanels: [[.26,.14,.316,.14,.04,0,Math.PI/2],[.26,.14,-.316,.14,.04,0,-Math.PI/2]],
  };
  // tyre-top ceiling per wheel from the real body above it (wheeltravel.js); the front mudguard travels with its wheel
  root.userData.wheelArch = measureWheelArch(root);
  return root;
}
