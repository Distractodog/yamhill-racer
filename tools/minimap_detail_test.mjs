import assert from 'node:assert/strict';
import {createMapDetail} from '../game/src/minimapdetail.js';
const tiles=[];for(let x=-5;x<=5;x++)for(let z=-5;z<=5;z++)tiles.push([x,z]);
const meta={mpp:5,extent:[-11000,-11000,11000,11000],detail:{tile:2000,path:'detail/',tiles}};
const calls=[],draws=[],jobs=[];let active=0,maxActive=0;
const detail=createMapDetail(meta,'assets/',url=>{calls.push(url);maxActive=Math.max(maxActive,++active);return new Promise(resolve=>jobs.push(()=>{active--;resolve({url});}));});
const ctx={canvas:{width:420,height:420},drawImage:(...args)=>draws.push(args)};
const tick=()=>new Promise(r=>setTimeout(r,0));
async function finish(){while(jobs.length){jobs.splice(0).forEach(f=>f());await tick();}}
const view=(x,z,scale=1)=>detail.draw(ctx,210-(x+11000)*scale,210-(z+11000)*scale,scale*5);
view(0,0,.01);assert.equal(calls.length,0,'overview must not download detail');
view(0,0);await finish();view(0,0);assert.equal(calls.length,1);assert.equal(draws.length,1);assert.match(calls[0],/0_0.webp$/);
view(1000,1000);await finish();view(1000,1000);assert.equal(calls.length,4);assert.ok(maxActive<=2,'bounded request concurrency');
const before=calls.length;for(let i=0;i<100;i++)view(1000,1000);assert.equal(calls.length,before,'no duplicate loads every frame');
// Pan through more than twelve tiles, then return: old images must have been evicted.
for(let x=-4;x<=4;x++){view(x*2000,-4000);await finish();view(x*2000,4000);await finish();}
const count=calls.length;view(0,0);await finish();assert.equal(calls.length,count+1,'bounded decoded-image cache');
let failures=0;const broken=createMapDetail(meta,'assets/',async()=>{failures++;throw Error('offline');});
broken.draw(ctx,-10790,-10790,5);await tick();broken.draw(ctx,-10790,-10790,5);await tick();assert.equal(failures,1,'failed images back off rather than retrying every frame');
console.log('Minimap detail: viewport loading, cache eviction, concurrency, reuse, and error backoff passed');
