// Fully faired road bike with a tucked rider. Suspension/lean/bars use Bike.syncMesh's contract.
import * as THREE from 'three';
import { measureWheelArch } from '../wheeltravel.js';
import { material, mesh, box, rod, hull, lod, wheel } from './truckbikeparts.js';

export function buildSportBikeModel() {
  const root = new THREE.Group(); root.name = 'bike-sport';
  const lean = new THREE.Group(); lean.position.y = -.54; root.add(lean);
  const body = new THREE.Group(); body.position.y = .54; lean.add(body);
  const paint = material('#ff7a1a','body'), trim = material('#f2f2ee','trim'), rim = material('#8a9099','wheels');
  const rubber = material('#1d1e22'), black = material('#20252c'), metal = material('#727e88'), glass = material('#273f50');
  const gold = material('#bfa05b'), lamp = material('#fff0d1'), tail = material('#c52337');
  const jacket = material('#f2f2ee','jacket'), gloves = material('#1d1f24','gloves'), helmet = material('#ff7a1a','helmet');
  function fairing(detail) {
    const group = new THREE.Group();
    // Angular belly pan, shoulder panels and a pointed nose leave the front tyre's swept space clear.
    hull(group,paint,[[.34,.20,-.24,.28,.28],[.17,.29,-.25,.39,.31],[-.27,.25,-.23,.27,.24],[-.36,.12,-.12,.19,.16]]);
    hull(group,paint,[[1.00,.10,.40,.49,.14],[.81,.25,.34,.58,.24],[.44,.33,.28,.54,.27],[.25,.29,.15,.36,.25]]);
    // Faceted windscreen slopes back above the twin recessed headlights.
    hull(group,glass,[[.91,.14,.49,.51,.14],[.60,.21,.52,.76,.17],[.40,.20,.52,.73,.16]]);
    // Fuel tank: broad shoulders above a narrow knee cut-out.
    hull(group,paint,[[.35,.18,.29,.48,.18],[.12,.245,.25,.57,.19],[-.12,.23,.24,.53,.18],[-.33,.14,.25,.35,.12]]);
    box(group,black,.30,.075,.38,0,.34,-.43,-.06);
    hull(group,paint,[[-.56,.18,.31,.39,.16],[-.78,.17,.36,.46,.13],[-1.02,.065,.43,.49,.055]]);
    box(group,black,.23,.035,.20,0,.467,-.78,-.12); // pillion pad
    box(group,tail,.16,.04,.026,0,.458,-1.035);
    for (const s of [-1,1]) {
      const eye=box(group,black,.17,.095,.03,s*.15,.433,.929); eye.rotation.z=s*.16;
      const lens=box(group,lamp,.125,.038,.035,s*.15,.447,.950); lens.rotation.z=s*.16;
      // Side graphics and intake ducts sit on the broad fairing flank, below the rider's knees.
      const stripe=box(group,trim,.025,.085,.39,s*.298,.13,.04,.32); stripe.rotation.z=-s*.12;
      box(group,black,.025,.10,.19,s*.313,.31,.17,-.22);
      rod(group,metal,[s*.16,.20,.28],[s*.17,.12,-.43],.038);
      // Twin-sided alloy swingarm, rear hub to frame pivot.
      rod(group,metal,[s*.13,-.18,-.73],[s*.13,-.09,-.22],.045);
      rod(group,black,[s*.12,.13,-.30],[s*.13,-.12,-.63],.027);
      box(group,metal,.12,.025,.06,s*.23,-.14,-.30); // rearsets
      if (detail) {
        rod(group,black,[s*.21,.52,.58],[s*.40,.60,.63],.018);
        box(group,black,.12,.065,.065,s*.42,.60,.63);
        box(group,glass,.105,.045,.012,s*.42,.603,.592);
        rod(group,trim,[s*.30,.24,.24],[s*.26,-.10,-.14],.016);
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
      rod(group,gold,[0,.18,-.24],[0,-.08,-.35],.035);
      box(group,black,.028,.035,.54,.16,-.12,-.48); // chain run
      box(group,black,.16,.065,.025,0,.48,.42,-.40); // instrument binnacle
      box(group,glass,.12,.035,.027,0,.50,.407,-.40);
    }
    return group;
  }
  lod(body,fairing(true),fairing(false),38);
  // Steering axis passes through the front hub. The wheel, fender and lower fork steer together;
  // syncMesh sets holder.y directly to the suspension drop, so no second y offset is baked in.
  const bars = new THREE.Group(); bars.position.z = .72; body.add(bars);
  const wheels = [wheel(bars,rubber,rim,{y:-.2,z:0,r:.34,width:.12,front:true,sport:true}),
    wheel(body,rubber,rim,{y:-.2,z:-.73,r:.34,width:.18,front:false,sport:true})];
  const forkNear = new THREE.Group(), forkFar = new THREE.Group();
  function upperFork(group, detail) {
    for (const s of [-1,1]) {
      rod(group,gold,[s*.095,.10,-.07],[s*.095,.47,-.23],.025);
      rod(group,black,[s*.09,.42,-.22],[s*.28,.40,-.26],.021);
      rod(group,gloves,[s*.23,.40,-.26],[s*.32,.40,-.29],.027);
      if (detail) rod(group,metal,[s*.25,.405,-.31],[s*.34,.405,-.34],.009);
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
    for (const s of [-1,1]) {
      const width = w.front ? .075 : .105;
      mesh(near,new THREE.CylinderGeometry(.156,.156,.008,12).rotateZ(Math.PI/2),black,s*width,0,0);
      mesh(near,new THREE.TorusGeometry(.218,.013,3,16).rotateY(Math.PI/2),rim,s*width,0,0);
      for (let i=0;i<5;i++) {
        const a=i*Math.PI*2/5;
        rod(near,rim,[s*(width+.005),0,0],[s*(width+.005),.22*Math.cos(a),.22*Math.sin(a)],.018,4);
      }
      mesh(near,new THREE.TorusGeometry(.145,.018,3,12).rotateY(Math.PI/2),metal,s*(width+.015),0,0);
    }
    lod(w.spin,near,far,38);
    const caliper=box(w.holder,gold,.055,.095,.045,.105,.10,-.12); caliper.name='brake-caliper';
  }
  const rider = new THREE.Group(); rider.position.set(0,.40,-.34); body.add(rider);
  function riderParts(detail) {
    const group = new THREE.Group();
    // Low racing tuck: hips over the seat, chest over the tank, elbows bent to the clip-ons.
    hull(group,jacket,[[.40,.19,.20,.37,.17],[.17,.19,.05,.27,.18],[-.07,.14,-.04,.15,.14]]);
    box(group,black,.28,.12,.19,0,.0,-.01);
    for (const s of [-1,1]) {
      rod(group,jacket,[s*.12,.04,.00],[s*.235,-.16,.21],.079,6);
      rod(group,black,[s*.235,-.16,.21],[s*.20,-.47,.00],.056,6);
      box(group,black,.115,.10,.21,s*.20,-.51,.035,.10);
      rod(group,jacket,[s*.19,.28,.33],[s*.29,.12,.36],.057,6);
      rod(group,jacket,[s*.29,.12,.36],[s*.29,.005,.78],.047,6);
      box(group,gloves,.10,.08,.115,s*.29,.005,.78);
      if (detail) {
        mesh(group,new THREE.IcosahedronGeometry(.062,0),black,s*.29,.12,.36);
        box(group,trim,.025,.08,.13,s*.295,-.16,.20,.32); // knee sliders
      }
    }
    // Helmet, dark wraparound visor and chin bar remain separate paint roles at both LODs.
    const head=mesh(group,new THREE.IcosahedronGeometry(.175,detail?1:0),helmet,0,.395,.53); head.scale.set(1,1.05,1.15);
    hull(group,glass,[[.728,.09,.36,.44,.105],[.675,.15,.34,.46,.15],[.61,.16,.35,.46,.16]]);
    box(group,helmet,.20,.075,.12,0,.315,.655,.16);
    if (detail) {
      rod(group,black,[-.12,.37,.25],[.12,.37,.25],.035); // aerodynamic back hump
      box(group,black,.085,.025,.015,0,.326,.724);
      box(group,trim,.07,.025,.18,0,.566,.50,.08);
    }
    return group;
  }
  lod(rider,riderParts(true),riderParts(false),38);
  root.userData = { lean, bars, wheels, rider, lightMount: body, blob: [.95,2.2],
    lights: { head: [-1,1].map(s=>new THREE.Vector3(s*.15,.447,.978)), tail: [new THREE.Vector3(0,.458,-1.06)] },
    decalPanels: [[.26,.14,.316,.14,.04,0,Math.PI/2],[.26,.14,-.316,.14,.04,0,-Math.PI/2]],
  };
  // tyre-top ceiling per wheel from the real body above it (wheeltravel.js); the front mudguard travels with its wheel
  root.userData.wheelArch = measureWheelArch(root);
  return root;
}
