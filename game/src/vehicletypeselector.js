import { VEHICLE_TYPE_KEY, VEHICLE_TYPES, loadVehicleTypes, typeInfo, applyVehicleType } from './vehicletypes.js';

function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
// vehicleFor(kind, id): the vehicle a type drives (default all[kind]; a type with its own flight model has its own vehicle)
export function createVehicleTypeSelector(all, { storage = browserStorage(), canSwitch = () => true, vehicleFor = kind => all[kind] } = {}) {
  const selected = loadVehicleTypes(storage), listeners = new Set();
  for (const kind of Object.keys(VEHICLE_TYPES)) {
    const vehicle = vehicleFor(kind, selected[kind]);
    if (!vehicle) continue;                      // (tests build only some vehicles)
    vehicle.type = selected[kind];
    if (selected[kind] !== VEHICLE_TYPES[kind][0].id) applyVehicleType(vehicle, selected[kind]);
  }
  return {
    getType: kind => selected[kind],
    setType(kind, id) {
      if (!VEHICLE_TYPES[kind]?.some(t => t.id === id) || !canSwitch(kind)) return false;
      if (id !== selected[kind]) {
        const vehicle = vehicleFor(kind, id);
        applyVehicleType(vehicle, id);             // the previous type's model is kept for next time (vehicletypes.js typeModel)
        selected[kind] = typeInfo(kind, id).id;
        // Reset suspension and pose at the same spot; type selection is a garage operation.
        vehicle.reset(vehicle.pos.x, vehicle.pos.z, vehicle.heading());
        listeners.forEach(fn => fn(kind));
      }
      try { if (!storage) return false; storage.setItem(VEHICLE_TYPE_KEY, JSON.stringify(selected)); return true; }
      catch { return false; }
    },
    onTypeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
