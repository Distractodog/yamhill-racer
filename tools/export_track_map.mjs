// Export the current runtime model, not a second copy of its track constants.
import * as THREE from 'three';
import { buildTrackMeshes } from '../game/src/campustrackmodel.js';
const meshes = buildTrackMeshes(() => 0), triangles = [];
for (const mesh of meshes) {
  const p = mesh.geometry.attributes.position, c = mesh.geometry.attributes.color;
  for (let i = 0; i < p.count; i += 3) {
    const pts = [0,1,2].map(j => [p.getX(i+j),p.getZ(i+j)]);
    const area = (pts[1][0]-pts[0][0])*(pts[2][1]-pts[0][1])-(pts[2][0]-pts[0][0])*(pts[1][1]-pts[0][1]);
    if (Math.abs(area) < 1e-8) continue; // vertical faces have no overhead area
    const color = new THREE.Color(c.getX(i),c.getY(i),c.getZ(i)).convertLinearToSRGB();
    triangles.push({pts, rgb:[color.r,color.g,color.b].map(x=>Math.round(x*255)), y:Math.max(p.getY(i),p.getY(i+1),p.getY(i+2))});
  }
  mesh.geometry.dispose();
}
// Higher geometry wins where overhead projections overlap.
triangles.sort((a,b)=>a.y-b.y);
process.stdout.write(JSON.stringify({source:'game/src/campustrackmodel.js',triangles}));
