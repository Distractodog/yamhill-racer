// Small geometry/animation contract check; no world assets, browser or physics simulation.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildVehicleTypeModel, typeInfo } from '../game/src/vehicletypes.js';
import { paintedModel, disposeCosmeticPreview } from '../game/src/cosmetics.js';
import { bakeParts } from '../game/src/mp/remotes.js';
import { Car } from '../game/src/car.js';
import { Bike } from '../game/src/bike.js';

const camera = new THREE.PerspectiveCamera(), ray = new THREE.Raycaster();
function stats(model, distance) {
  camera.position.set(0,0,distance); camera.updateMatrixWorld(); model.updateMatrixWorld(true);
  model.traverse(o=>{ if(o.isLOD)o.update(camera); });
  let triangles=0, calls=0;
  model.traverseVisible(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count ?? o.geometry.attributes.position.count)/3; calls++;}});
  return {triangles,calls};
}
const palette={body:'#126ba5',trim:'#cad142',wheels:'#be8c43',jacket:'#6f39a4',helmet:'#cb3951',gloves:'#268d57'};
for(const [kind,type,limits] of [['car','truck',[[3,3.5],[2.7,3.3],[5.3,5.9]]],['bike','sport',[[.7,1.1],[1.3,1.7],[2,2.3]]]]) {
  const model=buildVehicleTypeModel(kind,type), ud=model.userData;
  const near=stats(model,5), far=stats(model,200);
  assert(near.triangles<=6000,`${type} near budget: ${near.triangles}`);
  assert(far.triangles<near.triangles*.60,`${type} far version too expensive`);
  const bounds=new THREE.Box3().setFromObject(model), size=bounds.getSize(new THREE.Vector3()).toArray();
  size.forEach((v,i)=>assert(v>=limits[i][0]&&v<=limits[i][1],`${type} dimension ${i}: ${v}`));
  const roles=new Set();
  model.traverse(o=>{
    if(o.geometry) {
      for(const [name,a]of Object.entries(o.geometry.attributes)) assert([...a.array].every(Number.isFinite),`${type} nonfinite ${name}`);
      const pos=o.geometry.attributes.position, idx=o.geometry.index;
      for(let i=0;i<(idx?.count||pos.count);i+=3){
        const points=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(pos,idx?idx.getX(i+k):i+k));
        assert(points[1].sub(points[0]).cross(points[2].sub(points[0])).lengthSq()>1e-16,`${type} degenerate triangle`);
      }
    }
    if(o.material?.userData.cosmeticRole)roles.add(o.material.userData.cosmeticRole);
  });
  for(const role of kind==='car'?['body','trim','wheels']:Object.keys(palette))assert(roles.has(role),`${type}: ${role}`);
  assert.equal(ud.wheelArch.length,ud.wheels.length);
  for(const w of ud.wheels){assert(w.spin.children[0].isMesh&&w.spin.children[1].isMesh);assert(w.r>0);}
  stats(model,5); model.updateMatrixWorld(true);
  // Probe the actual arch surfaces at the wheel centre plane across the tyre's upper semicircle.
  // The moving front mudguard is checked separately; it does not limit suspension travel.
  const shell=kind==='car'?ud.bodyPivot:ud.lean.children[0].children.find(o=>o.isLOD);
  const solid=[];shell.traverseVisible(o=>{if(o.isMesh)solid.push(o);});
  for(const [i,w] of ud.wheels.entries()) {
    const hub=w.holder.getWorldPosition(new THREE.Vector3());
    const radius=kind==='car'?.63:w.r;
    let minGap=Infinity;
    for(let j=-8;j<=8;j++){
      const dz=radius*j/9, y=Math.sqrt(radius*radius-dz*dz);
      ray.set(hub.clone().add(new THREE.Vector3(0,0,dz)),new THREE.Vector3(0,1,0));
      const hit=ray.intersectObjects(solid,false)[0];
      if(hit){const gap=hit.distance-y;minGap=Math.min(minGap,gap);assert(gap>=ud.wheelArch[i]-.005,`${type} wheel ${i} arch gap ${gap} at dz ${dz}`);}
    }
    assert(Number.isFinite(minGap),`${type} wheel ${i}: arch probe missed`);
    if(kind==='car')assert(Math.abs(hub.x)+.24<1.62,'truck tyre outside flare');
  }
  for(const role of ['head','tail'])for(const anchor of ud.lights[role])assert(anchor.isVector3&&anchor.toArray().every(Number.isFinite));
  if(kind==='bike') {
    const front=ud.wheels[0], fender=front.holder.children.find(o=>o.isLOD), parts=[];
    fender.traverseVisible(o=>{if(o.isMesh)parts.push(o);});
    const hub=front.holder.getWorldPosition(new THREE.Vector3());
    for(const dz of [-.1,0,.1]) {
      ray.set(hub.clone().add(new THREE.Vector3(0,0,dz)),new THREE.Vector3(0,1,0));
      const hit=ray.intersectObjects(parts,false)[0];
      assert(hit&&hit.distance-Math.sqrt(front.r*front.r-dz*dz)>.015,'sport mudguard clips tyre');
    }
  }
  // Exercise the actual animation functions used by players and remote stand-ins, without stepping physics.
  const spec=typeInfo(kind,type), pose={mesh:model,renderPos:new THREE.Vector3(),renderQuat:new THREE.Quaternion(),
    typePhysics:spec.physics,t:{...spec.tuning,steerLock:.6},latAcc:2,lonAcc:1,steer:.5,lean:.3,pitchRate:0,
    wheels:ud.wheels.map(w=>({contact:true,comp:.12,spin:1.4,front:w.front}))};
  (kind==='car'?Car:Bike).prototype.syncMesh.call(pose,1/60);
  ud.wheels.forEach(w=>assert.equal(w.spin.rotation.x,1.4));
  if(kind==='bike') {assert.equal(ud.bars.rotation.y,-.225);assert.equal(ud.lean.rotation.z,.3);assert.equal(ud.wheels[0].holder.parent,ud.bars);}
  const painted=paintedModel(kind,palette,type);
  painted.traverse(o=>{const role=o.material?.userData.cosmeticRole;if(role)assert(o.material.color.equals(new THREE.Color(palette[role])),`${type} paint ${role}`);});
  bakeParts(painted); // Multiplayer bakes material colours while preserving every animated group and LOD.
  const remotePose={...pose,mesh:painted};
  (kind==='car'?Car:Bike).prototype.syncMesh.call(remotePose,1/60);
  assert(stats(painted,200).triangles<stats(painted,5).triangles*.60);
  console.log(JSON.stringify({type,near,far,size:size.map(v=>+v.toFixed(3)),paintRoles:[...roles],archTravel:ud.wheelArch}));
  disposeCosmeticPreview(model);disposeCosmeticPreview(painted);
}
console.log('PASS: finite nondegenerate geometry, budgets, dimensions, arch clearance, paint, lights and local/remote animation.');
