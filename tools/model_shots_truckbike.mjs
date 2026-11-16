// Director: serve game/ at 127.0.0.1:8173 and run through the heavy-check gate.
// node tools/model_shots_truckbike.mjs --out /tmp/yr-truckbike
// Garage + world front/rear three-quarter, side, top, driving, night and far LOD evidence.
// No screenshots have been reviewed by the worker; inspect the PNGs before accepting the models.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors } from './lib/startgame.mjs';
const args=process.argv.slice(2), out=args.includes('--out')?args[args.indexOf('--out')+1]:'/tmp/yr-truckbike';
await fs.mkdir(out,{recursive:true});
const report={pageErrors:[],consoleErrors:[],shots:[],frames:[],visualReview:'NOT REVIEWED'};
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,args:['--window-size=1440,900','--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal']});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const page=await browser.newPage();await page.setViewport({width:1440,height:900});
  watchErrors(page,'truckbike',report.pageErrors);
  page.on('console',m=>{if(m.type()==='error'&&!m.location().url?.endsWith('/favicon.ico'))report.consoleErrors.push(m.text());});
  await startGame(page);
  await page.evaluate(async()=>{
    const T=await import('three');
    window.modelEvidence={view:'front',garage:false,forcedFar:false,frameMs:[],last:performance.now(),steps:new Map()};
    const state=modelEvidence, offsets={front:[1,.48,1.25],rear:[-1,.48,-1.25],side:[1.7,.24,0],top:[.001,1.85,0],driving:[-1,.6,-1.35]};
    // Freeze only physics for parked evidence. Restore the original step for the driving shot.
    for(const v of Object.values(game.vehicles.all))state.steps.set(v,v.step);
    state.freeze=on=>{for(const [v,step]of state.steps)v.step=on?()=>{}:step;};
    const original=T.Scene.prototype.onBeforeRender;
    T.Scene.prototype.onBeforeRender=function(renderer,scene,camera,...rest){
      original.call(this,renderer,scene,camera,...rest);
      const isWorld=renderer===game.renderer;
      if(isWorld||state.garage){
        const model=isWorld?game.vehicles.current.mesh:scene.children.find(o=>o.name==='car-truck'||o.name==='bike-sport');
        if(model){
          if(!isWorld)model.rotation.set(0,0,0);
          model.updateMatrixWorld(true);
          const bounds=new T.Box3().setFromObject(model),center=bounds.getCenter(new T.Vector3());
          const distance=game.vehicles.current.kind==='car'?5.3:2.15;
          const offset=new T.Vector3(...(offsets[state.view]||offsets.front)).multiplyScalar(distance);
          if(isWorld)offset.applyQuaternion(model.quaternion);
          camera.position.copy(center).add(offset);camera.up.set(0,1,0);camera.lookAt(center);camera.updateMatrixWorld();
          model.traverse(o=>{if(o.isLOD){o.autoUpdate=!state.forcedFar;if(state.forcedFar)o.levels.forEach((l,i)=>{l.object.visible=i===o.levels.length-1;});}});
        }
      }
      if(isWorld){const now=performance.now();state.frameMs.push(now-state.last);state.last=now;}
    };
  });
  const at={x:19451,z:-11032,yaw:-1.573};
  async function shot(type,phase,view){
    await page.evaluate(({phase,view})=>{modelEvidence.view=view;modelEvidence.garage=phase==='garage';},{phase,view});
    await wait(350);
    const file=`${type}-${phase}-${view}.png`;
    await page.screenshot({path:path.join(out,file)});report.shots.push(file);
  }
  for(const [kind,type]of [['car','truck'],['bike','sport']]){
    await page.evaluate(({kind,type})=>{modelEvidence.freeze(false);game.garage.close();game.vehicles.switchTo(kind);game.vehicles.setType(kind,type);game.atmosphere.setPreset('midday',false);},{kind,type});
    await holdCar(page,{...at,kind});await wait(700);
    await page.evaluate(()=>{modelEvidence.freeze(true);game.garage.show();});
    await page.click(`#cosmetic-garage [data-kind="${kind}"]`);
    const typeSelect='[role="dialog"][aria-labelledby="garage-title"] select[name="vehicleType"]';
    await page.waitForSelector(typeSelect,{visible:true});await page.select(typeSelect,type);
    for(const view of ['front','rear','side','top'])await shot(type,'garage',view);
    await page.evaluate(()=>{game.garage.close();modelEvidence.garage=false;});
    for(const view of ['front','rear','side','top'])await shot(type,'world',view);
    await page.evaluate(()=>{modelEvidence.forcedFar=true;});await shot(type,'far','front');
    await page.evaluate(()=>{modelEvidence.forcedFar=false;game.atmosphere.setPreset('night',false);});
    for(const view of ['front','rear'])await shot(type,'night',view);
    await page.evaluate(()=>{game.atmosphere.setPreset('midday',false);modelEvidence.view='driving';modelEvidence.freeze(false);
      const v=game.vehicles.current;v.vel.set(0,0,100/3.6).applyQuaternion(v.quat);game.keys.add('KeyW');modelEvidence.frameMs=[];modelEvidence.last=performance.now();});
    await wait(900);await shot(type,'speed','driving');
    const stats=await page.evaluate(()=>{
      game.keys.clear();modelEvidence.freeze(true);
      const v=game.vehicles.current,times=modelEvidence.frameMs.slice().sort((a,b)=>a-b);
      return {kind:v.kind,type:v.type,kmh:v.vel.length()*3.6,finite:[...v.pos,...v.vel,...v.quat].every(Number.isFinite),
        medianMs:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],slowPercent:100*times.filter(t=>t>20).length/times.length,
        triangles:game.renderer.info.render.triangles,calls:game.renderer.info.render.calls};
    });
    report.frames.push(stats);console.log(stats);assert(stats.finite,'nonfinite driving pose');
  }
  assert.equal(report.pageErrors.length,0,report.pageErrors.join('\n'));
  assert.equal(report.consoleErrors.length,0,report.consoleErrors.join('\n'));
} finally {
  await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));await browser.close();
}
console.log(`Screenshots and frame/error report written to ${out}. Director visual review required; timings include the evidence camera hook.`);
