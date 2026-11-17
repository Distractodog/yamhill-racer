// Director: run through the heavy gate with game/ served at http://127.0.0.1:8173.
// node tools/builder_shots.mjs --out /tmp/yr-builder
// Review every PNG. No server is started here; the browser is always closed.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import puppeteer from 'puppeteer-core';
import {startGame,watchErrors} from './lib/startgame.mjs';
const {values}=parseArgs({options:{out:{type:'string'}}});const out=values.out||'/tmp/yr-builder';await mkdir(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal']});
const errors=[],report={},wait=ms=>new Promise(r=>setTimeout(r,ms));
try {
  const page=await browser.newPage();await page.setViewport({width:1280,height:800});watchErrors(page,'builder',errors);
  await startGame(page,{storage:{'yr-builder-1':JSON.stringify({enabled:false,current:{version:1,pieces:[]},named:{}})}});
  const shot=name=>page.screenshot({path:`${out}/${name}.png`});
  // Real settings toggle and keyboard entry.
  await page.keyboard.press('KeyT');await page.click('#builder-enabled');await page.keyboard.press('Escape');await page.keyboard.press('KeyB');
  await page.waitForFunction(()=>game.builder.open);await wait(800);await shot('01-palette');
  const before=await page.evaluate(()=>game.car.pos.toArray());await page.keyboard.down('KeyW');await wait(300);await page.keyboard.up('KeyW');assert.deepEqual(await page.evaluate(()=>game.car.pos.toArray()),before,'builder pauses physics');
  // Place a ramp, a road and a building using pointer placement, not the debug API.
  for(const [type,x,y] of [['ramp-medium',400,500],['road-straight',620,500],['house',760,580]]){
    await page.evaluate(type=>game.builder.choose(type),type);await page.mouse.move(x,y);await wait(100);await page.mouse.click(x,y);await wait(100);
  }
  assert.equal(await page.evaluate(()=>game.builder.layout.pieces.length),3,'three pointer placements');
  await shot('02-placed-pieces');
  await page.keyboard.down('Control');await page.keyboard.press('KeyZ');await page.keyboard.up('Control');assert.equal(await page.evaluate(()=>game.builder.layout.pieces.length),2);
  await page.keyboard.down('Control');await page.keyboard.press('KeyY');await page.keyboard.up('Control');assert.equal(await page.evaluate(()=>game.builder.layout.pieces.length),3);
  await page.focus('#builder-code');await page.keyboard.press('Space');assert.match(await page.$eval('#builder-text',e=>e.value),/ramp-medium/);await shot('03-export-code');
  // Moving a road on a raised platform keeps its height; it must not add the platform height twice.
  const stacked=await page.evaluate(()=>{
    const g=game,x=g.car.pos.x,z=g.car.pos.z,y=g.world.baseHeightAt(x,z)+20;
    const p=(id,type,Y)=>({id,type,x,y:Y,z,yaw:0,scale:1});
    g.builder.replace({version:1,pieces:[p('support','platform',y),p('road','road-straight',y+3)]});
    g.camera.position.set(x,y+35,z+35);g.camera.lookAt(x,y+3,z);g.camera.updateMatrixWorld();
    const target=g.car.pos.clone().set(x,y+3.12,z).project(g.camera);
    return {screen:[(target.x+1)*640,(1-target.y)*400],y:y+3};
  });
  await page.mouse.click(...stacked.screen);
  assert.equal(await page.evaluate(()=>document.activeElement.matches('input,textarea,select')),false,'canvas restores editor shortcuts after editing code');
  assert.match(await page.$eval('#builder-status',e=>e.textContent),/Straight road selected/);
  await page.click('#builder-move');await page.mouse.move(...stacked.screen);await page.mouse.click(...stacked.screen);
  assert.ok(Math.abs(await page.evaluate(()=>game.builder.layout.pieces.find(p=>p.id==='road').y)-stacked.y)<.01,'moving preserves support height');
  // A level, elevated runway avoids changing any existing terrain; drive the real car into its ramp.
  await page.evaluate(()=>{
    const g=game,x=g.car.pos.x,z=g.car.pos.z,y=g.world.heightAt(x,z)+20;
    const p=(id,type,X,Z,Y,scale=1)=>({id,type,x:X,y:Y,z:Z,yaw:0,scale});
    g.builder.replace({version:1,pieces:[p('base','platform',x,z,y-12,4),p('jump','ramp-medium',x,z,y)]});
    g.builder.close(false);g.car.reset(x,z-28,0);g.car.pos.y=y+1.3;g.car.vel.set(0,0,30);g.car.savePrev();g.keys.add('KeyW');
    window.builderShotBase=y;
  });
  await page.waitForFunction(()=>game.car.airTime>.12&&game.car.pos.y>window.builderShotBase+2,{timeout:15000,polling:16});
  report.jump=await page.evaluate(()=>({position:game.car.pos.toArray(),air:game.car.airTime,speed:game.car.vel.length()}));await shot('04-car-jump');await page.evaluate(()=>game.keys.clear());
  // 200 pieces, settled render frames. Record evidence, do not invent a cross-machine frame threshold.
  await page.evaluate(()=>{
    const g=game,x=g.car.pos.x,z=g.car.pos.z,y=g.world.heightAt(x,z);
    g.builder.replace({version:1,pieces:Array.from({length:200},(_,i)=>({id:`p${i}`,type:'ramp-small',x:x+(i%20-10)*15,z:z+(Math.floor(i/20)-5)*25,y,yaw:0,scale:1}))});
  });
  report.frames=await page.evaluate(async()=>{const frames=[];let last=performance.now();await new Promise(resolve=>{const f=t=>{frames.push(t-last);last=t;if(frames.length<120)requestAnimationFrame(f);else resolve();};requestAnimationFrame(f);});frames.sort((a,b)=>a-b);return {median:frames[60],p95:frames[114],calls:game.renderer.info.render.calls,triangles:game.renderer.info.render.triangles};});
  await shot('05-200-pieces');
  assert.deepEqual(errors,[]);report.errors=errors;await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();}
