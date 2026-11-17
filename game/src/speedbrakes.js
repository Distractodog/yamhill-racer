// Hinged panels shared by the fixed-wing models. Each hinge stays separate when paint is batched.
import * as THREE from 'three';

export function speedBrakePanels(root, material, specs) {
  const panels = specs.map(({ x, y, z, w, d, axis = 'x', angle = 1.05, side = 0 }) => {
    const hinge = new THREE.Group(); hinge.name = 'speed-brake'; hinge.position.set(x, y, z);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), material);
    panel.position.set(side * w / 2, 0, axis === 'x' ? -d / 2 : 0); panel.castShadow = true;
    hinge.add(panel); root.add(hinge);
    return { hinge, axis, angle };
  });
  return amount => { for (const { hinge, axis, angle } of panels) hinge.rotation[axis] = amount * angle; };
}

// Jets lose 1700 → 600 km/h in about seven seconds; scale the drag for slower prop airframes.
// Fade out before the clean, level-flight stall speed;
// holding Space may still stall an idle plane eventually, just as coasting without Space does.
export function speedBrakeDrag(t, speed, protectStall = true) {
  const stall = Math.sqrt(t.gravity / (t.liftK * (t.cl0 + t.clA * t.stallA)));
  const fade = protectStall ? Math.max(0, Math.min(1, (speed / stall - 1.35) / 0.65)) : 1;
  const top = Math.sqrt(t.thrust / (t.liftK * t.cd0));
  return 0.00049 * (480 / Math.min(500, top)) * speed * speed * fade;
}
