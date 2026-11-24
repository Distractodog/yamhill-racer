// Type defaults layer over the existing Settings sliders as ratios. Factory types use the original
// tuning object directly; changing a slider remains live and never writes type defaults into storage.
import * as THREE from 'three';
import { TUNING_DEFAULTS } from './car.js';
import { BIKE, buildBikeModel } from './bike.js';
import { buildCarModel } from './carmodel.js';
import { buildTypeCarModel, buildSportBikeModel } from './vehicletypemodels.js';
import { JET, buildJetModel } from './jet.js';
import { AIRLINER_AIRFRAME, buildAirlinerModel } from './models/airliner.js';
import { BLACKBIRD_AIRFRAME, buildBlackbirdModel } from './models/blackbird.js';
import { buildStealthModel } from './models/stealth.js';
import { PROP_AIRFRAME, buildPropPlaneModel } from './models/propplane.js';
import { STUNT_AIRFRAME, buildStuntPlaneModel } from './models/stuntplane.js';
import { buildHeliModel } from './models/heli.js';
import { primeWheelArch } from './wheeltravel.js';
import { buildHatchModel } from './models/hatch.js';
import { buildSuvModel } from './models/suv.js';

export const VEHICLE_TYPE_KEY = 'yr-vtype-1';
export const VEHICLE_TYPES = {
  car: [
    { id: 'race', name: 'Race car', description: 'Original open-wheel racer.', tuning: {} },
    { id: 'sports', name: 'Sports car', description: 'Low, wide and fast. Asphalt grip; limited off-road traction.',
      tuning: { accel: 40, topSpeed: 1100, cornerGrip: 36, gripAlign: 19, restLength: .30, springK: 68000, damping: 5900 },
      physics: { mass: 1000, width: 1.1, length: 1, radius: .38, lean: .65, grip: [.52,.45,.60,1.12,.58,.9,1.1,1], drive: [.65,.55,.70,1,.68,1,1,1] },
      colors: { trim: '#17181b' } },   // factory paint for this type (cosmetics.js); colours the player picked still win
    { id: 'hatch', name: 'Hatchback', description: 'Light and nimble, with a modest top speed.',
      tuning: { accel: 25, topSpeed: 480, steerRate: 9, turnResponse: 22, restLength: .40, springK: 50000, damping: 4900 },
      physics: { mass: 720, width: .88, length: .84, radius: .34, lean: 1.15 } },
    { id: 'suv', name: 'SUV', description: 'Tall, soft suspension and sure footing on dirt and gravel.',
      tuning: { accel: 22, topSpeed: 650, cornerGrip: 27, turnResponse: 13, restLength: .62, springK: 70000, damping: 7500, downforce: .0015 },
      physics: { mass: 1500, width: 1.12, length: 1.05, radius: .46, lean: 2, grip: [1.22,1.2,1.22,.96,1.25,1,1,1] } },
    { id: 'truck', name: 'Big truck', description: 'Lifted, heavy and wide. Long suspension travel and the best off-road grip.',
      tuning: { accel: 16, topSpeed: 420, cornerGrip: 25, steerRate: 5, turnResponse: 10, restLength: .85, springK: 85000, damping: 10500, downforce: .0008 },
      physics: { mass: 2300, width: 1.34, length: 1.25, radius: .60, lean: 1.7, grip: [1.45,1.4,1.45,.92,1.45,1,1,1] } },
  ],
  bike: [
    { id: 'dirt', name: 'Dirt bike', description: 'Original dirt bike. Shift for wheelies.', tuning: {} },
    { id: 'sport', name: 'Sport bike', description: 'Fast on asphalt; fairings, tucked rider and poor off-road grip. No Shift wheelies.',
      tuning: { accel: 36, topSpeed: 520, cornerGrip: 31, gripAlign: 16, powerSlide: .6, travel: .24, springK: 18500, damping: 1550 },
      physics: { noWheelie: true, grip: [.38,.30,.45,1.16,.42,1,1.1,1], drive: [.45,.35,.55,1,.5,1,1,1] } },
  ],
  // aircraft: the jet's flight model (jet.js) with each type's numbers; physics = its airframe (jet.js FIGHTER_AIRFRAME keys).
  // physics.flight names a flight model other than the jet's (vehicles.js swaps the jet slot to it).
  jet: [
    { id: 'fighter', name: 'Fighter jet', description: 'Original swept-wing jet. Fast, retracting gear, needs a long run.', tuning: {} },
    { id: 'stealth', name: 'Stealth fighter', description: 'Faceted twin-engine fighter. Faster, sharper turns and a slightly higher stall speed.',
      // Terminal speed scales with sqrt(thrust / (liftK * cd0)); ~25% above the fighter.
      tuning: { thrust: 22.5, liftK: .00205, maxG: 10, minG: -3, rollRate: 3.4, yawRate: .65, rotateKmh: 250 },
      colors: { body: '#424a53', trim: '#727b83' } },
    { id: 'blackbird', name: 'SR-71 Blackbird', description: 'Mach 3 spy plane. Fastest aircraft: long take-off, wide turns, lands fast.',
      // Gear-up level terminal speed sqrt(thrust / (liftK * cd0)) ≈ 3,500 km/h.
      tuning: { thrust: 10, liftK: .0013, cd0: .008135, maxG: 3.5, minG: -1,
        rollRate: .85, yawRate: .18, rotateKmh: 360, landKmh: 580, landSink: 6 },
      physics: BLACKBIRD_AIRFRAME, colors: { body: '#16181c', trim: '#2c3036' } },
    { id: 'airliner', name: 'Jumbo jet', description: 'Four-engine jumbo jet. Needs a long straight road to take off; slow, heavy and steady.',
      tuning: { thrust: 4.2, throttleRate: .25, liftK: .003, cd0: .0198, maxG: 2.5, minG: -.5,
        rollRate: .45, yawRate: .12, rotateKmh: 280, landKmh: 330, landSink: 6, brakes: 10 },
      physics: AIRLINER_AIRFRAME, colors: { body: '#f2f2ee', trim: '#1f5fae' } },
    { id: 'prop', name: 'Prop plane', description: 'High-wing trainer, about 250 km/h. Slow stall, short take-off and landing: easy on roads and fields.',
      tuning: { gravity: 11, thrust: 4.6, throttleRate: .8, liftK: .01763, cl0: .3, clA: 4.5, stallA: .28, cd0: .04, cdK: .08,
        maxG: 4.5, minG: -2, rollRate: 1.4, yawRate: .5, rotateKmh: 60, brakes: 6, landSink: 9, landKmh: 230, landUp: .85 },
      physics: PROP_AIRFRAME },
    { id: 'stunt', name: 'Stunt plane', description: 'Light aerobatic plane, about 400 km/h. Very fast roll, tight loops, tail wheel.',
      tuning: { gravity: 12, thrust: 8, throttleRate: 1.2, liftK: .01027, cl0: .05, clA: 4.8, stallA: .3, cd0: .05, cdK: .06,
        maxG: 9, minG: -6, rollRate: 4.5, yawRate: 1.2, rotateKmh: 90, brakes: 7, landSink: 7, landKmh: 260, landUp: .88 },
      physics: STUNT_AIRFRAME },
    { id: 'heli', name: 'Helicopter', description: 'Hovers, lands on any flat spot. W/S up and down, A/D turn, arrows tilt to fly that way; let go to hover.',
      tuning: {}, physics: { flight: 'heli' } },
  ],
};
const AIRCRAFT_MODELS = {
  airliner: buildAirlinerModel,
  stealth: buildStealthModel, blackbird: buildBlackbirdModel, prop: buildPropPlaneModel, stunt: buildStuntPlaneModel, heli: buildHeliModel };
export const typeInfo = (kind, id) => VEHICLE_TYPES[kind]?.find(t => t.id === id) || VEHICLE_TYPES[kind]?.[0];
export function sanitizeVehicleTypes(value) {
  return Object.fromEntries(Object.keys(VEHICLE_TYPES).map(kind => [kind, typeInfo(kind, value?.[kind]).id]));
}
export function loadVehicleTypes(storage) {
  try { return sanitizeVehicleTypes(JSON.parse(storage?.getItem(VEHICLE_TYPE_KEY) || '{}')); }
  catch { return sanitizeVehicleTypes(null); }
}
export function buildVehicleTypeModel(kind, id) {
  const type = typeInfo(kind, id)?.id;
  if (kind === 'car' && type === 'hatch') return buildHatchModel(type, typeInfo(kind, type).physics, typeInfo(kind, type).tuning);
  if (kind === 'car' && type === 'suv') return buildSuvModel(type, typeInfo(kind, type).physics, typeInfo(kind, type).tuning);
  if (kind === 'car') return type === 'race' ? buildCarModel() : buildTypeCarModel(type, typeInfo(kind, type).physics, typeInfo(kind, type).tuning);
  if (kind === 'bike') return type === 'dirt' ? buildBikeModel() : buildSportBikeModel();
  if (kind === 'jet') return AIRCRAFT_MODELS[type]?.() || buildJetModel();
  throw new Error(`No vehicle types for ${kind}`);
}
export function applyVehicleType(vehicle, id) {
  const spec = typeInfo(vehicle.kind, id);
  if (!spec) return null;
  if (!vehicle._typeBaseTuning) {
    vehicle._typeBaseTuning = vehicle.t;
    vehicle._typeMounts = vehicle.wheels.map(w => w.mount?.clone());
  }
  const defaults = vehicle.kind === 'car' ? TUNING_DEFAULTS : vehicle.kind === 'jet' ? JET : BIKE;
  const base = vehicle._typeBaseTuning;
  if (vehicle.type !== spec.id) vehicle.damage?.repair();
  vehicle.type = spec.id;
  vehicle.name = spec.name;
  vehicle.typePhysics = spec.physics || null;
  vehicle.t = Object.keys(spec.tuning).length ? Object.create(base) : base;
  for (const [key, value] of Object.entries(spec.tuning)) Object.defineProperty(vehicle.t, key, {
    enumerable: true, get: () => base[key] * value / defaults[key],
  });
  if (vehicle.kind === 'car') {
    const p = spec.physics;
    vehicle.typeHalf = p ? new THREE.Vector3(.9 * p.width, .38, 2.15 * p.length) : null;
    vehicle.half = p ? { x: 1.15 * p.width, front: 2.4 * p.length, back: -2.4 * p.length } : undefined;
    vehicle.wheels.forEach((w, i) => {
      w.mount.copy(vehicle._typeMounts[i]);
      if (p) { w.mount.x *= p.width; w.mount.z *= p.length; }
    });
  }
  if (vehicle.kind === 'jet') vehicle.setAirframe?.(spec.physics);
  // Keep the vehicle instance (challenges/camera/glider refer to it), replacing only its owned model.
  const old = vehicle.mesh, model = typeModel(vehicle, spec.id);
  vehicle.glide?.cancel();
  if (model === old) return null;
  if (vehicle.glide?.mesh) model.add(vehicle.glide.mesh);
  model.position.copy(old.position); model.quaternion.copy(old.quaternion);
  old.parent?.add(model); old.removeFromParent(); vehicle.mesh = model;
  return old;          // still this vehicle's model for that type: don't dispose it (changing back reuses it)
}
// A vehicle's model for a type, built on first use and then kept, so a type change only swaps meshes: no rebuild,
// no disposed materials (three.js would compile their shaders again on the next use). warmup.js builds them early.
export function typeModel(vehicle, id) {
  const first = vehicle.kind === 'jet' && vehicle.mesh.userData.mainRotor ? 'heli' : VEHICLE_TYPES[vehicle.kind][0].id;
  const models = vehicle._typeModels ||= new Map([[first, vehicle.mesh]]);     // the model it was built with
  id = typeInfo(vehicle.kind, id).id;
  let model = models.get(id);
  if (!model) {
    model = buildVehicleTypeModel(vehicle.kind, id);
    if (vehicle.kind !== 'jet') primeWheelArch(model);
    models.set(id, model);
  }
  return model;
}
