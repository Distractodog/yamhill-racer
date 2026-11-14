import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildGliderModel, BIKE_GLIDER } from '../game/src/glider.js';
import { GLIDER_COLORS, setGliderColors, addGliderColorSettings } from '../game/src/glidercolors.js';
function check(model, palette) {
  const sail=model.getObjectByName('glider-sail'), a=sail.geometry.getAttribute('color');
  const colors=[palette.stripe,palette.wing,palette.accent].map(hex=>new THREE.Color(hex));
  for(let i=0;i<a.count;i++) {
    const c=colors[sail.geometry.userData.gliderPanels[i]];
    assert.ok(Math.abs(a.getX(i)-c.r)<1e-6 && Math.abs(a.getY(i)-c.g)<1e-6 && Math.abs(a.getZ(i)-c.b)<1e-6);
  }
  assert.equal(model.getObjectByName('glider-fin').material.color.getHexString(),new THREE.Color(palette.wing).getHexString());
}
const car=buildGliderModel(),bike=buildGliderModel(BIKE_GLIDER.model);
check(car,GLIDER_COLORS);check(bike,GLIDER_COLORS);
const custom={wing:'#2355ee',stripe:'#00aabb',accent:'#cc11cc'};
const geometry=car.getObjectByName('glider-sail').geometry;
setGliderColors(car,custom);check(car,custom);check(bike,GLIDER_COLORS);
assert.equal(car.getObjectByName('glider-sail').geometry,geometry,'Painting must not rebuild geometry');
function fakeGUI() {
  const controls=[];
  return { controls,addFolder(){return this;},close(){},controllersRecursive(){return controls;},
    addColor(object,key){return this.add(object,key);},add(object,key){const c={object,key,name(){return c;},onChange(f){c.change=f;return c;},updateDisplay(){}};controls.push(c);return c;} };
}
let saved='{}';const storage={getItem:()=>saved,setItem:(_,value)=>saved=value};
const gui=fakeGUI(),palettes=addGliderColorSettings(gui,{car:{mesh:car},bike:{mesh:bike}},storage);
const stripe=gui.controls.find(c=>c.key==='stripe');stripe.object.stripe='#0033cc';stripe.change();
assert.equal(JSON.parse(saved).car.stripe,'#0033cc');check(car,palettes.car);
const solid=gui.controls.find(c=>c.key==='solid');solid.object.solid();
check(car,{wing:palettes.car.wing,stripe:palettes.car.wing,accent:palettes.car.wing});
const reloaded=buildGliderModel();addGliderColorSettings(fakeGUI(),{car:{mesh:reloaded}},storage);check(reloaded,palettes.car);
gui.controls.find(c=>c.key==='reset').object.reset();check(car,GLIDER_COLORS);
saved='{"car":{"wing":"not a color","stripe":null,"accent":123}}';
addGliderColorSettings(fakeGUI(),{car:{mesh:car}},storage);check(car,GLIDER_COLORS);
assert.doesNotThrow(()=>addGliderColorSettings(fakeGUI(),{car:{mesh:car}},{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}));
console.log('Glider palette tests passed: car/bike panel coverage, live repaint, solid wing, persistence, reset, invalid/blocked storage');
