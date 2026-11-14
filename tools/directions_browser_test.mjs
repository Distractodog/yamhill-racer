import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const out=process.argv[2] || '/tmp/yamhill-directions'; fs.mkdirSync(out,{recursive:true});
const browser=await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal']});
try {
 const page=await browser.newPage(); await page.setViewport({width:1280,height:760});
 const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 await page.evaluateOnNewDocument(()=>localStorage.setItem('yr-welcome-hidden-1','1'));
 await page.goto(process.env.GAME_URL || 'http://127.0.0.1:8173/'); await page.waitForFunction(()=>window.game,{timeout:90000});
 const data=JSON.parse(fs.readFileSync(new URL('../game/assets/navigation.json',import.meta.url)));
 const start=data.nodes.find(p=>p[0]>-700 && p[0]<-400 && p[1]>0 && p[1]<200);
 async function mapClick(x,z) {
 const point=await page.evaluate(async(x,z)=>{const m=await fetch('./assets/minimap.json').then(r=>r.json()),img=new Image();img.src='./assets/minimap.jpg';await img.decode();const r=document.querySelector('#fullmap canvas').getBoundingClientRect();const s=Math.min(r.width/img.width,r.height/img.height);return [r.x+r.width/2+((x-m.extent[0])/m.mpp-img.width/2)*s,r.y+r.height/2+((z-m.extent[1])/m.mpp-img.height/2)*s];},x,z);
 await page.mouse.click(...point);
 }
 await mapClick(...start);
 await page.waitForFunction(()=>!document.querySelector('#fullmap').classList.contains('spawn-picker'),{timeout:90000});
 await page.evaluate(()=>document.querySelector('#welcome-start')?.click());
 await page.waitForFunction(()=>game.car.grounded,{timeout:30000});
 console.log('Start',await page.evaluate(()=>({x:game.car.pos.x,z:game.car.pos.z,surface:game.car.surface})));
 await page.evaluate(()=>game.minimap.toggle(true)); await page.click('[data-z="directions"]');
 await page.waitForFunction(()=>document.querySelector('[data-z="directions"]').getAttribute('aria-pressed')==='true',{timeout:20000});
 const destination=data.nodes.find(p=>p[0]>3500 && p[0]<3900 && p[1]>1300 && p[1]<1500);
 await mapClick(...destination); await page.waitForFunction(()=>game.directions.active,{timeout:10000});
 console.log('Route',await page.evaluate(()=>({distance:game.directions.active.distance,points:game.directions.active.points.length,hud:document.querySelector('#minimap .mm-route').textContent})));
 await page.screenshot({path:out+'/directions-map.png'});
 await page.evaluate(()=>game.minimap.toggle(false)); await new Promise(r=>setTimeout(r,1000));
 await page.screenshot({path:out+'/directions-driving.png'});
 const perf=await page.evaluate(async()=>{const measure=()=>new Promise(resolve=>{const times=[];let prev=performance.now();function tick(now){times.push(now-prev);prev=now;if(times.length<180)requestAnimationFrame(tick);else{times.sort((a,b)=>a-b);resolve({median:times[90],p95:times[171],slow:times.filter(t=>t>20).length});}}requestAnimationFrame(tick);});const withRoute=await measure();game.directions.clear();const withoutRoute=await measure();return {withRoute,withoutRoute};});
 console.log('Frame timing',perf);
 await page.evaluate(()=>{game.car.grounded=false;game.directions.begin();});
 assert.match(await page.$eval('#minimap .mm-route',e=>e.textContent),/Start on a road/);
 assert.deepEqual(errors,[]); console.log('Browser checks passed; no page errors');
} finally {await browser.close();}
