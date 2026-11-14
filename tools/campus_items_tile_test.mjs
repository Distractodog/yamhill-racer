import assert from 'node:assert/strict';
import * as THREE from 'three';
import { addCampusItems, campusItemGeometries, showCampusItems } from '../game/src/campusitemsmodel.js';
const geos = campusItemGeometries(), mat = new THREE.MeshBasicMaterial();
function tile(x0,z0,height) {
  const group = new THREE.Group(), lods = [];
  const td = {x0,z0,sourcePaths:[],buildings:[],terrainAt:()=>height};
  for (const _ of addCampusItems(group,lods,td,geos,mat)) {}
  showCampusItems(lods, new THREE.Vector3(-500,200,400));
  return group;
}
const campus = tile(-1000,-1000,190);
assert(campus.children.length>0);
for (const [x,z] of [[1000,-1000],[-3000,-1000],[-1000,1000],[-1000,-3000]])
  assert.equal(tile(x,z,300).children.length,0,'Neighbor tiles must not duplicate campus props');
const matrix = new THREE.Matrix4();
for (const mesh of campus.children) for(let i=0;i<mesh.count;i++) {
  mesh.getMatrixAt(i,matrix); assert.equal(matrix.elements[13],190,'Props sit on their owning tile');
}
Object.values(geos).forEach(g=>g.dispose());mat.dispose();
console.log('PASS: campus props belong to one tile and use its ground height; no floating duplicates');
