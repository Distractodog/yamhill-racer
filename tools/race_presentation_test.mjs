import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Car, TUNING_DEFAULTS } from '../game/src/car.js';
import { createChallenges } from '../game/src/challenges.js';
const elements = new Map(), controls = new Map(), storage = new Map();
const canvas={fillRect(){},beginPath(){},moveTo(){},lineTo(){},fill(){}};
function element(){return {style:{},append(e){if(e.id)elements.set(e.id,e);},querySelectorAll(){return [];},getContext(){return canvas;},querySelector(selector){if(!controls.has(selector))controls.set(selector,{addEventListener(type,fn){this[type]=fn;}});return controls.get(selector);}};}
globalThis.document={createElement:element,head:element(),body:element()};
globalThis.localStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
let keydown;globalThis.addEventListener=(type,fn)=>{if(type==='keydown')keydown=fn;};
const race={id:'long-walk',name:'Test finish',start:{x:0,z:0,yaw:0},route:[[0,0],[0,10]],gates:[0,10].map(z=>({x:0,z,yaw:0,w:16}))};
globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('challenges.json')?[race]:[]});
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
challenges.quit();console.log('PASS race presentation: completion unlock, no duplicate unlock, keyboard action isolation, roam, race menu, retry');
