import { VEHICLE_TYPE_KEY, VEHICLE_TYPES, loadVehicleTypes, typeInfo, applyVehicleType } from './vehicletypes.js';
import { disposeCosmeticPreview } from './cosmetics.js';

function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
export function createVehicleTypeSelector(all, { storage = browserStorage(), canSwitch = () => true } = {}) {
  const selected = loadVehicleTypes(storage), listeners = new Set();
  for (const kind of Object.keys(VEHICLE_TYPES)) {
    all[kind].type = selected[kind];
    if (selected[kind] !== VEHICLE_TYPES[kind][0].id) disposeCosmeticPreview(applyVehicleType(all[kind], selected[kind]));
  }
  return {
    getType: kind => selected[kind],
    setType(kind, id) {
      if (!VEHICLE_TYPES[kind]?.some(t => t.id === id) || !canSwitch(kind)) return false;
      if (id !== selected[kind]) {
        const vehicle = all[kind], old = applyVehicleType(vehicle, id);
        selected[kind] = typeInfo(kind, id).id;
        // Reset suspension and pose at the same spot; type selection is a garage operation.
        vehicle.reset(vehicle.pos.x, vehicle.pos.z, vehicle.heading());
        listeners.forEach(fn => fn(kind));
        disposeCosmeticPreview(old);
      }
      try { if (!storage) return false; storage.setItem(VEHICLE_TYPE_KEY, JSON.stringify(selected)); return true; }
      catch { return false; }
    },
    onTypeChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
