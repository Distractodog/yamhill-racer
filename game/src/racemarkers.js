// Race start markers in free roam: a glowing ring on the ground at every race's start (races starting within 30 m of
// each other share one). Drive into one and be under 30 km/h inside it, and onEnter(i) opens that race's card (the
// first race starting there). A marker only fires again after you have left it, so spawning, finishing or quitting
// a race inside one doesn't pop the menu. Hidden while a race is on (update's `active` false).
// Cost: two small meshes per marker (no textures, no lights), drawn only within SHOW_DIST.
import * as THREE from 'three';

const R = 7, WALL_H = 2.6, SHOW_DIST = 1200, SLOW = 30 / 3.6, GROUP_DIST = 30;
const RING = new THREE.RingGeometry(R - 0.9, R, 48).rotateX(-Math.PI / 2);
// an open cylinder whose colour fades to black at the top: with additive blending that reads as a glow fading upward
const WALL = (() => {
  const g = new THREE.CylinderGeometry(R, R, WALL_H, 48, 1, true).translate(0, WALL_H / 2, 0);
  const p = g.attributes.position, col = [];
  for (let i = 0; i < p.count; i++) { const k = 1 - p.getY(i) / WALL_H; col.push(k, k, k); }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
})();

// list: challenges.json; onEnter(i): open race i's card; isOpen(): another panel or the map is up (no trigger)
export function createRaceMarkers({ scene, world, list, car, onEnter = () => {}, isOpen = () => false }) {
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide });
  const wallMat = new THREE.MeshBasicMaterial({ color: 0xffd23f, vertexColors: true, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  const group = new THREE.Group(); group.name = 'race-markers'; scene.add(group);
  const markers = [];
  list.forEach((c, i) => {
    const near = markers.find(m => Math.hypot(m.x - c.start.x, m.z - c.start.z) < GROUP_DIST);
    if (near) { near.races.push(i); return; }
    const grp = new THREE.Group();
    const ring = new THREE.Mesh(RING, ringMat), wall = new THREE.Mesh(WALL, wallMat);
    ring.position.y = 0.12; ring.renderOrder = wall.renderOrder = 4;
    grp.add(ring, wall); grp.position.set(c.start.x, 0, c.start.z); grp.visible = false;
    group.add(grp);
    markers.push({ x: c.start.x, z: c.start.z, races: [i], grp, placed: false, armed: false, seen: false });
  });

  return {
    markers,
    // active: free roam (no race on, no race menu); call every frame
    update(dt, active = true) {
      const px = car.pos.x, pz = car.pos.z, speed = car.vel.length(), blocked = !active || isOpen();
      const pulse = 0.4 + 0.15 * Math.sin(performance.now() / 300);
      wallMat.opacity = pulse;
      for (const m of markers) {
        if (!m.placed && world.loadedAt(m.x, m.z)) { m.grp.position.y = world.heightAt(m.x, m.z); m.placed = true; }
        // (on the ground: an aircraft or helicopter passing over doesn't count)
        const d = Math.hypot(px - m.x, pz - m.z), inside = d < R && m.placed && car.pos.y - m.grp.position.y < 6;
        m.grp.visible = active && m.placed && d < SHOW_DIST;
        // armed once seen outside (beyond the ring + a margin); fires once, inside and slow. While blocked (or on the
        // first look) it only tracks: inside then means it stays unarmed until you have left it.
        if (inside && (blocked || !m.seen)) m.armed = false;
        else if (d > R + 4) m.armed = true;
        m.seen = true;
        if (blocked) continue;
        if (inside && m.armed && speed < SLOW) { m.armed = false; onEnter(m.races[0], m.races); }
      }
    },
  };
}
