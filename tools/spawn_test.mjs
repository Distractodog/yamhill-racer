import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--enable-gpu','--ignore-gpu-blocklist','--use-angle=metal']});
try {
 const page=await browser.newPage(); await page.setViewport({width:1280,height:760});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.GAME_URL || 'http://127.0.0.1:8173');
 await page.waitForFunction(()=>window.game?.sessionSpawn,{timeout:120000});
 assert(await page.evaluate(()=>game.sessionSpawn.blocked && game.minimap.open));
 await page.keyboard.press('Escape');await page.keyboard.press('h');
 assert(await page.evaluate(()=>game.sessionSpawn.blocked && game.minimap.open));
 await page.screenshot({path:'/tmp/spawn-picker.png'});
 // Convert world coordinates using the same image fit as the whole-map view.
 async function clickWorld(x,z) {
 const p=await page.evaluate(async(x,z)=>{const m=await fetch('./assets/minimap.json').then(r=>r.json());const im=new Image();im.src='./assets/minimap.jpg';await im.decode();const r=document.querySelector('#fullmap canvas').getBoundingClientRect();const s=Math.min(r.width/im.width,r.height/im.height);return [r.left+r.width/2+((x-m.extent[0])/m.mpp-im.width/2)*s,r.top+r.height/2+((z-m.extent[1])/m.mpp-im.height/2)*s];},x,z);await page.mouse.click(...p);
 }
 await clickWorld(3800,1400);
 await page.waitForFunction(()=>!game.sessionSpawn.blocked,{timeout:60000});
 await page.keyboard.press('Escape');
 const spawn=await page.evaluate(()=>game.sessionSpawn.point);assert(Math.hypot(spawn[0]-3800,spawn[1]-1400)<30);
 await page.evaluate(()=>game.teleport(-500,400));await page.keyboard.press('h');
 await page.waitForFunction(()=>!game.sessionSpawn.blocked,{timeout:60000});
 assert(await page.evaluate(()=>Math.hypot(game.car.pos.x-game.sessionSpawn.point[0],game.car.pos.z-game.sessionSpawn.point[1])<3));
 await page.screenshot({path:'/tmp/spawn-arrival.png'});
 await page.evaluate(()=>localStorage.setItem('yr-welcome-hidden-1','1'));
 await page.reload();await page.waitForFunction(()=>window.game?.sessionSpawn,{timeout:120000});
 assert(await page.evaluate(()=>game.sessionSpawn.blocked && game.sessionSpawn.point===null && game.minimap.open));
 assert.deepEqual(errors,[]);console.log('PASS: picker, blocked shortcuts, distant spawn, H return, reload with hidden welcome, no page errors');
} finally {await browser.close();}
