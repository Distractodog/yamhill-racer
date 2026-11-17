// Director: serve game/ at http://127.0.0.1:8173, then run through the heavy gate.
// node tools/race_finish_browser_test.mjs --out /tmp/yr-race-finish
// Drives complete routes using pedals/steering through the real frame loop.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, watchErrors } from './lib/startgame.mjs';
import { createRaceBot } from './lib/racebot.mjs';

const {values}=parseArgs({options:{out:{type:'string'}}});
const out=values.out||'/tmp/yr-race-finish';await mkdir(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:true,args:['--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal'],protocolTimeout:120000});
const errors=[],report=[];
try {
  const page=await browser.newPage();await page.setViewport({width:1280,height:800});watchErrors(page,'finish',errors);
  page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('/favicon.ico'))errors.push(`HTTP ${r.status()} ${r.url()}`);});
  page.on('requestfailed',r=>errors.push(`Request failed ${r.url()}: ${r.failure()?.errorText}`));
  await startGame(page,{storage:{'yr-graphics-2':JSON.stringify({mode:'low'})}});
  await page.evaluate(source=>{window.createRaceBot=(0,eval)(`(${source})`);},createRaceBot.toString());
  for(const id of ['sheridan','mcminnville-downtown']) {
    await page.evaluate(async id=>{
      const {raceTrack}=await import('./src/racecourse.js');
      const g=game,ch=g.challenges,index=ch.list.findIndex(r=>r.id===id);
      if(index<0)throw Error(`Missing race ${id}`);
      // A fixed Garage type makes the two browser runs comparable to drive.mjs.
      g.vehicles.choose('car','race');await ch.start(index);
      const race=ch.list[index],v=g.vehicles.current,original=v.step;
      const bot=window.createRaceBot(race,raceTrack(race.track,race.gates.at(-1)),ch.track);
      const evidence=window.finishEvidence={id,gates:[],contacts:0,steps:0,missingGround:0,frames:[],start:performance.now(),coast:0,
        meshAtStart:!!g.scene.getObjectByName('race-barriers')};
      let lastNext=ch.next,lastFrame=performance.now(),lastState=ch.state;
      const frame=now=>{evidence.frames.push(now-lastFrame);lastFrame=now;if(!evidence.stopped)requestAnimationFrame(frame);};
      requestAnimationFrame(frame);
      v.step=function(dt,input){
        if(ch.state==='running') {
          bot.drive(this,input,dt);evidence.steps++;
          if(!g.world.loadedAt(this.pos.x,this.pos.z))evidence.missingGround++;
        } else if(ch.state==='finished') {input.throttle=0;input.brake=0;input.steer=0;evidence.coast+=dt;}
        original.call(this,dt,input);
        if(this.hit>0)evidence.contacts++;
      };
      window.stopFinishBot=()=>{v.step=original;evidence.stopped=true;};
      const sample=()=>{
        if(ch.next!==lastNext){evidence.gates.push(ch.next-1);lastNext=ch.next;}
        if(ch.state==='finished'&&lastState!=='finished') {
          evidence.result=ch.result;evidence.finishPosition=v.pos.toArray();
          evidence.meshAtFinish=!!g.scene.getObjectByName('race-barriers');
        }
        lastState=ch.state;
        if(evidence.coast>=2){evidence.resultAfterCoast=ch.result;evidence.complete=true;}
        if(!evidence.stopped)requestAnimationFrame(sample);
      };requestAnimationFrame(sample);
    },id);
    try {
      await page.waitForFunction(()=>window.finishEvidence?.complete,{timeout:900000,polling:250});
      const result=await page.evaluate(()=>{
        window.stopFinishBot();const e=window.finishEvidence,ch=game.challenges;
        const frames=e.frames.sort((a,b)=>a-b);delete e.frames;
        return {...e,next:ch.next,expected:ch.list.find(r=>r.id===e.id).gates.length,
          text:document.getElementById('ch-done').textContent,
          frameMs:{median:frames[Math.floor(frames.length*.5)],p95:frames[Math.floor(frames.length*.95)],worst:frames.at(-1)}};
      });
      report.push(result);await page.screenshot({path:`${out}/${id}-finish.png`});
      assert(result.meshAtStart,`${id}: race barriers active at start`);
      assert(result.steps>0,`${id}: bot drove`);assert(result.result&&!result.result.dnf,`${id}: finish, not DNF`);
      assert.equal(result.next,result.expected,`${id}: every checkpoint passed`);
      assert.equal(result.gates.length,result.expected-1,`${id}: each gate observed`);
      assert.equal(result.meshAtFinish,false,`${id}: barriers removed at finish`);
      assert.deepEqual(result.resultAfterCoast,result.result,`${id}: post-finish coast preserves result`);
      assert.equal(result.missingGround,0,`${id}: loaded ground throughout`);
      console.log(`PASS ${id}: ${result.result.time.toFixed(2)} s, ${result.gates.length} gates, ${result.contacts} contact steps, 2 s coast`);
    } finally {
      await page.evaluate(()=>window.stopFinishBot?.());
      await writeFile(`${out}/results.json`,JSON.stringify({report,errors},null,2));
    }
    await page.evaluate(()=>game.challenges.quit());
  }
  assert.deepEqual(errors,[],'no page/asset errors');
} finally {await browser.close();}
