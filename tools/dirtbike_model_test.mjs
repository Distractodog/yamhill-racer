// Geometry/animation contract and original-model triangle budgets, without world assets.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {buildBikeModel, Bike} from '../game/src/bike.js';
import {buildSportBikeModel} from '../game/src/models/sportbike.js';
import {paintedModel} from '../game/src/cosmetics.js';
const camera=new THREE.PerspectiveCamera();
function stats(m,d){camera.position.set(0,0,d);camera.updateMatrixWorld();m.updateMatrixWorld(true);m.traverse(o=>{if(o.isLOD)o.update(camera);});let triangles=0,calls=0;m.traverseVisible(o=>{if(o.isMesh){triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;calls++;}});return {triangles,calls};}
for(const [type,build,before] of [['dirt',buildBikeModel,648],['sport',buildSportBikeModel,3928]]) {
  const m=build(),u=m.userData,near=stats(m,3),far=stats(m,200);
  for(const k of ['lean','bars','wheels','rider','blob','lightMount','lights'])assert(k in u,`${type}: missing ${k}`);
  for(const k of (type==='dirt'?['head','tail','mounts','lens','beam']:['head','tail','lens']))assert(k in u.lights,`${type}: missing lights.${k}`);
  assert(u.lean.isGroup&&u.bars.isGroup&&u.rider.isGroup&&u.lightMount.isGroup);
  if(type==='sport')for(const k of ['decalPanels','wheelArch'])assert(k in u);
  for(const role of ['head','tail']){assert(Array.isArray(u.lights.lens[role]));assert(u.lights[role].every(v=>v.isVector3));}
  if(type==='dirt')assert.equal(u.lights.mounts.head,u.bars);assert.equal(u.wheels.length,2);
  for(const w of u.wheels){for(const k of ['holder','spin','r','front','restY'])assert(k in w);assert.equal(w.r,.34);assert.equal(w.restY,-.2);assert(w.spin.children[0].isMesh&&w.spin.children[1].isMesh);}
  const roles=new Set();m.traverse(o=>{if(o.material?.userData.cosmeticRole)roles.add(o.material.userData.cosmeticRole);if(o.geometry)for(const a of Object.values(o.geometry.attributes))assert([...a.array].every(Number.isFinite));});
  for(const role of ['body','trim','wheels','helmet','jacket','gloves'])assert(roles.has(role));
  if(type==='dirt') {
    assert(near.triangles<=before*2.5);assert(far.triangles<near.triangles);
    assert.equal(m.name,'bike');assert.deepEqual(u.bars.position.toArray(),[0,.42,.5]);assert.equal(u.bars.rotation.x,-.45);
    assert.deepEqual(u.wheels.map(w=>w.holder.position.toArray()),[[0,-.2,.72],[0,-.2,-.73]]);
    assert(u.wheels.every(w=>w.holder.parent===u.lightMount));
    assert.deepEqual(u.lights.head[0].toArray(),[0,0,.10]);assert.deepEqual(u.lights.tail[0].toArray(),[0,.328,-1]);
  }
  const pose={mesh:m,renderPos:new THREE.Vector3(),renderQuat:new THREE.Quaternion(),t:{travel:.32},steer:.5,lean:.3,pitchRate:0,wheels:u.wheels.map(()=>({contact:true,comp:.12,spin:1.4}))};
  Bike.prototype.syncMesh.call(pose,1/60);assert.equal(u.bars.rotation.y,-.225);assert.equal(u.lean.rotation.z,.3);u.wheels.forEach(w=>assert.equal(w.spin.rotation.x,1.4));
  const palette={body:'#3388cc',trim:'#ededdd',wheels:'#ffcc44',helmet:'#bb3344',jacket:'#449955',gloves:'#aabbcc'};
  paintedModel('bike',palette,type).traverse(o=>{const r=o.material?.userData.cosmeticRole;if(r)assert(o.material.color.equals(new THREE.Color(palette[r])));});
  console.log(JSON.stringify({type,before,near,far,ratio:near.triangles/before}));
}
console.log('PASS bike model hooks, transforms, paint, animation and dirt budget');
