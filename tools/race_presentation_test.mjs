import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { createChallenges } from '../game/src/challenges.js';
const elements = new Map(), controls = new Map(), storage = new Map();
const canvas={fillRect(){},beginPath(){},moveTo(){},lineTo(){},fill(){}};
function element(){return {style:{},setAttribute(){},addEventListener(){},append(e){if(e.id)elements.set(e.id,e);},querySelectorAll(){return [];},getContext(){return canvas;},querySelector(selector){if(!controls.has(selector))controls.set(selector,{addEventListener(type,fn){this[type]=fn;}});return controls.get(selector);}};}
globalThis.document={createElement:element,head:element(),body:element()};
globalThis.localStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
let keydown;globalThis.addEventListener=(type,fn)=>{if(type==='keydown')keydown=fn;};
const race={id:'long-walk',name:'Test finish',start:{x:0,z:0,yaw:0},route:[[0,0],[0,10]],gates:[0,10].map(z=>({x:0,z,yaw:0,w:16}))};
const bikeRace={id:'bike-test',vehicle:'bike',name:'Test bike',start:{x:500,z:0,yaw:0},route:[[500,0],[500,10]],gates:[0,10].map(z=>({x:500,z,yaw:0,w:16}))};
globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('challenges.json')?[race,bikeRace]:[]});
const world={heightAt:()=>0,terrainAt:()=>0,groundAt:()=>0,surfaceAt:()=>3,waterLevelAt:()=>-Infinity,normalAt:(_x,_z,n)=>n.set(0,1,0),treesNear(){},buildingsNear:()=>[],loadedAt:()=>true,pendingTiles:()=>0,extent:[-1000,-1000,1000,1000],rampAt:()=>null};
const car=new Car(world,{...TUNING_DEFAULTS});
const challenges=await createChallenges({scene:new THREE.Scene(),world,car,minimap:{open:false}});
async function finish(){await challenges.start(0);challenges.update(3.01);car.pos.z=9;challenges.update(.1);car.pos.z=11;challenges.update(.1);assert.equal(challenges.state,'finished');}
await finish();assert(challenges.rewards.has('campus'));assert.match(elements.get('ch-done').innerHTML,/NEW LIVERY UNLOCKED/);
for(const code of ['Enter','Space','NumpadEnter']){const e={code,target:{closest:()=>({})}};keydown(e);assert.equal(e.gameUI,true);assert.equal(challenges.state,'finished','native action key must not restart the race');}
controls.get('[data-action="roam"]').click();assert.equal(challenges.state,'idle');
await finish();assert.doesNotMatch(elements.get('ch-done').innerHTML,/NEW LIVERY UNLOCKED/);
controls.get('[data-action="races"]').click();assert(challenges.menuOpen);assert.equal(elements.get('ch-done').style.display,'none');
challenges.closeMenu();assert.equal(elements.get('ch-done').style.display,'block');
await controls.get('[data-action="retry"]').click();assert.equal(challenges.state,'countdown');
challenges.quit();
// medals on the finish screen: targets from challenges.json, the medal earned, personal best, the best medal saved, Next race
race.medals={gold:5,silver:6,bronze:8};await finish();const html=elements.get('ch-done').innerHTML;
assert.match(html,/ch-medal gold/);assert.match(html,/Personal best/);assert.match(html,/ch-targets/);assert.match(html,/data-action="next"/);
assert.equal(challenges.medals.get('long-walk'),'gold');assert.match(storage.get('yr-medals-1'),/"long-walk":"gold"/);
await controls.get('[data-action="next"]').click();assert.equal(challenges.state,'countdown');assert.equal(challenges.runInfo().id,'bike-test');
challenges.quit();
// J reopens on the card + filter you left the menu on, not the race you last started
challenges.openMenu();challenges.raceMenu.setFilter('bike');challenges.raceMenu.select(1);challenges.closeMenu();
await challenges.start(0);challenges.quit();
challenges.openMenu();assert.equal(challenges.raceMenu.selected,1,'last selected card');assert.equal(challenges.raceMenu.filter,'bike','last filter');challenges.closeMenu();
challenges.openMenu(0,{filter:'all'});assert.equal(challenges.raceMenu.selected,0,'a start ring picks its race');challenges.closeMenu();
// main.js hooks: the menu stays shut while it may not open (spawn map, Garage); opening it tells main.js once (close other panels)
let allow=false,opened=0;
const gated=await createChallenges({scene:new THREE.Scene(),world,car,minimap:{open:false},canOpenMenu:()=>allow,onMenuOpen:()=>opened++});
gated.openMenu();assert.equal(gated.menuOpen,false);assert.equal(opened,0);
allow=true;gated.openMenu();assert.equal(gated.menuOpen,true);assert.equal(opened,1);
gated.openMenu(0,{filter:'all'});assert.equal(opened,1,'already open: no second onMenuOpen');gated.closeMenu();assert.equal(gated.menuOpen,false);
console.log('PASS race presentation: completion unlock, no duplicate unlock, keyboard action isolation, roam, race menu, retry, medal + next race, J reopens on the last card + filter, menu gating + open hook');

// Race collider/mesh lifecycle and DNF (both solo and the multiplayer start path).
race.track=[[0,0,6],[0,10,6]]; race.ramps=[{x:0,z:5,yaw:0,w:12}];
let layer=null, raceRampCalls=0, dnfs=0;
world.setRaceBarriers=v=>{layer=v;};world.setRamps=()=>raceRampCalls++;
const scene=new THREE.Scene();
const barriers=await createChallenges({scene,world,car,minimap:{open:false}});
barriers.mpHook={onDnf(){dnfs++;}};
for(const mp of [false,true]) {
  await barriers.start(0,{mp,gridCount:4});
  assert(layer,'race installs collider layer');assert(scene.getObjectByName('race-barriers'),'one race mesh');
  barriers.update(3.01);car.pos.set(20,5,5);car.grounded=false;
  for(let i=0;i<119;i++)barriers.constrain();assert.equal(barriers.state,'running');
  for(let i=0;i<3;i++)barriers.constrain();assert.equal(barriers.state,'finished');
  assert.equal(barriers.result.dnf,true);assert.match(elements.get('ch-done').innerHTML,/Out of bounds — race over/);
  assert.match(elements.get('ch-done').innerHTML,/DNF/);assert.equal(layer,null);assert(!scene.getObjectByName('race-barriers'));
  const input={throttle:1,steer:.5};barriers.holdInput(input);assert.equal(input.throttle,1,'DNF preserves driving control');
  barriers.quit();
}
assert.equal(dnfs,2);assert.equal(raceRampCalls,0,'even legacy race ramp data must never be placed');
await barriers.start(0);barriers.update(3.01);car.pos.z=9;barriers.update(.1);car.pos.z=11;barriers.update(.1);
assert.equal(barriers.state,'finished');assert.equal(layer,null);assert(!scene.getObjectByName('race-barriers'));
await barriers.start(0);barriers.quit();assert.equal(layer,null);assert(!scene.getObjectByName('race-barriers'));
console.log('PASS race barriers: solo/MP starts, one mesh, airborne DNF, results, free control, finish/quit cleanup, legacy ramps ignored');
