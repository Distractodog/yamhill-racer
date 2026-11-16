// Picker stat bars (vehiclepicker.js): Top speed · Handling · Off-road as 1–5 for every vehicle type, read off the
// type numbers in vehicletypes.js (at the default Settings sliders). No physics of its own: each stat is a rough
// score from the tuning the vehicle already drives with, shown against the best type of the same vehicle
// (bars = ceil(5 × score / best)), so the bars compare a vehicle's types with each other.
// No DOM; the Node tests import it.
import { TUNING_DEFAULTS } from './car.js';
import { BIKE } from './bike.js';
import { JET } from './jet.js';
import { HELI } from './heli.js';
import { VEHICLE_TYPES, typeInfo } from './vehicletypes.js';

const DEFAULTS = { car: TUNING_DEFAULTS, bike: BIKE, jet: JET };
const OFFROAD = [0, 1, 2, 4];               // grass, forest floor, trail, gravel (surface classes)
const CAR_MASS = 900;                       // car.js DEFAULT_MASS
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// the stat labels per vehicle; aircraft have no off-road, their third bar is how short a field they need
export const STAT_LABELS = {
  car: ['Top speed', 'Handling', 'Off-road'],
  bike: ['Top speed', 'Handling', 'Off-road'],
  jet: ['Top speed', 'Handling', 'Rough field'],
};

// raw scores (bigger = better)
function scores(kind, id) {
  const spec = typeInfo(kind, id), d = DEFAULTS[kind], t = { ...d, ...spec.tuning }, p = spec.physics || {};
  const g = s => (p.grip?.[s] ?? 1) * (p.drive?.[s] ?? 1);
  if (kind === 'jet' && p.flight === 'heli') {
    // level cruise at full tilt: thrust's sideways part g·tan(maxTilt) against the drag (heli.js comment: ~250 km/h)
    const a = HELI.gravity * Math.tan(HELI.maxTilt), v = (-HELI.dragLin + Math.sqrt(HELI.dragLin ** 2 + 4 * HELI.dragQuad * a)) / (2 * HELI.dragQuad);
    // turns on the spot; hovers and lands anywhere flat (take-off "speed" ~ its landing limit)
    return { top: v, handling: 2 * HELI.yawRate * Math.sqrt(JET.maxG), rough: 1 / HELI.landKmh };
  }
  if (kind === 'jet') {
    // flat-out speed where thrust meets the zero-lift drag (jet.js: a = thrust − liftK·v²·(cd0 + 0.012))
    const v = Math.sqrt(t.thrust / (t.liftK * (t.cd0 + 0.012)));
    return { top: v, handling: t.rollRate * Math.sqrt(t.maxG), rough: 1 / t.rotateKmh };
  }
  const handling = t.cornerGrip * (p.grip?.[3] ?? 1) * mean([t.turnResponse / d.turnResponse, t.steerRate / d.steerRate]) *
    (kind === 'car' ? (CAR_MASS / (p.mass ?? CAR_MASS)) ** 0.25 : 1);
  // traction on loose ground, and the suspension travel to soak it up
  const rough = mean(OFFROAD.map(g)) * (kind === 'car' ? Math.sqrt(t.restLength / d.restLength) : Math.sqrt(t.travel / d.travel));
  return { top: t.topSpeed, handling, rough };
}

const bars = (v, best) => Math.max(1, Math.min(5, Math.ceil(5 * v / best - 1e-9)));
// { top, handling, offroad } as 1–5, labels = STAT_LABELS[kind]
export function typeStats(kind, id) {
  const all = VEHICLE_TYPES[kind].map(t => scores(kind, t.id)), s = scores(kind, id);
  const best = k => Math.max(...all.map(x => x[k]));
  return { top: bars(s.top, best('top')), handling: bars(s.handling, best('handling')), offroad: bars(s.rough, best('rough')),
    labels: STAT_LABELS[kind] };
}
