// Director-only browser evidence. Start the game server separately; this script never binds a port.
// node tools/campus_sat_shots.mjs --out /tmp/campus-sat --sat <tile-0_0-naip.jpg> [--before http://127.0.0.1:8174/]
// Run through the heavy gate. Review the PNGs; numeric checks cannot approve appearance.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors, GAME_URL } from './lib/startgame.mjs';
const args=process.argv.slice(2),arg=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const out=arg('--out','/tmp/campus-sat'),before=arg('--before',null),sat=arg('--sat',null);
fs.mkdirSync(out,{recursive:true});
const cases=[
  {name:'grandstand-from-track',at:[-621.5,42.5],offset:[55,10,-35]},
  {name:'grandstand-above',at:[-558,45],top:true},
  {name:'tennis-courts',at:[-461,-163],offset:[-48,65,60]},
  {name:'tennis-utility-building',at:[-532.5,-134.6],offset:[-28,14,24]},
  {name:'north-meadow-shed',at:[-563,-568],offset:[-28,14,24]},
  {name:'trail-0_0-88-track-level',at:[-584.92,-44.34],offset:[-24,12,-22]},
  {name:'trail-0_0-144-track-level',at:[-586.86,-46.19],offset:[12,7,-25]},
  {name:'trail-0_0-132-track-level',at:[-570.32,-45.25],offset:[18,8,-23]},
  {name:'trail-0_0-122-skirt',at:[-952.51,-287.61],offset:[-20,6,22]},
  {name:'trail-0_0-59-skirt',at:[-279.59,353.60],offset:[24,7,20]},
  {name:'trail-0_0-112-rebuild-pending',at:[-104.65,-940.14],offset:[25,28,25]},
];
const trails=arg('--trails',null),only=arg('--only',null);
if(trails)for(const r of JSON.parse(fs.readFileSync(trails)).strips)cases.push({name:`trail-${r.tile}-${r.strip}-audit`,at:r.foldAt||r.buriedAt||r.start,offset:[24,24,24]});
if(only)for(let i=cases.length-1;i>=0;i--)if(!cases[i].name.includes(only))cases.splice(i,1);
const errors=[],report={shots:[],before:!!before,satellite:!!sat};
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:'new',args:['--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal']});
try {
  for(const [label,url] of [...(before?[['before',before]]:[]),['after',GAME_URL]]) {
    const page=await browser.newPage();watchErrors(page,label,errors);
    page.on('requestfailed',r=>errors.push(`${label}: ${r.url()} ${r.failure()?.errorText}`));
    page.on('response',r=>{if(r.status()>=400&&!r.url().endsWith('favicon.ico'))errors.push(`${label}: HTTP ${r.status()} ${r.url()}`);});
    await page.setViewport({width:1280,height:800});
    await startGame(page,{url,storage:{'yr-graphics-2':JSON.stringify({mode:'high'})}});
    await page.evaluate(async()=> {
      const THREE=await import('three');
      game.atmosphere?.setPreset('midday',false);
      game.atmosphere?.set({weather:'clear'},false);
      if(game.atmosphere)game.atmosphere.speed=0;
      window.__satOrtho=new THREE.OrthographicCamera(-170,170,160,-160,.1,2000);
      window.__satFrames=[];
      const render=game.renderer.render.bind(game.renderer);let last=performance.now();
      game.renderer.render=(scene,camera)=> {
        const shot=window.__satPose;
        if(shot) {
          const y=game.world.terrainAt(...shot.at),v=game.vehicles.current;
          if(v.mesh)v.mesh.visible=false;
          if(shot.top){camera=window.__satOrtho;camera.position.set(shot.at[0],y+600,shot.at[1]);camera.up.set(0,0,-1);}
          else {camera.position.set(shot.at[0]+shot.offset[0],y+shot.offset[1],shot.at[1]+shot.offset[2]);camera.up.set(0,1,0);}
          camera.lookAt(shot.at[0],y+(shot.top?0:2),shot.at[1]);camera.updateMatrixWorld();
        }
        const now=performance.now();window.__satFrames.push(now-last);last=now;
        render(scene,camera);
      };
    });
    await page.addStyleTag({content:'body > :not(canvas) { visibility:hidden !important; }'});
    for(const shot of cases) {
      await holdCar(page,{x:shot.at[0],z:shot.at[1]});
      await page.setViewport(shot.top?{width:1020,height:960}:{width:1280,height:800});
      await page.evaluate(shot=>{window.__satPose=shot;window.__satFrames=[];},shot);
      await new Promise(r=>setTimeout(r,1800));
      const file=path.join(out,`${label}-${shot.name}.png`);
      await page.screenshot({path:file});
      const state=await page.evaluate(()=> {
        const times=window.__satFrames.slice(5).sort((a,b)=>a-b);
        return {median:times[times.length>>1],p95:times[Math.floor(times.length*.95)],triangles:game.renderer.info.render.triangles,calls:game.renderer.info.render.calls,ground:game.world.loadedAt(...window.__satPose.at)};
      });
      report.shots.push({label,...shot,file,...state});
      if(!state.ground)errors.push(`${shot.name}: ground missing`);
      console.log(label,shot.name,state);
    }
    await page.close();
  }
  if(sat && fs.existsSync(path.join(out,'after-grandstand-above.png'))) {
    const page=await browser.newPage();await page.setViewport({width:1360,height:720});
    await page.setContent('<body style="margin:0;background:#202329;color:white;font:16px sans-serif"><canvas width="1360" height="720"></canvas></body>');
    await page.evaluate(async(satellite,gameImage)=> {
      const load=async src=>{const i=new Image();i.src=src;await i.decode();return i;};
      const [a,b]=await Promise.all([load(satellite),load(gameImage)]),c=document.querySelector('canvas').getContext('2d');
      c.fillStyle='#202329';c.fillRect(0,0,1360,720);c.fillStyle='white';
      c.fillText('Game — x -728..-388, z -115..205',15,25);c.fillText('NAIP — same bounds, north up',695,25);
      c.drawImage(b,10,50,660,621);c.drawImage(a,336,949,340,320,690,50,660,621);
    },'data:image/jpeg;base64,'+fs.readFileSync(sat).toString('base64'),'data:image/png;base64,'+fs.readFileSync(path.join(out,'after-grandstand-above.png')).toString('base64'));
    await page.screenshot({path:path.join(out,'grandstand-satellite-comparison.png')});await page.close();
  } else console.log('NOT VERIFIED: satellite comparison requires --sat <tile-0_0-naip.jpg>');
} finally {await browser.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...report,errors},null,2)+'\n');}
if(errors.length)throw Error(errors.join('\n'));
