import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ATMOSPHERE_PRESETS, createAtmosphere } from '../game/src/atmosphere.js';
import { createTileScenery, sceneryRoadSpot } from '../game/src/scenery.js';
const scene=new THREE.Scene();scene.background=new THREE.Color();scene.fog=new THREE.Fog(0,1,2);scene.add(new THREE.HemisphereLight());
const sun=new THREE.DirectionalLight(),sunDirection=new THREE.Vector3();let night;
const values=new Map([['yr-atmosphere-1','bad-value']]);const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
const a=createAtmosphere({scene,sun,sunDirection,world:{setNight:n=>night=n},storage});assert.equal(a.preset,'midday');
for(const p of ATMOSPHERE_PRESETS){assert(a.setPreset(p.id));assert.equal(night,p.night);assert.equal(scene.fog.far,p.far);assert(Math.abs(sunDirection.length()-1)<1e-8);a.update(.016,new THREE.Vector3(10,20,30));}
assert(!a.setPreset('invalid'));assert.equal(a.preset,'night');assert.equal(values.get('yr-atmosphere-1'),'night');
a.dispose();assert(!scene.getObjectByName('night-stars'));
const td={x0:3000,z0:1000,terrainAt:()=>20,renderRoads:[{n:100,kind:'asphalt',hw:7,x:Array.from({length:100},(_,i)=>3500+i*8),z:Array(100).fill(1400)}],buildings:[{h:6,pts:[[3770,1435],[3790,1435],[3790,1450],[3770,1450]]}]};
const spot=sceneryRoadSpot(td,{x:3800,z:1400});assert(spot);assert(Math.abs(spot.z-1400)>=12);
const b=createTileScenery(td);assert(b.group.children.length>0);let meshes=0,vertices=0;
b.update({x:3800,z:1400},3,1);b.update({x:100000,z:100000},4,0);
b.group.traverse(o=>{if(o.isMesh){meshes++;const p=o.geometry.attributes.position;vertices+=p.count;for(let i=0;i<p.count;i++)assert(Number.isFinite(p.getX(i))&&Number.isFinite(p.getY(i))&&Number.isFinite(p.getZ(i)));}});
assert(meshes<30);assert(vertices<10000);
const geometries=new Set();b.group.traverse(o=>{if(o.geometry)geometries.add(o.geometry);});geometries.forEach(g=>g.dispose());b.materials.forEach(m=>m.dispose());b.textures.forEach(t=>t.dispose());
console.log(`PASS: six atmosphere presets, persistence validation, star disposal, safe shoulder placement, finite scenery (${meshes} meshes / ${vertices} vertices), near/far updates.`);
