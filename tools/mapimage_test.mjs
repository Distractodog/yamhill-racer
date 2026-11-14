import assert from 'node:assert/strict';
import { drawMapImage } from '../game/src/mapimage.js';
let creates=0,copies=[];
globalThis.document={createElement(){creates++;return{width:0,height:0,getContext(){return{drawImage(...a){copies.push(a);}};}};}};
const image={naturalWidth:9600,naturalHeight:9600};
let draws=[],rects=[];
const ctx={canvas:{width:420,height:300},save(){},restore(){},beginPath(){},rect(...a){rects.push(a);},clip(){},drawImage(...a){draws.push(a);}};
const view=(x,y,s=1)=>drawMapImage(ctx,image,-x*s,-y*s,s);
view(5000,5000);const initial=creates;assert(initial>0&&initial<=4);
for(let i=0;i<100;i++)view(5000,5000);
assert.equal(creates,initial,'stable frames reuse exact original-resolution patches');
for(const [img,sx,sy,sw,sh,dx,dy,dw,dh]of copies){assert.equal(img,image);assert(sx>=0&&sy>=0&&sx+sw<=9600&&sy+sh<=9600);assert.equal(sw,dw);assert.equal(sh,dh);assert.equal(dx,0);assert.equal(dy,0);}
assert(draws.every(a=>a[0]!==image),'close view never submits giant image to visible canvas');
for(let i=0;i<30;i++)view((i%18)*512,Math.floor(i/18)*512);
const before=creates;view(5000,5000);assert(creates>before,'LRU evicts old patches');
// Eviction count: every isolated 512-square view requires only one patch;
// first of 17 distinct tiles must be evicted at the 16-entry limit.
const other={width:9600,height:9600};ctx.canvas={width:512,height:512};
for(let i=0;i<17;i++)drawMapImage(ctx,other,-i*512,0,1);
const n=creates;drawMapImage(ctx,other,0,0,1);assert.equal(creates,n+1);
// Exact original pixel mapping at fractional scale and partial map edges.
draws=[];copies=[];rects=[];ctx.canvas={width:420,height:300};
drawMapImage(ctx,{width:9600,height:9600},-12345.678,-9876.123,2.718);
for(let i=0;i<draws.length;i++){const [patch,dx,dy,dw,dh]=draws[i],copy=copies[i];assert(Math.abs(dx-(-12345.678+copy[1]*2.718))<1e-8);assert(Math.abs(dy-(-9876.123+copy[2]*2.718))<1e-8);assert.equal(dw,patch.width*2.718);assert.equal(dh,patch.height*2.718);}
draws=[];view(0,0,.02);assert.equal(draws[0][0],image,'overview keeps full original source');
const saved=creates;for(const scale of [0,-1,NaN,Infinity])drawMapImage(ctx,image,0,0,scale);assert.equal(creates,saved);
console.log('PASS: original-resolution patches, repeat-frame reuse, 16-entry eviction, padded bounds, fractional pixel mapping, overview fallback');
