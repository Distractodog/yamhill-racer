// Per-vehicle support surface. Terrain queries elsewhere (streaming, spawning, scenery) stay unchanged.
// A roof supports a vehicle only when approached from above; walls still block driving into a building.
import { inPoly, partPts, rectPts } from './campus.js';
const shapes = new WeakMap();
function shape(b) {
  let s = shapes.get(b);
  if (!s) {
    const building = b.roofBuilding;
    const parts = building?.parts.map(p => {
      let pts = partPts(p);
      if (pts.length === 4 && Math.hypot(pts[1][0]-pts[0][0],pts[1][1]-pts[0][1]) < Math.hypot(pts[2][0]-pts[1][0],pts[2][1]-pts[1][1])) pts=[pts[1],pts[2],pts[3],pts[0]];
      return { p, pts, boxes:(p.boxes || []).map(box=>({box,pts:rectPts(box)})) };
    });
    s = { parts, minRise: parts ? Math.min(...parts.map(({p})=>p.h)) : 0, x0:Math.min(...b.pts.map(p=>p[0])), x1:Math.max(...b.pts.map(p=>p[0])), z0:Math.min(...b.pts.map(p=>p[1])), z1:Math.max(...b.pts.map(p=>p[1])) };
    shapes.set(b,s);
  }
  return s;
}
export function buildingRoofFloor(b,world) {
  if(b.roofBuilding) return b.roofBuilding.floor+shape(b).minRise;
  if(b.top!==undefined) return b.top;
  const s=shape(b);
  return s.top ??= (world.groundAt || world.terrainAt || world.heightAt)(b.pts[0][0],b.pts[0][1])+(b.h || 6);
}
export function buildingRoofAt(b,x,z,world) {
  const s=shape(b);
  if (x<s.x0 || x>s.x1 || z<s.z0 || z>s.z1) return -Infinity;
  if (s.parts) {
    let height=-Infinity;
    for (const {p,pts,boxes} of s.parts) {
      if (!inPoly(pts,x,z)) continue;
      let h=b.roofBuilding.floor+p.h;
      if (p.roof && ['gable','hip'].includes(p.roof.type) && pts.length===4) {
        const [a,c,d]=pts, L=Math.hypot(c[0]-a[0],c[1]-a[1]), W=Math.hypot(d[0]-c[0],d[1]-c[1]);
        const u=((x-a[0])*(c[0]-a[0])+(z-a[1])*(c[1]-a[1]))/L;
        const v=((x-c[0])*(d[0]-c[0])+(z-c[1])*(d[1]-c[1]))/W;
        h+=Math.max(0,Math.min(v,W-v,...(p.roof.type==='hip'?[u,L-u]:[])))*Math.tan(p.roof.pitch*Math.PI/180);
      }
      for (const {box,pts:bp} of boxes) if(inPoly(bp,x,z)) h=Math.max(h,b.roofBuilding.floor+box.y1);
      height=Math.max(height,h);
    }
    return height;
  }
  if (!inPoly(b.pts,x,z)) return -Infinity;
  return buildingRoofFloor(b,world);
}
export function createVehicleWorld(world,vehicle) {
  let px=NaN,pz=NaN,loaded=false,tileCount=-1,near=[],minRoof=Infinity;
  function candidates() {
    const ready=world.loadedAt?.(vehicle.pos.x,vehicle.pos.z), count=world.tiles?.size;
    // Reuse the broad phase within an 8 m neighbourhood; 32 m padding covers the vehicle and wheel probes.
    if (!Number.isFinite(px) || Math.hypot(px-vehicle.pos.x,pz-vehicle.pos.z)>8 || ready!==loaded || count!==tileCount) {
      loaded=ready; tileCount=count;
      px=vehicle.pos.x; pz=vehicle.pos.z;
      near=(world.buildingsNear?.(px,pz,40) || []).filter(b=> {
        if(!b.pts?.length) return false;
        const s=shape(b); return px>=s.x0-32 && px<=s.x1+32 && pz>=s.z0-32 && pz<=s.z1+32;
      });
      minRoof=near.reduce((low,b)=>Math.min(low,buildingRoofFloor(b,world)),Infinity);
    }
    return near;
  }
  function canReachRoof() {
    candidates();
    return minRoof<=vehicle.pos.y+Math.max(0,-vehicle.vel.y)/120+0.1;
  }
  function roofAt(x,z) {
    if(!canReachRoof()) return -Infinity;
    let height=-Infinity;
    // Include one fixed physics step of descent, so fast touchdowns cannot tunnel through a roof.
    const ceiling=vehicle.pos.y+Math.max(0,-vehicle.vel.y)/120+0.1;
    for (const b of candidates()) {
      if(buildingRoofFloor(b,world)>ceiling) continue;
      const h=buildingRoofAt(b,x,z,world);
      if(h<=ceiling) height=Math.max(height,h);
    }
    return height;
  }
  const queries = {
    roofAt, canReachRoof,
    heightAt: (x,z)=>Math.max(world.heightAt(x,z),roofAt(x,z)),
    surfaceAt: (x,z)=>roofAt(x,z)>world.heightAt(x,z)?6:world.surfaceAt(x,z),
    normalAt: (x,z,out)=> {
      const h=roofAt(x,z);
      if(h<=world.heightAt(x,z)) return world.normalAt(x,z,out);
      const a=roofAt(x-0.1,z),b=roofAt(x+0.1,z),c=roofAt(x,z-0.1),d=roofAt(x,z+0.1);
      return out.set(Number.isFinite(a)&&Number.isFinite(b)?(a-b)/0.2:0,1,Number.isFinite(c)&&Number.isFinite(d)?(c-d)/0.2:0).normalize();
    }
  };
  // Inherit live world state and override only support queries; no Proxy in the physics hot path.
  return Object.assign(Object.create(world), queries);
}
