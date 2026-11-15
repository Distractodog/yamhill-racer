// Real camera + committed packed tiles, no renderer/server. Also supplies the browser shot route.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { makeTileData, makeWorld } from '../game/src/data.js';
import { readTileData } from '../game/src/tilepack.js';

export async function bridgeFixture(id, x, z, river = false) {
  const W = JSON.parse(fs.readFileSync(new URL('../game/assets/world.json', import.meta.url)));
  const tx = Math.floor((x + 1000) / 2000), tz = Math.floor((z + 1000) / 2000);
  const data = await readTileData(async name => {
    const b = fs.readFileSync(new URL(`../game/assets/tiles/${tx}_${tz}/${name}`, import.meta.url));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }, W.packed);
  const world = makeWorld(W); world.add(makeTileData(W, tx, tz, data));
  // Project the audit coordinate onto the actual lower road (or the truss centre).
  let best = null;
  for (const p of data.tile.physPaths) {
    if (river ? p.bridge !== 'truss' : p.bridge) continue;
    for (let i = 1; i < p.pts.length; i++) {
      const [ax, az] = p.pts[i - 1], [bx, bz] = p.pts[i], ex = bx - ax, ez = bz - az;
      const len = Math.hypot(ex, ez); if (!len) continue;
      const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (len * len)));
      const px = ax + ex * u, pz = az + ez * u, distance = Math.hypot(px - x, pz - z);
      if (!best || distance < best.distance) best = { x: px, z: pz, dx: ex / len, dz: ez / len, distance };
    }
  }
  assert(best && best.distance < 30, `${id}: lower route missing`);
  if (river) [best.dx, best.dz] = [-best.dz, best.dx];
  assert(world.heightAt(best.x, best.z) - world.heightAt(best.x, best.z, -1e6) > 3, `${id}: real deck missing`);
  return { id, world, ...best, river };
}
const source = fs.readFileSync(new URL('../game/src/main.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('let camMode = 0;'), source.indexOf('// ---------------------------------------------------------------- loop'));
// Frozen pre-fix ground clamps; all remaining camera code is shared to isolate the change.
const legacy = code.replace("    tmp.y = Math.min(tmp.y, chaseCeiling(tmp, rp, car.vel, dt));\n", '')
  .replace("    if (v.mode !== 'air') target.y = Math.min(target.y, chaseCeiling(target, rp, v.vel, dt));\n", '')
  .replace('clampChaseCamera(rp, 0.9);',
  'const gh = world.heightAt(camPos.x, camPos.z) + 0.9; if (camPos.y < gh) camPos.y = gh;')
  .replace('clampChaseCamera(rp, 1.2);',
    '{ const gh = world.heightAt(camPos.x, camPos.z) + 1.2; if (camPos.y < gh) camPos.y = gh; }');
function cameraRig(world, mode, kind = 'car', cameraCode = code) {
  const v = { renderPos: new THREE.Vector3(), renderQuat: new THREE.Quaternion(), vel: new THREE.Vector3(),
    cam: kind === 'jet' ? { jet: true } : kind === 'bike' ? { dist: 3.9, high: 1.45, distPerSpeed: .02, nose: [0,1.25,-.05], roll: .18 } : {},
    grounded: true, airTime: 0, hit: 0, landing: 0, lonAcc: 0, lean: 0, mode: 'ground' };
  const camera = new THREE.PerspectiveCamera(66, 1, .1, 10000);
  const ctx = vm.createContext({ THREE, world, car: v, vehicles: { current: v }, camera });
  vm.runInContext(cameraCode + `\ncamMode=${mode};this.tick=updateCamera;`, ctx);
  return { v, camera, tick: ctx.tick };
}
async function run() {
  let roadFixture;
  for (const spot of [['BR-005',3570,2381],['BR-002',19443,-9115],['BR-004',17654,-8790],['Sheridan river',3594,1340,true]]) {
    const f = await bridgeFixture(...spot);
    roadFixture ||= f;
    for (const kind of ['car', 'bike', 'jet']) for (const mode of [0, 1]) for (const fps of [30, 60, 120]) {
      const { v, camera, tick } = cameraRig(f.world, mode, kind);
      v.renderQuat.setFromAxisAngle(new THREE.Vector3(0,1,0), Math.atan2(f.dx,f.dz));
      v.vel.set(f.dx * 100 / 3.6, 0, f.dz * 100 / 3.6);
      let previous = null, jump = 0, covered = 0, jumpAt;
      for (let n = -fps * 2; n <= fps * 5; n++) {
        const s = -65 + Math.max(0,n) * 100 / 3.6 / fps;
        const x = f.x + f.dx * s, z = f.z + f.dz * s;
        const floor = f.world.heightAt(x,z,-1e6), water = f.world.waterLevelAt(x,z);
        v.renderPos.set(x, f.river && Number.isFinite(water) ? water + .5 : floor + .5, z);
        tick(1/fps);
        const p = camera.position, low = f.world.heightAt(p.x,p.z,v.renderPos.y), high = f.world.heightAt(p.x,p.z);
        assert(p.y >= low + .6 - 1e-8, `${f.id} ${kind}/${mode}: camera underground`);
        if (high > low + .01 && high > v.renderPos.y + .8) {
          covered++;
          assert(p.y <= high - 1.7 + 1e-8, `${f.id} ${kind}/${mode}: camera in slab`);
        }
        if(n>0 && previous !== null && Math.abs(p.y-previous)>jump) { jump=Math.abs(p.y-previous); jumpAt={n,s,y:p.y,previous,low,high,rp:v.renderPos.toArray()}; }
        previous=p.y;
      }
      assert(covered>0, `${f.id} ${kind}/${mode}: never under deck`);
      assert(jump<.5, `${f.id} ${kind}/${mode} @ ${fps}: vertical jump ${jump} ${JSON.stringify(jumpAt)}`);
      console.log(`PASS ${f.id} ${kind}/${mode} @ ${fps}: ${covered} under-deck frames, max jump ${jump.toFixed(4)} m`);
    }
  }
  const open = { heightAt: (x,z) => Math.sin(x/100)*2 + Math.cos(z/120), terrainAt: (x,z) => Math.sin(x/100)*2 + Math.cos(z/120) };
  for (const actual of [false,true]) for(const kind of ['car','bike','jet']) for(const mode of [0,1,2]) {
    const world = actual ? roadFixture.world : open;
    const a=cameraRig(world,mode,kind), b=cameraRig(world,mode,kind,legacy);
    for(let i=0;i<600;i++) {
      for(const rig of [a,b]) {
        const {v}=rig;
        const x=actual ? roadFixture.x + roadFixture.dx*(-240+i*.2) : Math.sin(i/80)*15;
        const z=actual ? roadFixture.z + roadFixture.dz*(-240+i*.2) : i*.4;
        v.renderPos.set(x,world.heightAt(x,z)+.5,z);v.vel.set(Math.cos(i/80)*11,0,24);
        v.renderQuat.setFromAxisAngle(new THREE.Vector3(0,1,0),Math.sin(i/80)*.3);
        rig.tick(1/60);
      }
      const snapshot = r => JSON.stringify([r.camera.position.toArray(),r.camera.quaternion.toArray(),r.camera.fov]);
      assert.equal(snapshot(a),snapshot(b), `open road ${kind}/${mode} frame ${i}`);
    }
    console.log(`PASS ${actual ? 'committed' : 'synthetic'} open road ${kind}/${mode}: 600 byte-identical camera samples`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
