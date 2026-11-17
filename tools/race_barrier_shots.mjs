// Director: serve game/ on http://127.0.0.1:8173 and run through the heavy gate.
// node tools/race_barrier_shots.mjs --out /tmp/yr-race-barriers
// Review driver.png, above.png, scrape.png and out-of-bounds.png. Also records frames, draw cost and page errors.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors } from './lib/startgame.mjs';
const {values}=parseArgs({options:{out:{type:'string'}}});
const out=values.out||'/tmp/yr-race-barriers';await mkdir(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,args:['--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal']});
const errors=[], report={}; const wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const page=await browser.newPage();await page.setViewport({width:1280,height:800});watchErrors(page,'barriers',errors);
  await startGame(page);
  const pose=await page.evaluate(async()=>{
    const ch=game.challenges, i=ch.list.findIndex(r=>r.id==='sheridan');await ch.start(i);
    const r=ch.list[i], k=60, a=r.track[k], b=r.track[k+4];
    return {x:a[0],z:a[1],yaw:Math.atan2(b[0]-a[0],b[1]-a[1])};
  });
  await holdCar(page,pose);await page.evaluate(()=>game.challenges.update(3.01));await wait(800);
  assert(await page.evaluate(()=>!!game.scene.getObjectByName('race-barriers')),'race mesh present');
  // Render from fixed driver and overhead cameras, while the real game continues updating.
  async function shot(name,above=false) {
    await page.evaluate(above=>{
      const g=game,v=g.vehicles.current,c=g.camera.clone(),p=v.pos,fx=Math.sin(v.heading()),fz=Math.cos(v.heading());
      if(above){c.position.set(p.x+12,p.y+42,p.z-12);c.lookAt(p.x,p.y,p.z+12);}
      else {c.position.set(p.x-fx*7,p.y+2.5,p.z-fz*7);c.lookAt(p.x+fx*25,p.y+.8,p.z+fz*25);}
      window.barrierRender=g.renderer.render;
      g.renderer.render=function(scene){return window.barrierRender.call(this,scene,c);};
    },above);
    await wait(200);await page.screenshot({path:`${out}/${name}.png`});
    await page.evaluate(()=>{game.renderer.render=window.barrierRender;delete window.barrierRender;});
  }
  await shot('driver');await shot('above',true);
  report.frames=await page.evaluate(()=>new Promise(resolve=>{
    const frames=[];let prev=performance.now();const sample=now=>{frames.push(now-prev);prev=now;
      if(frames.length<180)requestAnimationFrame(sample);else{frames.sort((a,b)=>a-b);resolve({median:frames[90],p95:frames[171],worst:frames.at(-1),
        calls:game.renderer.info.render.calls,triangles:game.renderer.info.render.triangles});}};requestAnimationFrame(sample);
  }));
  await page.evaluate(p=>{const v=game.vehicles.current;v.reset(p.x,p.z,p.yaw+.35);v.vel.set(Math.sin(p.yaw+.35)*150/3.6,0,Math.cos(p.yaw+.35)*150/3.6);},pose);
  report.scrape=await page.evaluate(()=>new Promise(resolve=>{
    let hit=0,up=1;const until=performance.now()+1000;
    const sample=()=>{const v=game.vehicles.current,q=v.quat;hit=Math.max(hit,v.hit);up=Math.min(up,1-2*(q.x*q.x+q.z*q.z));
      if(performance.now()<until)requestAnimationFrame(sample);else resolve({state:game.challenges.state,hit,up,speed:v.vel.length()*3.6});};sample();
  }));
  await shot('scrape');
  assert(report.scrape.hit>0,'scrape makes contact');assert(report.scrape.up>0,'scrape stays upright');
  assert.equal(report.scrape.state,'running','scrape stays in race');
  await page.evaluate(p=>{
    const v=game.vehicles.current;v.reset(p.x,p.z,p.yaw);v.pos.y+=8;
    v.vel.set(Math.cos(p.yaw)*40,0,-Math.sin(p.yaw)*40);v.grounded=false;v.airTime=1;
  },pose);
  await page.waitForFunction(()=>game.challenges.result?.dnf,{timeout:10000});
  await page.screenshot({path:`${out}/out-of-bounds.png`});
  report.dnf=await page.evaluate(()=>({result:game.challenges.result,text:document.getElementById('ch-done').textContent,
    barrierPresent:!!game.scene.getObjectByName('race-barriers'),held:(()=>{const i={throttle:1};game.challenges.holdInput(i);return i.throttle!==1;})()}));
  assert.match(report.dnf.text,/Out of bounds — race over/);assert.match(report.dnf.text,/DNF/);
  assert.equal(report.dnf.barrierPresent,false);assert.equal(report.dnf.held,false);assert.deepEqual(errors,[]);
  await writeFile(`${out}/results.json`,JSON.stringify({...report,errors},null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
