// Meshes for landmarks.js. Reuses the campus builder; campus files stay unchanged.
import { buildCampusGeometry } from './campusmodel.js';

export function placeLandmarks(geos, building, ground) {
  geos.push(buildCampusGeometry(building, ground));
}
