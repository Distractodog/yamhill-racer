// Placement queries only: vehicle handling continues to use the world physics contract.
const verifiedRoads = new WeakMap();
export function nearestRoadSpawn(world, x, z, yaw, radius = 1500, { anyRoad = false, preferMajor = true } = {}) {
  let best = null, score = Infinity;
  const loaded = [...(world.tiles?.values() || [])];
  const search = tiles => {
    for (const t of tiles) for (const p of t.sourcePaths || []) {
      if (!(p.kind === 'asphalt' || anyRoad && ['gravel', 'trail', 'dirt'].includes(p.kind)) || p.bridge || p.widen?.length || (p.cls || '').includes('_link') || p.w < (anyRoad ? 1 : 5)) continue;
      const pts = p.pts, lengths = [0];
      for (let i = 1; i < pts.length; i++) lengths[i] = lengths[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]);
      for (let i = 1; i < pts.length; i++) {
        const [ax, az] = pts[i-1], dx = pts[i][0]-ax, dz = pts[i][1]-az, len = lengths[i]-lengths[i-1];
        if (!len) continue;
        const lo = Math.max(0, (10-lengths[i-1])/len), hi = Math.min(1, (lengths.at(-1)-10-lengths[i-1])/len);
        if (hi < lo) continue;
        const u = Math.max(lo, Math.min(hi, ((x-ax)*dx+(z-az)*dz)/(len*len)));
        let fx = dx/len, fz = dz/len;
        if (!p.oneway && fx*Math.sin(yaw)+fz*Math.cos(yaw) < 0) { fx = -fx; fz = -fz; }
        // In x east / z south, the driver's right is (-forward.z, forward.x).
        const offset = Math.min(3, p.w/4), px = ax+dx*u-fz*offset, pz = az+dz*u+fx*offset;
        const distance = Math.hypot(px-x,pz-z);
        if (distance > radius) continue;
        const minor = /service|driveway|parking/.test(p.cls || '') || p.w < 6;
        const rank = distance + (minor && preferMajor ? 150 : 0);
        if (rank >= score) continue;
        if ((t.sourceJunctions || []).some(j => Math.hypot(px-j.c[0],pz-j.c[1]) < Math.max(12,p.w))) continue;
        if (!([3, ...(anyRoad ? [2,4] : [])].includes(world.surfaceAt(px,pz))) || !openGroundAt(world,px,pz)) continue;
        if (rank < score) { score=rank; best={ x:px,z:pz,yaw:Math.atan2(fx,fz),distance,offset,kind:p.kind,minor }; }
      }
    }
  };
  search(loaded);
  if (!best) { radius = Infinity; search(loaded); }
  const saved = verifiedRoads.get(world) || new Map();
  if (best) {
    saved.set(`${best.x},${best.z},${best.yaw}`,best);
    if (saved.size > 256) saved.delete(saved.keys().next().value);
    verifiedRoads.set(world,saved);
  } else {
    // An unloaded road's geometry alone cannot prove it is dry and clear. Only
    // revisit a previously checked position, with the normal streaming hold.
    for (const candidate of saved.values()) {
      if (world.loadedAt(candidate.x,candidate.z) || !anyRoad && candidate.kind !== 'asphalt') continue;
      const distance=Math.hypot(candidate.x-x,candidate.z-z);
      const rank=distance+(candidate.minor && preferMajor ? 150 : 0);
      if (rank < score) { score=rank; best={...candidate,distance}; }
    }
  }
  return best;
}

// A car-sized footprint plus four metres of clearance from trunks and buildings.
// Test the whole footprint for water, missing ground and steep/uneven surfaces.
export function openGroundAt(world, x, z) {
  const clearance = 6.5;
  for (const b of world.buildingsNear(x,z,clearance)) {
    const xs=b.pts.map(p=>p[0]), zs=b.pts.map(p=>p[1]);
    if (x > Math.min(...xs)-clearance && x < Math.max(...xs)+clearance &&
        z > Math.min(...zs)-clearance && z < Math.max(...zs)+clearance) return false;
  }
  let blocked = false;
  world.treesNear?.(x,z,clearance+2,(tx,tz,r=0) => { if (Math.hypot(tx-x,tz-z) < clearance+r) blocked=true; });
  if (blocked) return false;
  for (const dx of [-2.5,0,2.5]) for (const dz of [-2.5,0,2.5]) {
    const px=x+dx, pz=z+dz;
    if (!world.loadedAt(px,pz) || world.rampAt?.(px,pz)) return false;
    const h=world.heightAt(px,pz);
    if (!Number.isFinite(h) || world.waterLevelAt(px,pz) >= h || world.surfaceAt(px,pz) === 5) return false;
    const gx=(world.heightAt(px+1,pz)-world.heightAt(px-1,pz))/2;
    const gz=(world.heightAt(px,pz+1)-world.heightAt(px,pz-1))/2;
    if (!Number.isFinite(gx+gz) || Math.hypot(gx,gz) >= Math.tan(Math.PI/12)) return false;
  }
  return true;
}

export function groundSwitchSpawn(world, x, z, yaw, mode = 'open') {
  if (mode === 'open' && openGroundAt(world,x,z)) return {x,z,yaw,distance:0};
  const road = nearestRoadSpawn(world,x,z,yaw,1500,{anyRoad:mode !== 'paved',preferMajor:mode === 'paved'});
  if (mode !== 'open') return road;
  // Sample concentric rings eight metres apart, bounded by the nearest road.
  const limit = Math.min(1500,road?.distance ?? 1500);
  for (let r=8;r<=limit;r+=8) {
    const count=Math.ceil(2*Math.PI*r/8);
    for (let i=0;i<count;i++) {
      const a=i/count*2*Math.PI, px=x+Math.cos(a)*r, pz=z+Math.sin(a)*r;
      if (openGroundAt(world,px,pz)) return {x:px,z:pz,yaw,distance:r};
    }
  }
  return road;
}
