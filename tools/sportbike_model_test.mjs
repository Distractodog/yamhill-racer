// No world assets: sport-bike paint, animation and original public model contract.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildBikeModel, Bike } from '../game/src/bike.js';
import { buildSportBikeModel } from '../game/src/models/sportbike.js';
import { paintedModel } from '../game/src/cosmetics.js';

const camera=new THREE.PerspectiveCamera();
function stats(model,distance) {
  camera.position.set(0,0,distance);camera.updateMatrixWorld();model.updateMatrixWorld(true);
  model.traverse(o=>{if(o.isLOD)o.update(camera);});
  let triangles=0,calls=0;
  model.traverseVisible(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;calls++;}});
  return {triangles,calls};
}
// Snapshot of the original sport model's exposed keys, mounts, names and wheel order.
const sport=buildSportBikeModel(), u=sport.userData;
assert.equal(sport.name,'bike-sport');
for(const key of ['lean','bars','wheels','rider','lightMount','blob','lights','decalPanels','wheelArch'])assert(key in u,key);
assert.equal(u.lightMount,u.lean.children[0]);assert.equal(u.bars.parent,u.lightMount);
assert.deepEqual(u.bars.position.toArray(),[0,0,.72]);
assert.deepEqual(u.rider.position.toArray(),[0,.40,-.34]);
assert.deepEqual(u.blob,[.95,2.2]);
assert.equal(u.wheels.length,2);assert.equal(u.wheels[0].holder.parent,u.bars);
assert.equal(u.wheels[1].holder.parent,u.lightMount);
assert.deepEqual(u.wheels.map(w=>w.holder.position.toArray()),[[0,-.2,0],[0,-.2,-.73]]);
for(const [i,w] of u.wheels.entries()) {
  for(const key of ['holder','spin','restY','r','front'])assert(key in w,key);
  assert.equal(w.restY,-.2);assert.equal(w.r,.34);assert.equal(w.front,i===0);
  assert.equal(w.spin.parent,w.holder);assert(w.spin.children[0].isMesh&&w.spin.children[1].isMesh);
  assert.equal(w.spin.children[1].material.userData.cosmeticRole,'wheels');
  assert(w.holder.getObjectByName('brake-caliper'));
}
assert(sport.getObjectByName('handlebars'));assert(sport.getObjectByName('rider-head'));
for(const key of ['head','tail','lens'])assert(key in u.lights);
assert.equal(u.lights.head.length,2);assert.equal(u.lights.tail.length,1);
assert.deepEqual(u.lights.tail[0].toArray(),[0,.458,-1.048]);
assert.equal(u.lights.lens.head.length,2);assert.equal(u.lights.lens.tail.length,1);
assert.deepEqual(u.decalPanels,[[.26,.14,.316,.14,.04,0,Math.PI/2],[.26,.14,-.316,.14,.04,0,-Math.PI/2]]);
assert(u.wheelArch.every(Number.isFinite));
const before=3928,near=stats(sport,3),far=stats(sport,200);
assert(near.triangles<=before*2.5,`triangle budget ${near.triangles}/${before}`);
assert(far.triangles<near.triangles*.6,'far LOD budget');
const palette={body:'#3388cc',trim:'#ededdd',wheels:'#ffcc44',helmet:'#bb3344',jacket:'#449955',gloves:'#aabbcc'};
const roles=new Set();
paintedModel('bike',palette,'sport').traverse(o=>{
  const role=o.material?.userData.cosmeticRole;
  if(role){roles.add(role);assert(o.material.color.equals(new THREE.Color(palette[role])),role);}
});
assert.deepEqual([...roles].sort(),Object.keys(palette).sort());
const pose={mesh:sport,renderPos:new THREE.Vector3(),renderQuat:new THREE.Quaternion(),t:{travel:.32},
  steer:.5,lean:.3,pitchRate:0,wheels:u.wheels.map(()=>({contact:true,comp:.12,spin:1.4}))};
Bike.prototype.syncMesh.call(pose,1/60);
assert.equal(u.bars.rotation.y,-.225);assert.equal(u.lean.rotation.z,.3);
u.wheels.forEach(w=>assert.equal(w.spin.rotation.x,1.4));
console.log(JSON.stringify({type:'sport',before,near,far,ratio:near.triangles/before}));
const dirt=buildBikeModel();console.log(JSON.stringify({type:'dirt (unchanged)',near:stats(dirt,3),far:stats(dirt,200)}));
console.log('PASS sport model contract, named anchors, paint, animation and triangle budget');
