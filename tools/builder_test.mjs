import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PIECES, BY_ID, worldPoint, localPoint, snapPlacement, surfaceTriangles, triangleSample } from '../game/src/builder/pieces.js';
import { createPlacedLayer, createPlacedMeshes } from '../game/src/builder/placed.js';
import { createLayouts, createHistory, encodeLayout, decodeLayout, validateLayout, emptyLayout } from '../game/src/builder/layouts.js';
import { layoutChunks, acceptChunk, validChunk } from '../game/src/builder/wire.js';
import { makeWorld } from '../game/src/data.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
const piece=(type,x=0,z=0,y=0,more={})=>({id:'piece1',type,x,y,z,yaw:0,scale:1,...more});
const layout=(...pieces)=>({version:1,pieces});
function worldWith(...pieces) {
  const w=makeWorld({tile:2000,hstep:4,extent:[-1000,-1000,1000,1000],tiles:[[0,0]],spawn:[0,-60]});
  w.add({tx:0,tz:0,x0:-1000,z0:-1000,terrainAt:()=>0,heightAt:()=>0,surfaceAt:()=>3,waterLevelAt:()=>-Infinity,treesNear(){},buildings:[]});
  const layer=createPlacedLayer();layer.set(layout(...pieces));w.setPlacedPieces(layer);return {w,layer};
}
const idle={throttle:0,brake:0,steer:0,handbrake:false};
function step(v,n,input=idle,layer){for(let i=0;i<n;i++){v.savePrev();v.step(1/120,input);layer?.applyBoost(v);for(const value of [...v.pos,...v.vel,...v.quat])assert.ok(Number.isFinite(value),'finite vehicle state');}}

test('placement rotation, scale, snap and all palette models are finite',()=>{
  const p=piece('platform',10,30,5,{yaw:Math.PI/3,scale:2});const q=worldPoint(p,3,4,6),back=localPoint(p,q[0],q[2]);
  assert.ok(Math.abs(back[0]-3)<1e-9 && Math.abs(back[1]-6)<1e-9);assert.equal(q[1],13);
  const snap=snapPlacement({...p,x:10.4,z:30.6,yaw:.3},true);assert.equal(snap.x,10);assert.equal(snap.z,31);assert.equal(snap.yaw,Math.PI/12);
  assert.equal(snapPlacement({...p,yaw:Math.PI/180},true,true).yaw,Math.PI/180);
  assert.equal(PIECES.length,27);
  for(const d of PIECES){const model=d.build();assert.ok(model.children.length<=(d.id==='pool'?6:1),`${d.id} merged prototype`);model.traverse(o=>{if(o.isMesh)for(const n of o.geometry.attributes.position.array)assert.ok(Number.isFinite(n),d.id);});}
});
test('storage, named layouts, text/file round trips, undo and bounded validation',()=>{
  const memory=new Map(),storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};
  const l=layout(piece('wedge')),s=createLayouts(storage);assert.ok(s.update(l,true));s.save('Jump park',l);
  const restored=createLayouts(storage);assert.equal(restored.enabled,true);assert.deepEqual(restored.load('Jump park'),l);assert.deepEqual(decodeLayout(encodeLayout(restored.current)),l);
  restored.save('__proto__',l);assert.deepEqual(restored.load('__proto__'),l);restored.remove('Jump park');assert.deepEqual(restored.names(),['__proto__']);
  const h=createHistory();h.commit(l);h.undo();assert.deepEqual(h.value,emptyLayout());h.redo();assert.deepEqual(h.value,l);
  const copy=h.value;copy.pieces[0].x=999;assert.equal(h.value.pieces[0].x,0);
  for(const p of [piece('unknown'),piece('wall',Infinity),piece('wall',0,0,0,{scale:99})])assert.throws(()=>validateLayout(layout(p)));
  assert.throws(()=>validateLayout(layout(piece('wall'),piece('wall'))));assert.throws(()=>decodeLayout('oops'));
  const unavailable=createLayouts({getItem(){throw Error();},setItem(){throw Error();}});assert.equal(unavailable.update(l),false);assert.match(unavailable.warning,/Export/);
});
test('surface queries agree with shared mesh triangles after rotating and scaling',()=>{
  for(const d of PIECES.filter(d=>d.collider==='surface' || d.id==='platform')){
    const p=piece(d.id,12,30,4,{yaw:.7,scale:1.5}),{layer,w}=worldWith(p);
    for(const t of surfaceTriangles(d).filter((_,i)=>i%7===0)){
      const x=t.reduce((n,v)=>n+v[0],0)/3,z=t.reduce((n,v)=>n+v[2],0)/3,s=triangleSample([t],x,z),q=worldPoint(p,x,s.h,z);
      assert.ok(Math.abs(layer.sample(q[0],q[2]).h-q[1])<1e-5,d.id);assert.ok(Math.abs(w.heightAt(q[0],q[2])-q[1])<1e-5,d.id);
      const normal=w.normalAt(q[0],q[2]);assert.ok(Math.abs(normal.length()-1)<1e-6);
    }
  }
});
test('trees, roofs, water and disabled-layer query identity',()=>{
  const {w,layer}=worldWith(piece('conifer'),piece('pool',50,50,0,{id:'pool'}),piece('house',-50,0,0,{id:'house'}));
  let trees=0;w.treesNear(0,0,5,()=>trees++);assert.equal(trees,1);assert.equal(w.waterLevelAt(50,50),3);assert.equal(w.waterLevelAt(80,50),-Infinity);
  assert.ok(w.buildingsNear(-50,0,1).length);assert.equal(w.heightAt(-50,0,1),0,'below roof is not teleported up');
  const car=new Car(w,{...TUNING_DEFAULTS});car.reset(-50,0,0);car.pos.set(-50,12,0);assert.ok(car.world.heightAt(-50,0)>5);
  layer.set(emptyLayout());w.setPlacedPieces(layer);assert.equal(car.world.heightAt(-50,0),0,'deleting a roof invalidates stationary vehicle cache');
  w.setPlacedPieces(null);assert.equal(w.heightAt(0,0),0);assert.equal(w.surfaceAt(0,0),3);assert.equal(w.waterLevelAt(50,50),-Infinity);assert.deepEqual(w.buildingsNear(0,0),[]);
});
test('real car drives over a placed ramp and launches without NaN or a flip',()=>{
  const {w}=worldWith(piece('ramp-medium'));const car=new Car(w,{...TUNING_DEFAULTS});car.reset(0,-45,0);car.vel.z=28;
  let maxY=0,air=0,minUp=1;
  for(let i=0;i<600;i++){step(car,1,{...idle,throttle:1});maxY=Math.max(maxY,car.pos.y);if(car.pos.z>-10&&car.pos.z<60)air=Math.max(air,car.airTime);minUp=Math.min(minUp,new THREE.Vector3(0,1,0).applyQuaternion(car.quat).y);}
  assert.ok(maxY>3,`ramp jump height ${maxY}`);assert.ok(air>.1,`air time ${air}`);assert.ok(minUp>0,`upright ${minUp}`);console.log('ramp jump', {maxY,air,minUp});
});
test('real car rests and drives on a platform; wall stops it; boost fires once per entry',()=>{
  const a=worldWith(piece('platform'));const car=new Car(a.w,{...TUNING_DEFAULTS});car.reset(0,0,0);car.pos.y=4.5;step(car,360);assert.ok(car.pos.y>3 && car.pos.y<5);assert.ok(car.grounded);step(car,30,{...idle,throttle:1});assert.ok(car.pos.z>0 && car.pos.y>3);
  const b=worldWith(piece('wall'));const v=new Car(b.w,{...TUNING_DEFAULTS});v.reset(0,-12,0);v.vel.z=20;step(v,240);assert.ok(v.pos.z<0,`wall stops car at ${v.pos.z}`);
  const c=worldWith(piece('boost'));const boosted=new Car(c.w,{...TUNING_DEFAULTS});boosted.reset(0,-10,0);boosted.vel.z=12;
  let jump=0;for(let i=0;i<180;i++){const before=boosted.vel.z;step(boosted,1,idle,c.layer);jump=Math.max(jump,boosted.vel.z-before);}assert.ok(jump>24,`boost impulse ${jump}`);
  boosted.pos.set(0,1,0);boosted.grounded=true;c.layer.applyBoost(boosted);const speed=boosted.vel.z;c.layer.applyBoost(boosted);assert.equal(boosted.vel.z,speed,'no repeated impulse while inside');
});
test('200 repeated pieces stay instanced and indexed queries stay local',()=>{
  const pieces=Array.from({length:200},(_,i)=>piece('ramp-medium',i%20*50,Math.floor(i/20)*50,0,{id:`p${i}`}));
  const {layer}=worldWith(...pieces),scene=new THREE.Scene(),meshes=createPlacedMeshes(scene);meshes.set(layout(...pieces));assert.equal(meshes.group.children.length,1);assert.equal(meshes.group.children[0].count,200);
  const start=performance.now();for(let i=0;i<10000;i++)layer.sample(0,0,1);console.log('10k indexed queries ms',Math.round(performance.now()-start));
  meshes.set(emptyLayout());assert.equal(meshes.group.children.length,0);
});
test('chunk round trip is atomic and bounded, including out-of-order chunks',()=>{
  const code=encodeLayout(layout(...Array.from({length:200},(_,i)=>piece('road-straight',i*5,0,0,{id:`p${i}`}))));
  const chunks=layoutChunks(code,'revision1');assert.ok(chunks.length>1);let pending=null,complete=null;
  for(const m of chunks.toReversed()){const next=acceptChunk(pending,m);pending=next.pending;complete=next.complete;assert.ok(Buffer.byteLength(JSON.stringify(m))<16384);}
  assert.equal(complete.map(c=>c.data).join(''),code);assert.equal(validChunk({...chunks[0],total:9999}),false);assert.equal(validChunk({...chunks[0],data:'x'.repeat(6001)}),false);
});

test('drawn roads, ramps and roofs match contacts; arch opening and elevated bridge stay clear',()=>{
  const ray=new THREE.Raycaster(new THREE.Vector3(),new THREE.Vector3(0,-1,0));
  for(const type of ['ramp-medium','quarter-pipe','half-pipe','banked-curve','road-straight','road-curve','road-up','road-down','bridge','house','shop','barn']){
    const d=BY_ID.get(type),{layer}=worldWith(piece(type)),model=d.build();model.updateMatrixWorld(true);
    const points=['road-curve','banked-curve'].includes(type)?[[0,0],[4,-5],[-5,4]]:[[0,0],[d.w*.2,d.l*.2]];
    for(const [x,z] of points){const support=layer.sample(x,z);if(!support)continue;ray.ray.origin.set(x,100,z);const hit=ray.intersectObject(model,true)[0];assert.ok(hit,`${type} drawn surface`);assert.ok(Math.abs(hit.point.y-support.h)<.06,`${type}: drawn ${hit.point.y} contact ${support.h}`);}
  }
  const arch=worldWith(piece('checkpoint')),car=new Car(arch.w,{...TUNING_DEFAULTS});car.reset(0,-8,0);car.vel.z=15;step(car,180);assert.ok(car.pos.z>1,'car passes through checkpoint opening');assert.equal(arch.w.heightAt(0,0,8),7,'arch crossbar supports from above');
  const bridge=worldWith(piece('bridge',0,0,6)),under=new Car(bridge.w,{...TUNING_DEFAULTS});under.reset(0,-25,0);under.pos.y=.5;under.vel.z=15;step(under,240);assert.ok(under.pos.z>0 && under.pos.y<2,'drive under elevated bridge');
  const pool=worldWith(piece('pool',0,0,4));assert.equal(pool.w.heightAt(0,0,5),4,'raised pool bed');assert.equal(pool.w.waterLevelAt(0,0),7);
});

test('disabled builder produces the identical car trajectory on the original flat-world contract',()=>{
  const {w}=worldWith();w.setPlacedPieces(null);
  const baseline={heightAt:()=>0,groundAt:()=>0,terrainAt:()=>0,surfaceAt:()=>3,normalAt:(x,z,n)=>n.set(0,1,0),waterLevelAt:()=>-Infinity,buildingsNear:()=>[],treesNear(){},loadedAt:()=>true,extent:[-1000,-1000,1000,1000],spawn:[0,-60]};
  const a=new Car(w,{...TUNING_DEFAULTS}),b=new Car(baseline,{...TUNING_DEFAULTS});a.reset(0,0,0);b.reset(0,0,0);
  for(let i=0;i<1200;i++){const input={...idle,throttle:i<900?1:0,brake:i>=900?1:0,steer:i>300&&i<600?.3:0,handbrake:i>650&&i<750};step(a,1,input);step(b,1,input);assert.deepEqual(a.pos.toArray(),b.pos.toArray());assert.deepEqual(a.vel.toArray(),b.vel.toArray());assert.deepEqual(a.quat.toArray(),b.quat.toArray());}
});


test('moving stacked pieces finds support below their base, not pieces above them',()=>{
  const {layer}=worldWith(piece('platform',0,0,0,{id:'base'}),piece('road-straight',0,0,3,{id:'road'}));
  assert.equal(layer.sample(0,0,undefined,'road',3.01).h,3,'road keeps zero lift above the platform');
  assert.equal(layer.sample(0,0,undefined,'base',.01),null,'moving the platform ignores the road above it');
});
