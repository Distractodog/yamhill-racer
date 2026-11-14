import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildGliderModel, BIKE_GLIDER } from '../game/src/glider.js';
import { GLIDER_COLORS, setGliderColors, createGliderColors } from '../game/src/glidercolors.js';
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
let saved='{}';const storage={getItem:()=>saved,setItem:(_,value)=>saved=value};
const colors=createGliderColors({car:{mesh:car},bike:{mesh:bike}},storage);
assert(colors.set('car',{stripe:'#0033cc'}));
assert.equal(JSON.parse(saved).car.stripe,'#0033cc');check(car,colors.get('car'));check(bike,GLIDER_COLORS);
colors.solid('car');
const palette=colors.get('car');assert.equal(palette.stripe,palette.wing);assert.equal(palette.accent,palette.wing);check(car,palette);
const reloaded=buildGliderModel();createGliderColors({car:{mesh:reloaded}},storage);check(reloaded,palette);
colors.reset('car');check(car,GLIDER_COLORS);
assert.equal(colors.get('jet'),null);
saved='{"car":{"wing":"not a color","stripe":null,"accent":123}}';
createGliderColors({car:{mesh:car}},storage);check(car,GLIDER_COLORS);
const blocked=createGliderColors({car:{mesh:car}},{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}});
assert.equal(blocked.set('car',custom),false);check(car,custom);
console.log('Glider palette tests passed: car/bike isolation, live repaint, solid wing, persistence, reset, invalid/blocked storage');
