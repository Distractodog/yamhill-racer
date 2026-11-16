// The race car (default car type) mesh: a modern open-wheel single-seater, built in models/racecar.js. Local axes: +z
// forward, +y up, +x = car's left. Origin = centre of mass. WHEEL_POS is also the physics' wheel layout (car.js) and the
// base the other car types scale (vehicletypes.js): don't move it for looks.
import { buildRaceCarModel } from './models/racecar.js';

export const WHEEL_POS = [   // x, y (hub, at rest), z, front?, radius, width
  [0.98, -0.1, 1.42, true, 0.36, 0.32], [-0.98, -0.1, 1.42, true, 0.36, 0.32],
  [0.98, -0.06, -1.36, false, 0.41, 0.44], [-0.98, -0.06, -1.36, false, 0.41, 0.44],
];

// colors (optional): { paint, accent, helmet } in place of the factory body / trim / helmet colours
export function buildCarModel(colors = {}) {
  return buildRaceCarModel(WHEEL_POS, colors);
}
