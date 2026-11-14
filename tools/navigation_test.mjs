import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRoadGraph, routeProgress } from '../game/src/navigation.js';
const g=createRoadGraph({nodes:[[0,0],[100,0],[100,100],[300,0],[400,0]],edges:[[0,1,10],[1,2,10],[3,4,10]]});
assert.equal(g.snap(50,6),null);
assert.equal(g.snap(50,5).distance,5);
const a=g.snap(20,0),b=g.snap(100,80);
assert.equal(g.route(a,b).distance,160);
assert.deepEqual(g.route(a,b).points,[[20,0],[100,0],[100,80]]);
assert.equal(g.route(a,g.snap(60,0)).distance,40);
assert.equal(g.route(g.snap(60,0),a).distance,40);
assert.equal(g.route(a,g.snap(350,0)),null);
assert.equal(g.route(a,a).distance,0);
assert.equal(routeProgress(g.route(a,b).points,100,40).remaining,40);
const data=JSON.parse(fs.readFileSync(new URL('../game/assets/navigation.json',import.meta.url)));
const t=performance.now(), real=createRoadGraph(data);
console.log('Graph setup ms',Math.round(performance.now()-t));
// Pick actual road strips closest to the named locations, then test across tile seams.
function near(x,z) { let best=null; for(const [a,b,w] of data.edges) { if(!w) continue; for(const n of [a,b]) { const p=data.nodes[n],d=Math.hypot(p[0]-x,p[1]-z); if(!best || d<best.d) best={p,d}; } } return real.snap(...best.p); }
const campus=near(-560,60);
for(const [name,x,z] of [['Sheridan',3800,1400],['Willamina',-3640,3330],['McMinnville',19100,-11000]]) {
 const before=performance.now(), route=real.route(campus,near(x,z)); assert.ok(route,name); console.log(name,Math.round(route.distance),'m',Math.round(performance.now()-before),'ms');
}
const bridge=createRoadGraph({nodes:[[0,0,0],[100,0,0],[50,-50,10],[50,50,10]],edges:[[0,1,10],[2,3,10]]});
assert.equal(bridge.snap(50,0,0,11).id,1);
const manifest=JSON.parse(fs.readFileSync(new URL('../game/assets/world.json',import.meta.url)));
if(manifest.rim) for(const [a,b] of data.edges) for(const n of [a,b]) assert.ok(Math.hypot(data.nodes[n][0]-manifest.rim.cx,data.nodes[n][1]-manifest.rim.cz)<=manifest.rim.r-7.98,'Route outside playable rim');
console.log('Navigation tests passed');
