// Swap materials only at wreck transitions. Originals (including Garage paint) remain intact.
const looks = new WeakMap();
export function groundWreckLook(mesh, on) {
  let look = looks.get(mesh);
  if ((!on && !look) || look?.on === on) return;
  if (!look) {
    look = { on: false, parts: [], materials: new Map() };
    const black = material => {
      if (!look.materials.has(material)) {
        const copy = material.clone(); copy.color?.setHex(0x24211f); copy.emissive?.setHex(0);
        look.materials.set(material, copy);
      }
      return look.materials.get(material);
    };
    mesh.traverse(o => { if (o.isMesh && o.material) look.parts.push({ o, original: o.material,
      black: Array.isArray(o.material) ? o.material.map(black) : black(o.material) }); });
    looks.set(mesh, look);
  }
  look.on = on;
  for (const p of look.parts) p.o.material = on ? p.black : p.original;
}
export function disposeCombatLook(mesh) {
  const look = looks.get(mesh); if (!look) return;
  groundWreckLook(mesh, false);
  for (const m of look.materials.values()) m.dispose();
  looks.delete(mesh);
}
