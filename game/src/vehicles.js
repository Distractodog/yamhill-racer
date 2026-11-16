// Vehicle garage: the car, the dirt bike, the jet, the jet ski and the speedboat, which one you're in, and the V picker.
// `player` is a stand-in that always points at the vehicle you're in, so code that was handed "the car" once
// (challenges, pin guide, effects, sound, camera) follows a switch without knowing about it.
import { Car } from './car.js';
import { Bike, BIKE } from './bike.js';
import { Jet, JET } from './jet.js';
import { Boat, JETSKI, SPEEDBOAT, findBank } from './boat.js';
import { activeProxy } from './vehicle.js';
import { createVehicleTypeSelector } from './vehicletypeselector.js';

export const VEHICLES = [
  { kind: 'car', icon: '🏎️', name: 'Car', help: 'W/S drive · A/D steer · Space handbrake · G glider' },
  { kind: 'bike', icon: '🏍️', name: 'Dirt bike', help: 'W/S ride · A/D steer · Shift wheelie · Space rear-brake slide · in the air W/S lean · G glider' },
  { kind: 'jet', icon: '✈️', name: 'Jet', help: 'W/S throttle · ↑/↓ pitch (↓ = nose up) · ←/→ roll · A/D rudder + nose wheel · Space brakes' },
  { kind: 'jetski', icon: '🌊', name: 'Jet ski', help: 'Starts on the nearest river or pond · W throttle · S brake / reverse · A/D steer · R back to the water' },
  { kind: 'boat', icon: '🚤', name: 'Speedboat', help: 'Starts on the nearest river or pond · W throttle · S brake / reverse · A/D steer · R back to the water' },
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
  const jetski = new Boat(world, JETSKI), boat = new Boat(world, SPEEDBOAT);
  const all = { car, bike, jet, jetski, boat };
  const types = createVehicleTypeSelector(all, { canSwitch });
  let cur = car, sel = 0, open = false;
  scene.add(car.mesh);
  const player = activeProxy(() => cur);
  const listeners = [];

  // put `next` where the current vehicle is, facing the same way (a jet switched to in the air keeps flying)
  function switchTo(kind, { place = true } = {}) {
    const next = all[kind]; if (!next) return false;
    if (next === cur) return true;
    const fromBoat = cur instanceof Boat, toBoat = next instanceof Boat;
    if (fromBoat) cur.launching = null;          // cancels a boat's hold (on its way to a launch spot / back to land)
    const p = cur.pos.clone(), yaw = cur.heading(), sp = cur.vel.length();
    const agl = p.y - world.heightAt(p.x, p.z);
    // leaving a boat for a land vehicle: on the nearest bank, facing away from the water. No dry bank loaded near (the
    // boat is still on its way to a launch spot): back where you were before picking the boat; if that ground has
    // streamed out meanwhile, the boat (hidden) holds there until it's loaded, then this switch runs again.
    let land = null;
    if (place && fromBoat && !toBoat) {
      const back = cur.cameFrom, atBack = back && Math.hypot(p.x - back[0], p.z - back[1]) < 1;   // a hold there just ended
      land = (atBack ? back : findBank(world, p.x, p.z)) || back || null;
      if (land && !world.loadedAt(land[0], land[1])) {
        const boat = cur;
        boat.holdAt({ x: land[0], z: land[1], y: land[3] }, () => { if (cur === boat) switchTo(kind); }, { away: true });
        return true;
      }
    }
    if (toBoat) next.cameFrom = fromBoat ? cur.cameFrom : [p.x, p.z, yaw, p.y];
    cur.glide?.cancel?.();
    scene.remove(cur.mesh);
    next.safe = cur.safe.slice();
    next._lastLoaded = cur._lastLoaded;
    if (land) next.reset(land[0], land[1], land[2]);
    else if (place) {
      if (kind === 'jet' && agl > 30) next.placeInAir(p.x, p.y, p.z, Math.atan2(cur.vel.x, cur.vel.z) || yaw, Math.max(400, sp * 3.6));
      else next.reset(p.x, p.z, yaw);
    }
    scene.add(next.mesh);
    cur = next;
    listeners.forEach(f => f(next));
    return true;
  }

  // ---- V picker
  if (typeof document !== 'undefined') {
    const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
  }
  const menu = typeof document !== 'undefined' ? Object.assign(document.createElement('div'), { id: 'veh-menu' }) : null;
  menu && document.body.append(menu);
  function render() {
    menu.innerHTML = `<h2>Vehicles</h2>` + VEHICLES.map((v, i) =>
      `<button class="veh-item${i === sel ? ' sel' : ''}${v.kind === cur.kind ? ' cur' : ''}" data-k="${v.kind}">
        <span class="veh-icon">${v.icon}</span><span><div class="veh-name">${all[v.kind]?.name || v.name}</div><div class="veh-help">${all[v.kind]?.typePhysics?.noWheelie ? v.help.replace('Shift wheelie · ', '') : v.help}</div></span>
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
    player, all, car, bike, jet, jetski, boat, switchTo, show, close, ...types,
    get current() { return cur; }, get open() { return open; },
    onSwitch(f) { listeners.push(f); },
  };
}
