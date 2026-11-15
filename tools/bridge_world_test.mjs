// Full-map bridge query/underpass checks, called by: node tools/bridge_test.mjs game/assets
// Each tile is released before the next; every rendered bridge strip is sampled.
import fs from 'node:fs';
import * as THREE from 'three';
import { makeTileData, makeWorld, BRIDGE_CLIMB } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';

export async function checkBridgeWorld(assets) {
  const W = JSON.parse(fs.readFileSync(`${assets}/world.json`));
  const ab = f => { const b=fs.readFileSync(f);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength); };
  const report={tiles:0,strips:0,deckSamples:0,underSamples:0,underpassDrives:0,riverDrops:0,maxJump:0,errors:[]};
  const check=(ok,message)=>{if(!ok)report.errors.push(message);};
  const fixed=JSON.parse(fs.readFileSync('game/assets/ramps.json'));
  const ramps=Array.isArray(fixed)?fixed:fixed.ramps;
  const crossingKeys=new Set();
  for(const [tx,tz] of W.tiles) {
    const data=await readTileData(async f=>ab(`${assets}/tiles/${tx}_${tz}/${f}`),W.packed);
    if(!data.tile.paths.some(p=>p.bridge))continue;
    const td=makeTileData(W,tx,tz,data), world=makeWorld(W);world.add(td);report.tiles++;
    const lower=makeTileData(W,tx,tz,{...data,tile:{...data.tile,
      paths:data.tile.paths.filter(p=>!p.bridge),physPaths:data.tile.physPaths.filter(p=>!p.bridge)}});
    const inside=(x,z)=>x>=td.x0+2&&x<td.x0+W.tile-2&&z>=td.z0+2&&z<td.z0+W.tile-2;
    for(const r of td.renderRoads.filter(r=>r.bridge)) {
      report.strips++;
      if(r.bridge==='truss'&&!report.riverDrops)for(let i=0;i<r.n;i++) {
        const x=r.x[i],z=r.z[i],water=world.waterLevelAt(x,z);
        if(!inside(x,z)||!Number.isFinite(water)||r.y[i]-water<BRIDGE_CLIMB+2)continue;
        const car=new Car(world,{...TUNING_DEFAULTS});car.reset(x,z,0);car.pos.y=water+1;car.vel.set(0,-1,0);
        let wet=false,captured=false;
        for(let k=0;k<600;k++) {
          car.step(1/120,{throttle:0,brake:0,steer:0,handbrake:false});wet ||= car.waterDepth>0;
          captured ||= !Number.isFinite(car.pos.y)||car.pos.y>=r.y[i]-BRIDGE_CLIMB;
        }
        check(wet&&!captured,`Sheridan river drop: wet=${wet}, captured=${captured}`);
        report.riverDrops++;car.mesh.traverse(o=>o.geometry?.dispose());break;
      }
      // Interior centre-line samples describe a car's route. Offset samples at an
      // abutment can lie beyond the finite strip and query the approach instead.
      for(let i=0;i<r.n-1;i+=6) {
        const x=(r.x[i]+r.x[i+1])/2,z=(r.z[i]+r.z[i+1])/2;
        if(!inside(x,z))continue;
        const y=(r.y[i]+r.y[i+1])/2;
        const h=td.heightAt(x,z,y+1), low=lower.heightAt(x,z);
        check(Number.isFinite(h)&&h>=y-.02,`${tx}_${tz} deck support at ${x},${z}: ${h} vs ${y}`);
        check(Math.abs(td.heightAt(x,z,-1e6)-low)<1e-8,`${tx}_${tz} bridge exclusion at ${x},${z}`);
        const n=world.normalAt(x,z,new THREE.Vector3(),y+1);
        check([...n].every(Number.isFinite)&&n.y>0,`${tx}_${tz} invalid deck normal at ${x},${z}`);
        report.deckSamples++;
        if(y-low>BRIDGE_CLIMB+1)report.underSamples++;
      }
      // Find all centre-line crossings with lower non-bridge roads. Local 40 m trajectories
      // isolate deck capture from the driver's ability to negotiate a distant bend at 100 km/h.
      for(let i=0;i<r.n-1;i++) {
        const ax=r.x[i],az=r.z[i],ex=r.x[i+1]-ax,ez=r.z[i+1]-az;
        for(const p of data.tile.paths.filter(p=>!p.bridge))for(let j=0;j<p.pts.length-1;j++) {
          const [bx,bz]=p.pts[j],[cx,cz]=p.pts[j+1],fx=cx-bx,fz=cz-bz,det=ex*fz-ez*fx;
          if(Math.abs(det)<1e-8)continue;
          const u=((bx-ax)*fz-(bz-az)*fx)/det,v=((bx-ax)*ez-(bz-az)*ex)/det;
          if(u<0||u>1||v<0||v>1)continue;
          const x=ax+u*ex,z=az+u*ez,y=r.y[i]+u*(r.y[i+1]-r.y[i]),low=lower.heightAt(x,z);
          if(!inside(x,z)||y-low<BRIDGE_CLIMB+1)continue;
          const key=`${Math.round(x)},${Math.round(z)}`;if(crossingKeys.has(key))continue;crossingKeys.add(key);
          const len=Math.hypot(fx,fz),dx=fx/len,dz=fz/len;
          if(!inside(x-20*dx,z-20*dz)||!inside(x+20*dx,z+20*dz))continue;
          const car=new Car(world,{...TUNING_DEFAULTS});car.reset(x-20*dx,z-20*dz,Math.atan2(dx,dz));
          car.pos.y=lower.heightAt(car.pos.x,car.pos.z)+.5;
          car.vel.set(dx*100/3.6,0,dz*100/3.6);
          let prev=car.pos.y,jump=0,done=false,jumpAt=null;
          for(let k=0;k<480;k++) {
            car.step(1/120,{throttle:car.vel.length()*3.6<100?1:0,brake:0,steer:0,handbrake:false});
            if(Math.abs(car.pos.y-prev)>jump) {
              jump=Math.abs(car.pos.y-prev);
              jumpAt={x:car.pos.x,z:car.pos.z,before:prev,after:car.pos.y,lower:lower.heightAt(car.pos.x,car.pos.z),upper:world.heightAt(car.pos.x,car.pos.z)};
            }
            prev=car.pos.y;
            if((car.pos.x-x)*dx+(car.pos.z-z)*dz>20){done=true;break;}
          }
          report.underpassDrives++;report.maxJump=Math.max(report.maxJump,jump);
          check(done&&Number.isFinite(jump)&&jump<.5,`${key}: underpass at 100 km/h, finished=${done}, jump=${jump}, at=${JSON.stringify(jumpAt)}`);
          car.mesh.traverse(o=>o.geometry?.dispose());
        }
      }
    }
    for(const r of ramps||[])for(let s=0;s<=31;s+=1)for(const side of [-.5,0,.5]) {
      const x=r.x+Math.sin(r.yaw)*s+Math.cos(r.yaw)*r.w*side;
      const z=r.z+Math.cos(r.yaw)*s-Math.sin(r.yaw)*r.w*side;
      if(!inside(x,z))continue;
      check(Math.abs(td.heightAt(x,z)-lower.heightAt(x,z))<.001,`fixed ramp ${r.name} overlaps a bridge at ${x},${z}`);
    }
  }
  check(report.strips>0&&report.deckSamples>0&&report.underpassDrives>0&&report.riverDrops>0,'missing bridge coverage');
  console.log(JSON.stringify(report,null,2));
  if(report.errors.length)process.exitCode=1;
}
