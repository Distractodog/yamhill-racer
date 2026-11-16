// Owner-run headless evidence. --help/--dry-run never import or launch Puppeteer.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const HELP=`Usage: node tools/v3_screens.mjs --before URL --after URL --out DIRECTORY [--chrome PATH] [--dry-run]
Capture campus overhead, McMinnville Third Street, Sheridan, and the rim wall.
Before camera/vehicle poses are reused exactly for after captures (1280x800).
Launch failures and page errors exit nonzero. Images still require visual review.
--dry-run validates arguments and prints the plan without opening a browser.
--chrome defaults to CHROME_PATH or an installed Chrome/Chromium executable.`;
export function parseArgs(argv) {
  const options={};
  for(let i=0;i<argv.length;i++){
    const a=argv[i];
    if(a==='--help'||a==='-h')return{help:true};
    if(a==='--dry-run'){options.dryRun=true;continue;}
    if(!['--before','--after','--out','--chrome'].includes(a))throw Error('Unknown option: '+a);
    const value=argv[++i];if(!value||value.startsWith('--'))throw Error('Missing value for '+a);
    options[a.slice(2)]=value;
  }
  for(const k of ['before','after','out'])if(!options[k])throw Error('Required: --'+k);
  for(const k of ['before','after']){const u=new URL(options[k]);if(!['http:','https:'].includes(u.protocol))throw Error('--'+k+' must be HTTP(S)');}
  return options;
}
const SPOTS={campus:{x:-558,z:45,yaw:0,overhead:true},mcminnville:{x:19451,z:-11032,yaw:-1.573},sheridan:{x:3794,z:1288,yaw:-1.834},rim:{x:31480,z:-5000,yaw:Math.PI/2}};
async function chromePath(explicit){
  if(explicit||process.env.CHROME_PATH)return explicit||process.env.CHROME_PATH;
  const candidates=['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',path.join(os.homedir(),'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),'/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'];
  for(const base of [process.env.PROGRAMFILES,process.env['PROGRAMFILES(X86)'],process.env.LOCALAPPDATA])if(base)candidates.push(path.join(base,'Google/Chrome/Application/chrome.exe'));
  for(const p of candidates){try{await fs.access(p);return p;}catch{}}
  throw Error('Chrome not found; pass --chrome PATH');
}
async function capture(browser,url,phase,id,saved,out){
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push({type:'pageerror',message:e.message}));
  page.on('console',m=>{if(m.type()!=='error'||/cloudflareinsights/.test(m.text()+(m.location()?.url||'')))return;const location=m.location()?.url||'';let favicon=false;try{favicon=new URL(location).pathname==='/favicon.ico';}catch{}if(favicon&&/Failed to load resource.*404/.test(m.text()))return;errors.push({type:'console',message:m.text(),location});});
  page.on('requestfailed',r=>/cloudflareinsights/.test(r.url())||errors.push({type:'requestfailed',message:r.url()+': '+r.failure()?.errorText}));
  try{
    await page.setViewport({width:1280,height:800,deviceScaleFactor:1});
    await page.evaluateOnNewDocument(()=>{try{Object.defineProperty(navigator,'getGamepads',{value:()=>[]});}catch{}});
    await page.goto(url,{waitUntil:'load',timeout:120000});
    await page.waitForFunction(()=>window.game?.sessionSpawn,{timeout:120000});
    // Complete normal startup through its visible map control; do not bypass the spawn controller.
    if(await page.evaluate(()=>game.sessionSpawn.blocked)){
      await page.waitForSelector('#fullmap.open canvas',{visible:true,timeout:30000});
      const box=await(await page.$('#fullmap canvas')).boundingBox();
      if(!box)throw Error('Spawn map has no visible canvas');
      await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
      await page.waitForFunction(()=>!game.sessionSpawn.blocked,{timeout:120000});
    }
    await page.evaluate(()=>{
      document.getElementById('welcome-start')?.click();
      game.garage?.close();game.challenges.quit();game.minimap.toggle(false);dispatchEvent(new Event('blur'));
    });
    const record=await page.evaluate(async(s,id,saved)=>{
      const g=game;g.vehicles.switchTo('car');const car=g.vehicles.current;
      const sleep=ms=>new Promise(r=>setTimeout(r,ms));
      const until=async(f,label)=>{const t=performance.now();while(!f()){if(performance.now()-t>120000)throw Error('Timed out: '+label);await sleep(100);}};
      car.step=()=>{};g.keys.clear();
      function hold(){car.pos.set(s.x,car.pos.y,s.z);car.vel.set(0,0,0);car._lastLoaded=null;car.savePrev();car.interpolate(0);}
      hold();const timer=setInterval(hold,100);
      try{await until(()=>g.world.loadedAt(s.x,s.z)&&g.world.pendingTiles()===0,'target terrain');}finally{clearInterval(timer);}
      const ground=g.world.heightAt(s.x,s.z);if(!Number.isFinite(ground))throw Error('Nonfinite ground');
      car.reset(s.x,s.z,s.yaw);car.vel.set(0,0,0);car.ang?.set(0,0,0);
      if(saved){car.pos.fromArray(saved.vehicle.position);car.quat.fromArray(saved.vehicle.quaternion);}
      car.savePrev();car.interpolate(0);car.syncMesh(0);
      const rim=g.world.W.rim;
      if(id==='rim'&&(!rim||Math.abs(Math.hypot(s.x-rim.cx,s.z-rim.cz)-rim.r)>150))throw Error('Rim fixture is not within ring visibility distance');
      const camera=saved?.camera||{position:id==='rim'?[s.x-14,ground+65,s.z]:s.overhead?[s.x,350,s.z]:[s.x-Math.sin(s.yaw)*14,ground+4,s.z-Math.cos(s.yaw)*14],
        target:id==='rim'?[31500,ground+15,-5000]:[s.x,ground+1.2,s.z],up:s.overhead?[0,0,-1]:[0,1,0],fov:60,near:.1,far:12000,aspect:1280/800};
      let rendered=0;const render=g.renderer.render;
      const fix=()=>{g.camera.position.fromArray(camera.position);g.camera.up.fromArray(camera.up);g.camera.lookAt(...camera.target);Object.assign(g.camera,{fov:camera.fov,near:camera.near,far:camera.far,aspect:camera.aspect});g.camera.updateProjectionMatrix();g.camera.updateMatrixWorld();};
      g.renderer.render=function(scene,cam){if(cam===g.camera)fix();const result=render.call(this,scene,cam);if(cam===g.camera)rendered++;return result;};
      fix();await sleep(2000);await until(()=>g.world.pendingTiles()===0,'fixed-camera terrain');
      const start=rendered;await until(()=>rendered>=start+30&&g.world.pendingTiles()===0,'30 settled renders');
      const welcome=document.querySelector('#welcome');if(welcome&&!welcome.hidden&&getComputedStyle(welcome).display!=='none')throw Error('Welcome overlay is still visible');
      return{camera,vehicle:{position:car.pos.toArray(),quaternion:car.quat.toArray()},ground,source:s,packed:g.world.W.packed,viewport:[innerWidth,innerHeight],canvas:[g.renderer.domElement.width,g.renderer.domElement.height],renderedFrames:rendered,loadedTiles:g.world.loadedTiles(),pendingTiles:g.world.pendingTiles(),triangles:g.renderer.info.render.triangles,drawCalls:g.renderer.info.render.calls,userAgent:navigator.userAgent};
    },SPOTS[id],id,saved);
    if(saved&&(JSON.stringify(record.camera)!==JSON.stringify(saved.camera)||JSON.stringify(record.vehicle)!==JSON.stringify(saved.vehicle)))throw Error('Before/after pose differs');
    await page.screenshot({path:path.join(out,`${phase}-${id}.png`),type:'png'});
    record.phase=phase;record.spot=id;record.errors=errors;record.visualReview='NOT VERIFIED: owner must inspect the paired images';
    await fs.writeFile(path.join(out,`${phase}-${id}.json`),JSON.stringify(record,null,2)+'\n');
    if(errors.length)throw Error(`${phase}/${id}: ${errors.length} browser errors; see metadata`);
    return record;
  }catch(error){
    await fs.writeFile(path.join(out,`${phase}-${id}-failure.json`),JSON.stringify({phase,spot:id,status:'NOT VERIFIED',error:error.message,errors},null,2)+'\n');
    throw error;
  }finally{await page.close();}
}
async function main(){
  const options=parseArgs(process.argv.slice(2));if(options.help){console.log(HELP);return;}
  if(options.dryRun){console.log(JSON.stringify({mode:'dry-run, browser not launched',spots:SPOTS,viewport:[1280,800],captures:8,required:['before/after exact camera and vehicle pose','no browser errors','owner visual review']},null,2));return;}
  await fs.mkdir(options.out,{recursive:true});let browser;
  const report={method:'Owner-run Puppeteer headless Chrome',captureStatus:'NOT VERIFIED',visualReview:'NOT VERIFIED',spots:{}};
  try{
    const {default:puppeteer}=await import('puppeteer-core');
    browser=await puppeteer.launch({executablePath:await chromePath(options.chrome),headless:true,timeout:60000,args:['--window-size=1280,800','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    for(const id of Object.keys(SPOTS)){
      const before=await capture(browser,options.before,'before',id,null,options.out);
      const after=await capture(browser,options.after,'after',id,before,options.out);
      report.spots[id]={camera:before.camera,matchingPoses:true,beforePacked:before.packed,afterPacked:after.packed};console.log('Captured before/after '+id);
    }
    report.captureStatus='COMPLETE; visual review still required';
  }catch(error){report.error=error.message;process.exitCode=1;console.error(error.message);}
  finally{try{if(browser)await browser.close();}finally{await fs.writeFile(path.join(options.out,'summary.json'),JSON.stringify(report,null,2)+'\n');}}
}
await main().catch(e=>{console.error(e.message);process.exitCode=1;});
