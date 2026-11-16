// Start-up warm-up, so the first V switch or Garage type change doesn't stutter: three.js compiles a material's shader
// the first time it is drawn, which stalls that frame. Here every vehicle type's model is built (once; vehicletypes.js
// typeModel keeps it), painted, given its light lenses and compiled against the game scene (its lights and fog), one
// model per frame while the player is still on the spawn map; then everything else in the scene, hidden pieces too
// (glider wings, wreck smoke). After that a switch or type change only swaps meshes that are ready to draw.
// step() once a frame from main.js; done = finished.
import { VEHICLE_TYPES, typeModel } from './vehicletypes.js';

export function createWarmup({ renderer, scene, camera, vehicles, cosmetics, lights }) {
  const tasks = [];
  for (const [kind, types] of Object.entries(VEHICLE_TYPES)) for (const { id } of types) tasks.push(() => {
    const vehicle = vehicles.vehicleFor(kind, id);
    if (!vehicle) return null;
    const model = typeModel(vehicle, id);
    cosmetics?.prepare(kind, model);
    lights?.prepare(model, vehicle.kind);
    model.updateMatrixWorld(true);
    return compile(model, scene);
  });
  tasks.push(() => compile(scene));
  let busy = false;
  function compile(object, target = null) {
    // compileAsync lets the driver compile in the background (KHR_parallel_shader_compile) where it can
    if (renderer.compileAsync) return renderer.compileAsync(object, camera, target);
    renderer.compile(object, camera, target); return null;
  }
  return {
    get done() { return !tasks.length && !busy; },
    step() {
      if (busy || !tasks.length) return;
      let pending = null;
      try { pending = tasks.shift()(); } catch (e) { console.warn('warm-up:', e); }
      if (!pending?.then) return;
      busy = true;            // (never wait on one model more than 3 s)
      Promise.race([pending, new Promise(r => setTimeout(r, 3000))]).catch(e => console.warn('warm-up:', e)).finally(() => { busy = false; });
    },
  };
}
