// Director browser check: serve game/ on 127.0.0.1:8173, run through the heavy-check gate.
// node tools/vehicle_types_shots.mjs --out /tmp/yr-vehicle-types
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { VEHICLE_TYPES } from '../game/src/vehicletypes.js';
const args=process.argv.slice(2),out=args.includes('--out')?args[args.indexOf('--out')+1]:(args[0]||'/tmp/yr-vehicle-types');
fs.mkdirSync(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless:'new',args:['--window-size=1280,800','--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal']});
const errors=[],results=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const page=await browser.newPage();await page.setViewport({width:1280,height:800});
  page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE ERROR',e.message);});
  page.on('console',m=>{if(m.type()==='error'&&!/\/favicon\.ico(?:[?#]|$)/.test(m.location()?.url || '')&&!m.text().includes('favicon'))errors.push(m.text());});
  await page.evaluateOnNewDocument(()=>{
    localStorage.setItem('yr-welcome-hidden-1','1');
    Object.defineProperty(navigator,'getGamepads',{value:()=>[]});
  });
  async function ready() {
    await page.waitForFunction(()=>window.game?.sessionSpawn,{timeout:120000});
    if(await page.evaluate(()=>game.sessionSpawn.blocked)) {
      await page.waitForSelector('#fullmap.open canvas',{visible:true});
      const box=await(await page.$('#fullmap canvas')).boundingBox();
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
      await page.waitForFunction(()=>!game.sessionSpawn.blocked,{timeout:120000});
    }
    await page.evaluate(()=>{document.getElementById('welcome-start')?.click();game.minimap.toggle(false);game.challenges.quit();});
    await page.waitForFunction(()=>game.world.pendingTiles()===0,{timeout:120000});
  }
  await page.goto('http://127.0.0.1:8173/',{waitUntil:'load',timeout:120000});await ready();
  const start=await page.evaluate(()=>[game.car.pos.x,game.car.pos.z,game.car.heading()]);
  for(const [kind,types]of Object.entries(VEHICLE_TYPES))for(const type of types) {
    await page.evaluate(({kind,start})=>{game.garage.close();game.vehicles.switchTo(kind);game.vehicles.current.reset(...start);game.garage.show();},{kind,start});
    await page.click(`#cosmetic-garage [data-kind="${kind}"]`);
    const typeSelect = '[role="dialog"][aria-labelledby="garage-title"] select[name="vehicleType"]';
    await page.waitForSelector(typeSelect,{visible:true});
    await page.select(typeSelect,type.id);await wait(300);
    const chosen=await page.evaluate(kind=>game.vehicles.getType(kind),kind);assert.equal(chosen,type.id);
    await page.screenshot({path:path.join(out,`${type.id}-garage.png`)});
    await page.evaluate(()=>game.garage.close());
    const stats=await page.evaluate(async start=>{
      const g=game,v=g.vehicles.current;v.reset(...start);g.setCam(0);g.keys.add('KeyW');
      let last=performance.now(),samples=[],flips=0,bad=false;
      await new Promise(resolve=>{const began=last;function sample(now){
        samples.push(now-last);last=now;
        if(![...v.pos,...v.vel,...v.quat].every(Number.isFinite))bad=true;
        if(1-2*(v.quat.x*v.quat.x+v.quat.z*v.quat.z)<0)flips++;
        if(now-began<1800)requestAnimationFrame(sample);else resolve();
      }requestAnimationFrame(sample);});g.keys.delete('KeyW');
      samples.sort((a,b)=>a-b);return {kind:v.kind,type:v.type,kmh:v.vel.length()*3.6,flips,bad,
        medianMs:samples[Math.floor(samples.length*.5)],p95Ms:samples[Math.floor(samples.length*.95)],
        slowPercent:100*samples.filter(t=>t>20).length/samples.length,calls:g.renderer.info.render.calls,triangles:g.renderer.info.render.triangles};
    },start);
    await page.screenshot({path:path.join(out,`${type.id}-driving.png`)});
    assert(!stats.bad&&stats.flips===0,`${type.id} invalid driving pose`);results.push(stats);console.log(stats);
  }
  // The final selections (truck + sport) must survive a real reload and rebuild the previews.
  await page.reload({waitUntil:'load',timeout:120000});await ready();
  assert.deepEqual(await page.evaluate(()=>({car:game.vehicles.getType('car'),bike:game.vehicles.getType('bike')})),{car:'truck',bike:'sport'});
  await page.evaluate(()=>{game.vehicles.switchTo('car');game.garage.show();});await wait(300);
  await page.screenshot({path:path.join(out,'reload-truck-garage.png')});
  assert.equal(errors.length,0,errors.join('\n'));
} finally {
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results,errors},null,2));await browser.close();
}
console.log(`PASS: Garage + driving screenshots, reload, page errors and frame samples in ${out}. Review PNGs and compare timings with the factory types.`);
