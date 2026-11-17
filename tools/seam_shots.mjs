// Director browser evidence; run under the heavy gate with game servers already running.
// node tools/seam_shots.mjs --out /tmp/yr-seams --before http://127.0.0.1:8174/
// 4 borders x ground/150/800 m x midday/dusk, identical fixed poses before/after.
// Review PNGs for gaps, lighting, picture lines, road/tree breaks; JSON records
// coordinates, camera pose, triangles, draw calls, frame/render times and errors.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer from 'puppeteer-core';
import { startGame, holdCar, watchErrors, GAME_URL } from './lib/startgame.mjs';
const { values } = parseArgs({ options: {
  out: { type: 'string', default: '/tmp/yr-seams' }, before: { type: 'string' },
  url: { type: 'string', default: GAME_URL }, only: { type: 'string', default: '' },
} });
const sites = [
  { name: 'campus-east', x: 1000, z: -420, axis: 'x' },
  { name: 'sheridan-west', x: 3000, z: -220, axis: 'x' },
  { name: 'campus-south', x: 340, z: 1000, axis: 'z' },
  { name: 'mcminnville-west', x: 19000, z: -10900, axis: 'x' },
].filter(s => s.name.includes(values.only));
assert(sites.length, 'no sites match --only');
await fs.mkdir(values.out, { recursive: true });
const errors = [], report = [];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] });
try {
  for (const [label,url] of [...(values.before ? [['before',values.before]] : []), ['after',values.url]]) {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    try {
      await page.setViewport({ width: 1280, height: 800 });
      watchErrors(page,label,errors);
      page.on('console', m => { if(m.type()==='error' && !/favicon|cloudflareinsights/.test(m.text())) errors.push(`${label}: ${m.text()}`); });
      page.on('response', r => { if(r.status()>=400 && !/favicon|cloudflareinsights/.test(r.url())) errors.push(`${label}: HTTP ${r.status()} ${r.url()}`); });
      page.on('requestfailed', r => { if(!/favicon|cloudflareinsights/.test(r.url())) errors.push(`${label}: ${r.failure()?.errorText} ${r.url()}`); });
      await startGame(page,{url});
      await page.waitForFunction(() => game.warmup.done, {timeout:120000});
      await page.evaluate(() => {
        const g=game, original=g.renderer.render.bind(g.renderer), lod=g.world.updateLOD.bind(g.world);
        const V=g.camera.position.constructor;
        window.__seam={pose:null,frames:[],renders:[],last:0};
        const car=g.vehicles.current, step=car.step.bind(car);
        car.step=(dt,input)=>{if(__seam.pose){car.vel.set(0,0,0);return;}return step(dt,input);};
        // Both streaming/LOD and the rendered view must use the measured pose.
        g.world.updateLOD=(p,v,extra)=>lod(__seam.pose ? new V(...__seam.pose.eye) : p, __seam.pose ? new V() : v, extra);
        g.renderer.render=(scene,camera)=>{
          const s=__seam;
          if(s.pose && camera===g.camera){
            camera.position.set(...s.pose.eye);camera.up.set(0,1,0);camera.lookAt(new V(...s.pose.target));camera.fov=55;camera.updateProjectionMatrix();camera.updateMatrixWorld();
            g.vehicles.current.mesh.visible=false;
          }
          const t=performance.now();original(scene,camera);
          if(s.pose && camera===g.camera){s.renders.push(performance.now()-t);if(s.last)s.frames.push(t-s.last);s.last=t;}
        };
        const tick=g.world.tick.bind(g.world);g.world.tick=()=>tick(0);
        g.atmosphere.speed=0;g.atmosphere.set({cycle:true,weather:'clear'},false);
      });
      for (const site of sites) {
        await page.evaluate(()=>{__seam.pose=null;});
        await holdCar(page,{...site,kind:'car'});
        for(const altitude of [3,150,800]) for(const [look,minute] of [['midday',15],['dusk',29.5]]) {
          const name=`${site.name}-${altitude===3?'ground':altitude+'m'}-${look}`;
          const pose=await page.evaluate(({site,altitude,minute})=>{
            const g=game, h=g.world.terrainAt(site.x,site.z), d=altitude===3?35:altitude*.65;
            const ex=site.x-(site.axis==='x'?d:20), ez=site.z-(site.axis==='z'?d:20);
            const ey=Math.max(h+altitude,g.world.terrainAt(ex,ez)+3);
            __seam.pose={eye:[ex,ey,ez],target:[site.x,h+.5,site.z]};
            g.atmosphere.jump(minute*60);g.atmosphere.update(0,g.camera);
            return __seam.pose;
          },{site,altitude,minute});
          await new Promise(r=>setTimeout(r,1500));
          await page.waitForFunction(()=>game.world.pendingTiles()===0,{timeout:120000});
          await new Promise(r=>setTimeout(r,500));
          await page.evaluate(()=>{__seam.frames=[];__seam.renders=[];__seam.last=0;});
          await new Promise(r=>setTimeout(r,2000));
          const stats=await page.evaluate(()=>{
            const quantile=(a,q)=>{a=[...a].sort((a,b)=>a-b);return a[Math.min(a.length-1,Math.floor(a.length*q))];};
            const s=__seam,r=game.renderer.info.render,p=s.pose.target;
            return {frames:s.frames.length,medianMs:quantile(s.frames,.5),p95Ms:quantile(s.frames,.95),renderMedianMs:quantile(s.renders,.5),renderP95Ms:quantile(s.renders,.95),
              triangles:r.triangles,calls:r.calls,pending:game.world.pendingTiles(),ground:game.world.loadedAt(p[0]-2,p[2]-2)&&game.world.loadedAt(p[0]+2,p[2]+2)};
          });
          assert(stats.frames>=10 && stats.ground && stats.pending===0,`${name}: incomplete sampling/ground`);
          const file=`${label}-${name}.png`;
          await page.screenshot({path:path.join(values.out,file)});
          report.push({label,name,site,altitude,look,pose,file,...stats});console.log(label,name,JSON.stringify(stats));
        }
      }
    } finally { await context.close(); }
  }
  if(values.before) console.table(report.filter(r=>r.label==='after').map(r=>{
    const b=report.find(b=>b.label==='before'&&b.name===r.name);
    return {name:r.name,triangleDelta:r.triangles-b.triangles,drawCallDelta:r.calls-b.calls,
      frameMedianDelta:r.medianMs-b.medianMs,renderMedianDelta:r.renderMedianMs-b.renderMedianMs,renderP95Delta:r.renderP95Ms-b.renderP95Ms};
  }));
  assert.equal(errors.length,0,errors.join('\n'));
} finally {
  await fs.writeFile(path.join(values.out,'seams.json'),JSON.stringify({report,errors},null,2));
  await browser.close();
}
console.log(`PASS capture checks: ${report.length} PNGs; visual verdict and before/after performance review still required in ${values.out}`);
