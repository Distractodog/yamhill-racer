// Vehicle garage: the car, the dirt bike and the jet (or another aircraft type), which one you're in, and the V picker.
// `player` is a stand-in that always points at the vehicle you're in, so code that was handed "the car" once
// (challenges, pin guide, effects, sound, camera) follows a switch without knowing about it.
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
  { kind: 'jet', icon: '✈️', name: 'Jet', help: 'W/S throttle · ↑/↓ pitch (↓ = nose up) · ←/→ roll · A/D rudder + nose wheel · Space brakes' },
];
export const vehicleInfo = kind => VEHICLES.find(v => v.kind === kind) || VEHICLES[0];

const CSS = `
#veh-menu { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(480px, 92vw);
  background: #142016ee; color: #fff; border-radius: 16px; box-shadow: 0 10px 40px #0008; padding: 20px 22px; display: none;
  font: 14px system-ui, sans-serif; z-index: 20; }
#veh-menu h2 { margin: 0 0 12px; font-size: 22px; }
#veh-menu .veh-item { display: flex; gap: 12px; align-items: center; width: 100%; text-align: left; border: 2px solid transparent;
  background: #ffffff12; color: #fff; border-radius: 10px; padding: 10px 12px; margin: 6px 0; cursor: pointer; font: inherit; }
#veh-menu .veh-item.sel { border-color: #ffd23f; background: #ffffff22; }
#veh-menu .veh-item.cur .veh-name::after { content: ' · driving now'; font-weight: 400; opacity: .7; font-size: 12px; }
#veh-menu .veh-icon { font-size: 30px; width: 40px; text-align: center; }
#veh-menu .veh-name { font-weight: 800; font-size: 16px; }
#veh-menu .veh-help { opacity: .75; font-size: 12px; margin-top: 2px; }
#veh-menu .veh-key { margin-left: auto; opacity: .6; font-weight: 700; }
#veh-menu .veh-hint { opacity: .65; font-size: 12px; margin-top: 10px; }
#veh-msg { font-size: 14px; font-weight: 700; margin-top: 4px; }
`;

export function createVehicles({ scene, world, tuning, bikeTuning = { ...BIKE }, jetTuning = { ...JET }, canSwitch = () => true }) {
  const car = new Car(world, tuning), bike = new Bike(world, bikeTuning), jet = new Jet(world, jetTuning);
  const all = { car, bike, jet };
  // Obsolete saved selections no longer choose a vehicle on startup.
  try { globalThis.localStorage?.removeItem('yr-vehicle-1'); } catch {}
  // a jet type with its own flight model (vehicletypes.js physics.flight) flies its own vehicle in the jet's slot
  const heli = new Heli(world), flights = { heli };
  const jetFor = id => flights[typeInfo('jet', id)?.physics?.flight] || jet;
  const types = createVehicleTypeSelector(all, { canSwitch, vehicleFor: (kind, id) => kind === 'jet' ? jetFor(id) : all[kind] });
  all.jet = jetFor(types.getType('jet'));
  let cur = car, sel = 0, open = false;
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
      else next.reset(p.x, p.z, yaw);
    }
    scene.add(next.mesh);
    cur = next;
    listeners.forEach(f => f(next));
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
  types.setType = (kind, id) => {
    const v = all.jet;
    flight = kind === 'jet' && cur === v && v.mode === 'air' ? { p: v.pos.clone(), vel: v.vel.clone(), yaw: v.heading() } : null;
    try { return setType(kind, id); } finally { flight = null; }
  };
  types.onTypeChange(kind => {
    if (kind !== 'jet') return;
    const next = jetFor(types.getType('jet')), was = all.jet;
    if (next !== was) {
      all.jet = next; next.respawn = was.respawn; was.respawn = null;
      if (cur === was) switchTo('jet', { air: was.mode === 'air' });
    } else if (flight && cur === next) keepFlying(next, flight.p, flight.vel, flight.yaw);
  });

  // ---- V picker
  if (typeof document !== 'undefined') {
    const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
  }
  const menu = typeof document !== 'undefined' ? Object.assign(document.createElement('div'), { id: 'veh-menu' }) : null;
  menu && document.body.append(menu);
  function render() {
    menu.innerHTML = `<h2>Vehicles</h2>` + VEHICLES.map((v, i) =>
      `<button class="veh-item${i === sel ? ' sel' : ''}${v.kind === cur.kind ? ' cur' : ''}" data-k="${v.kind}">
        <span class="veh-icon">${v.icon}</span><span><div class="veh-name">${all[v.kind]?.name || v.name}</div><div class="veh-help">${all[v.kind]?.help || (all[v.kind]?.typePhysics?.noWheelie ? v.help.replace('Shift wheelie · ', '') : v.help)}</div></span>
        <span class="veh-key">${i + 1}</span></button>`).join('') +
      `<div class="veh-hint">1–${VEHICLES.length}, ↑/↓ + Enter or click · V or Esc to close${canSwitch() ? '' : ' · switching ends the race you\'re in'}</div>`;
    menu.querySelectorAll('.veh-item').forEach(b => b.addEventListener('click', () => pick(b.dataset.k)));
  }
  function pick(kind) { close(); if (kind !== cur.kind) { if (!canSwitch(kind)) return; switchTo(kind); } }
  function show() { open = true; sel = VEHICLES.findIndex(v => v.kind === cur.kind); render(); menu.style.display = 'block'; }
  function close() { open = false; if (menu) menu.style.display = 'none'; }
  if (menu) addEventListener('keydown', e => {
    if (e.gameUI) return;
    if (e.repeat) return;
    if (e.code === 'KeyV') { open ? close() : show(); e.stopImmediatePropagation(); return; }
    if (!open) return;
    e.stopImmediatePropagation();
    if (e.code === 'Escape') close();
    else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') { sel = (sel + (e.code === 'ArrowDown' ? 1 : VEHICLES.length - 1)) % VEHICLES.length; render(); }
    else if (e.code === 'Enter') pick(VEHICLES[sel].kind);
    else if (/^(Digit|Numpad)[1-9]$/.test(e.code) && VEHICLES[+e.code.slice(-1) - 1]) pick(VEHICLES[+e.code.slice(-1) - 1].kind);
  }, true);

  return {
    player, all, car, bike, get jet() { return all.jet; }, heli, aircraft: [jet, heli], switchTo, show, close, ...types,
    get current() { return cur; }, get open() { return open; },
    onSwitch(f) { listeners.push(f); },
  };
}
