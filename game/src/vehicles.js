// Vehicle garage and switching paths used by the V picker and Garage.
// `player` is a stand-in that always points at the vehicle you're in, so code that was handed "the car" once
// (challenges, pin guide, effects, sound, camera) follows a switch without knowing about it.
import { nearestBank } from './water.js';
import { nearestRoadSpawn } from './roadspawn.js';
import { Car } from './car.js';
import { Bike, BIKE } from './bike.js';
import { Jet, JET } from './jet.js';
import { Heli } from './heli.js';
import { typeInfo } from './vehicletypes.js';
import { activeProxy } from './vehicle.js';
import { createVehicleTypeSelector } from './vehicletypeselector.js';

export const VEHICLES = [
  { kind: 'car', icon: '🏎️', name: 'Car', help: 'W/S drive · A/D steer · Space handbrake · G glider' },
  { kind: 'bike', icon: '🏍️', name: 'Dirt bike', help: 'W/S ride · A/D steer · Shift wheelie · Space rear-brake slide · in the air W/S lean · G glider' },
  { kind: 'jet', icon: '✈️', name: 'Jet', help: 'W/S throttle · ↑/↓ pitch (↓ = nose up) · ←/→ roll · A/D rudder + nose wheel · Space wheel / air brakes' },
];
export const vehicleInfo = kind => VEHICLES.find(v => v.kind === kind) || VEHICLES[0];

export function createVehicles({ scene, world, tuning, bikeTuning = { ...BIKE }, jetTuning = { ...JET }, canSwitch = () => true, roadPlacementAllowed = () => true }) {
  const car = new Car(world, tuning), bike = new Bike(world, bikeTuning), jet = new Jet(world, jetTuning);
  const all = { car, bike, jet };
  // Obsolete saved selections no longer choose a vehicle on startup.
  try { globalThis.localStorage?.removeItem('yr-vehicle-1'); } catch {}
  // a jet type with its own flight model (vehicletypes.js physics.flight) flies its own vehicle in the jet's slot
  const heli = new Heli(world), flights = { heli };
  const jetFor = id => flights[typeInfo('jet', id)?.physics?.flight] || jet;
  const types = createVehicleTypeSelector(all, { canSwitch, vehicleFor: (kind, id) => kind === 'jet' ? jetFor(id) : all[kind], onSelect: kind => switchTo(kind) });
  all.jet = jetFor(types.getType('jet'));
  let cur = car;
  scene.add(car.mesh);
  const player = activeProxy(() => cur);
  const listeners = [];

  // put `next` where the current vehicle is, facing the same way (a jet switched to in the air keeps flying)
  // air: an aircraft type swap in flight keeps flying at exactly this height, however low
  function switchTo(kind, { place = true, air = false } = {}) {
    const next = all[kind]; if (!next) return false;
    if (next === cur) return true;
    const p = cur.pos.clone(), yaw = cur.heading(), sp = cur.vel.length();
    const agl = p.y - world.heightAt(p.x, p.z);
    cur.glide?.cancel?.();
    scene.remove(cur.mesh);
    next.safe = cur.safe.slice();
    next._lastLoaded = cur._lastLoaded;
    if (place) {
      if (kind === 'jet' && air) keepFlying(next, p, cur.vel, yaw);
      else if (kind === 'jet' && agl > 30) next.placeInAir(p.x, p.y, p.z, Math.atan2(cur.vel.x, cur.vel.z) || yaw, Math.max(400, sp * 3.6));
      else if (!placeGround(next, p, yaw)) { next.pos.copy(p); next.vel.set(0, 0, 0); next.reset(p.x, p.z, yaw); }
    }
    scene.add(next.mesh);
    cur = next;
    listeners.forEach(f => f(next));
    return true;
  }

  let roadHold = null;
  function placeGround(v, p, yaw) {
    if (!roadPlacementAllowed() || v.kind === 'jet') return false;
    let spot;
    if (v.kind === 'bike' && v.type !== 'sport') {
      const unsafe = Number.isFinite(cur.world.roofUnder?.(p.x, p.z, p.y)) || world.waterLevelAt(p.x, p.z) > world.heightAt(p.x, p.z);
      if (!unsafe) return false;
      const bank = nearestBank(world, p.x, p.z);
      spot = bank && { x: bank[0], z: bank[1], yaw };
    } else spot = nearestRoadSpawn(world, p.x, p.z, yaw);
    if (!spot) return false;
    // Start below roofs so reset asks for the road, even when the old vehicle was flying.
    v.pos.set(spot.x, world.heightAt(spot.x, spot.z), spot.z);
    v.reset(spot.x, spot.z, spot.yaw);
    v._lastLoaded = null;
    roadHold?.(v);
    return true;
  }

  // an aircraft swapped in flight takes over at exactly this spot and height (placeInAir alone keeps a floor above the
  // ground for other switches)
  function keepFlying(v, p, vel, yaw) {
    const sp = vel.length();
    v.placeInAir(p.x, p.y, p.z, (sp < 5 ? 0 : Math.atan2(vel.x, vel.z)) || yaw, Math.max(400, sp * 3.6));
    v.pos.y = p.y; v.afterReset();
  }

  // Garage type change in flight: flying stays flying. To / from a type with its own flight model, the jet slot's
  // vehicle is swapped in place; between types of the same vehicle (the selector resets it onto the ground) it is put
  // back in the air where it was.
  let flight = null;
  const setType = types.setType;
  types.setType = (kind, id, options) => {
    const v = all.jet;
    flight = kind === 'jet' && cur === v && v.mode === 'air' ? { p: v.pos.clone(), vel: v.vel.clone(), yaw: v.heading() } : null;
    try { return setType(kind, id, options); } finally { flight = null; }
  };
  types.onTypeChange(kind => {
    if (kind !== 'jet') { if (cur === all[kind]) placeGround(cur, cur.pos, cur.heading()); return; }
    const next = jetFor(types.getType('jet')), was = all.jet;
    if (next !== was) {
      all.jet = next; next.respawn = was.respawn; was.respawn = null;
      if (cur === was) switchTo('jet', { air: was.mode === 'air' });
    } else if (flight && cur === next) keepFlying(next, flight.p, flight.vel, flight.yaw);
  });

  // ---- V picker (vehiclepicker.js, attached by main.js once the paint exists). Its keys are read here, in this
  // listener's place among the game's capture listeners, so they stay ahead of the race list's / map's.
  let picker = null;
  if (typeof document !== 'undefined') addEventListener('keydown', e => picker?.keydown(e), true);
  // vehicle + type in one go (picker): the type first (setType keeps an aircraft flying), then the switch
  function choose(kind, id = null) {
    if (!all[kind]) return false;
    if (id && id !== types.getType(kind) && !api.setType(kind, id)) return false;
    if (kind !== cur.kind) { if (!canSwitch(kind)) return false; switchTo(kind); }
    return true;
  }

  const api = {
    setRoadHold(fn) { roadHold = fn; },
    player, all, car, bike, get jet() { return all.jet; }, heli, aircraft: [jet, heli], switchTo, choose, ...types,
    vehicleFor: (kind, id) => kind === 'jet' ? jetFor(id) : all[kind],     // the vehicle that drives a type
    get current() { return cur; },
    onSwitch(f) { listeners.push(f); },
    show(from) { picker?.show(from); }, close() { picker?.close(); }, get open() { return !!picker?.open; },
    setPicker(p) { picker = p; },
  };
  return api;
}
