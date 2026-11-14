import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRain } from '../game/src/weatherfx.js';
import { createAtmosphere } from '../game/src/atmosphere.js';
const scene = new THREE.Scene(); const rain = createRain({scene});
const mesh = scene.getObjectByName('nearby-rain');
assert.equal(rain.count,360);assert.equal(mesh.visible,false);assert.equal(mesh.geometry.attributes.position.count,720);
const position = mesh.geometry.attributes.position, camera = new THREE.Vector3(10,30,-100);
rain.update(.1,camera);assert.equal(position.version,0,'dry presets skip buffer work');
rain.setEnabled(true);rain.update(.1,camera);assert(mesh.visible);assert.deepEqual(mesh.position.toArray(),camera.toArray());
const initial=position.array.slice();rain.update(.1,camera);assert.notDeepEqual(position.array,initial);
for(const dt of [0,-1,NaN,Infinity,.1,1000]){
 camera.set(5000,300,-3000);rain.update(dt,camera);
 for(let i=0;i<position.count;i++){assert(Number.isFinite(position.getX(i)));assert(Math.abs(position.getX(i))<=22.2);assert(Number.isFinite(position.getY(i)));assert(Math.abs(position.getZ(i))<=22.2);}
}
rain.setEnabled(false);const version=position.version;rain.update(.1,camera);assert.equal(position.version,version);
let disposed=0;mesh.geometry.addEventListener('dispose',()=>disposed++);mesh.material.addEventListener('dispose',()=>disposed++);
rain.dispose();rain.dispose();assert.equal(disposed,2);assert(!scene.getObjectByName('nearby-rain'));
scene.background = new THREE.Color();scene.fog = new THREE.Fog(0,1,2);scene.add(new THREE.HemisphereLight());
const stored=new Map([['yr-atmosphere-1','rain']]);let wet=-1;
const atmosphere=createAtmosphere({scene,sun:new THREE.DirectionalLight(),sunDirection:new THREE.Vector3(),world:{setWetness:v=>wet=v},storage:{getItem:k=>stored.get(k),setItem:(k,v)=>stored.set(k,v)}});
assert.equal(atmosphere.preset,'rain');assert.equal(atmosphere.wetness,.8);assert.equal(wet,.8);assert(scene.getObjectByName('nearby-rain').visible);
atmosphere.setPreset('midday');assert.equal(atmosphere.wetness,0);assert.equal(wet,0);assert(!scene.getObjectByName('nearby-rain').visible);
atmosphere.dispose();assert(!scene.getObjectByName('nearby-rain'));
console.log('PASS: fixed rain budget, no dry-frame buffer work, camera-follow finite particles, safe dt, disposable GPU resources, rain persistence and wetness reset');
