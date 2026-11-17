// Spatially indexed, optional world layer. It never edits baked tiles or vehicle tuning.
import * as THREE from 'three';
import { BY_ID, localPoint, worldPoint, surfaceTriangles, triangleSample, housePart } from './pieces.js';
import { validateLayout } from './layouts.js';
import { trunkRadius } from '../data.js';
const CELL=64;
export function createPlacedLayer() {
  let pieces=[],grid=new Map();
  const boostInside=new WeakMap();
  const bounds=p=>{const d=BY_ID.get(p.type),r=Math.hypot(d.w,d.l)*p.scale/2+2;return [p.x-r,p.z-r,p.x+r,p.z+r];};
  function candidates(x,z,r=0) {
    const found=new Set();
    for(let iz=Math.floor((z-r)/CELL);iz<=Math.floor((z+r)/CELL);iz++) for(let ix=Math.floor((x-r)/CELL);ix<=Math.floor((x+r)/CELL);ix++) for(const p of grid.get(`${ix},${iz}`)||[]) found.add(p);
    return found;
  }
  const box=(p,x,z,w,l,h,base=0)=>{
    const pts=[[-w/2,-l/2],[w/2,-l/2],[w/2,l/2],[-w/2,l/2]].map(([u,v])=>{const q=worldPoint(p,u+x,0,v+z);return [q[0],q[2]];});
    // roofBuilding prevents town planning and shares the game's roof/wall contact rules.
    return {pts,bottom:p.y+base*p.scale,top:p.y+h*p.scale,h:h*p.scale,roofBuilding:{floor:p.y+base*p.scale,parts:[{pts,h:(h-base)*p.scale,roof:{type:'flat'}}]}};
  };
  function set(layout) {
    pieces=validateLayout(layout).pieces;grid=new Map();
    for(const p of pieces) {
      const d=BY_ID.get(p.type);p.boxes=[];
      if(d.shape==='arch') {p.boxes.push(box(p,-d.w/2+.5,0,1,1,d.h),box(p,d.w/2-.5,0,1,1,d.h));}
      else if(d.collider==='solid') {
        const b=box(p,0,0,d.w,d.l,d.h);
        if(d.shape==='building') {const part=housePart(d);b.roofBuilding.parts[0].roof=part.roof;}
        p.boxes.push(b);
      }
      if(d.shape==='pool') {
        for(const x of [-d.w/2,d.w/2]) p.boxes.push(box(p,x,0,.4,d.l+.4,d.h+.3));
        for(const z of [-d.l/2,d.l/2]) p.boxes.push(box(p,0,z,d.w,.4,d.h+.3));
      }
      if(d.shape==='bridge') {
        for(const x of [-d.w/2,d.w/2]) p.boxes.push(box(p,x,0,.25,d.l,d.h+1.18,d.h));
        for(const pier of d.build().userData.bridgePiers || []) p.boxes.push(box(p,pier.top[0],pier.top[2],1.2,1.6,pier.top[1]));
      }
      const [x0,z0,x1,z1]=bounds(p);
      for(let iz=Math.floor(z0/CELL);iz<=Math.floor(z1/CELL);iz++) for(let ix=Math.floor(x0/CELL);ix<=Math.floor(x1/CELL);ix++) {const k=`${ix},${iz}`;if(!grid.has(k))grid.set(k,[]);grid.get(k).push(p);}
    }
  }
  function sample(x,z,y,exclude,ceiling=Infinity) {
    let best=null;
    for(const p of candidates(x,z)) {
      if(p.id===exclude)continue;
      const d=BY_ID.get(p.type);if(d.collider==='tree')continue;
      const [u,v]=localPoint(p,x,z);
      let hit=triangleSample(surfaceTriangles(d),u,v);if(!hit)continue;
      if(d.shape==='building' && d.id!=='shop') {
        // Campus roof's ridge follows the longer footprint edge.
        hit={h:d.h+(d.w/2-Math.abs(u))*Math.tan(25*Math.PI/180),gx:-Math.sign(u)*Math.tan(25*Math.PI/180),gz:0};
      }
      if(d.shape==='pool')hit={h:0,gx:0,gz:0};
      const h=p.y+hit.h*p.scale;
      if(h>ceiling)continue;
      const climb=d.collider==='solid'?.05:3;
      if(y!==undefined && y<h-climb)continue;
      if(!best || h>best.h) {
        const c=Math.cos(p.yaw),s=Math.sin(p.yaw);
        best={h,gx:hit.gx*c+hit.gz*s,gz:hit.gz*c-hit.gx*s,surface:d.shape==='pool'?5:d.surface,piece:p};
      }
    }
    return best;
  }
  function waterLevelAt(x,z) {
    let h=-Infinity;
    for(const p of candidates(x,z)){const d=BY_ID.get(p.type);if(d.shape!=='pool')continue;const [u,v]=localPoint(p,x,z);if(Math.abs(u)<=d.w/2 && Math.abs(v)<=d.l/2)h=Math.max(h,p.y+d.h*p.scale);}
    return h;
  }
  return {
    set,sample,waterLevelAt,
    buildingsNear(x,z,r,out){for(const p of candidates(x,z,r))out.push(...p.boxes);},
    treesNear(x,z,r,cb){for(const p of candidates(x,z,r)){const d=BY_ID.get(p.type);if(d.shape==='tree' && Math.hypot(x-p.x,z-p.z)<=r+d.w*p.scale){const broad=d.id==='broadleaf';cb(p.x,p.z,trunkRadius(d.h*p.scale,broad),d.h*p.scale,+broad);}}},
    applyBoost(vehicle) {
      const entered=new Set(), previous=boostInside.get(vehicle)||new Set();
      for(const p of candidates(vehicle.pos.x,vehicle.pos.z)) {
        const d=BY_ID.get(p.type);if(d.shape!=='boost')continue;
        const [u,v]=localPoint(p,vehicle.pos.x,vehicle.pos.z),top=p.y+d.h*p.scale;
        if(Math.abs(u)>d.w/2 || Math.abs(v)>d.l/2 || Math.abs(vehicle.pos.y-top)>3 || !vehicle.grounded)continue;
        entered.add(p.id);
        if(!previous.has(p.id)) {vehicle.vel.x+=Math.sin(p.yaw)*25;vehicle.vel.z+=Math.cos(p.yaw)*25;}
      }
      boostInside.set(vehicle,entered);
    },
    get count(){return pieces.length;},
  };
}
// One instanced mesh per prototype part, regardless of the number of placed copies.
export function createPlacedMeshes(scene) {
  const group=new THREE.Group();group.name='builder-pieces';scene.add(group);
  const matrix=new THREE.Matrix4(), rotation=new THREE.Quaternion(), scale=new THREE.Vector3(), pos=new THREE.Vector3(),up=new THREE.Vector3(0,1,0);
  return {group,
    set(layout){
      for(const child of [...group.children]){group.remove(child);child.dispose?.();}
      const kinds=new Map();for(const p of layout.pieces){if(!kinds.has(p.type))kinds.set(p.type,[]);kinds.get(p.type).push(p);}
      for(const [id,list] of kinds) {
        const prototype=BY_ID.get(id).build();prototype.updateMatrixWorld(true);
        prototype.traverse(part=>{
          if(!part.isMesh)return;
          const mesh=new THREE.InstancedMesh(part.geometry,part.material,list.length);mesh.userData.pieces=list;mesh.castShadow=mesh.receiveShadow=true;
          list.forEach((p,i)=>{rotation.setFromAxisAngle(up,p.yaw);matrix.compose(pos.set(p.x,p.y,p.z),rotation,scale.setScalar(p.scale));matrix.multiply(part.matrixWorld);mesh.setMatrixAt(i,matrix);});
          mesh.computeBoundingSphere();group.add(mesh);
        });
      }
    },
  };
}
