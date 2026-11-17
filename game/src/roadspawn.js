// Placement queries only: vehicle handling continues to use the world physics contract.
export function nearestRoadSpawn(world, x, z, yaw, radius = 1500) {
  let best = null, score = Infinity;
  const loaded = [...(world.tiles?.values() || [])];
  const search = (tiles, verify) => {
    for (const t of tiles) for (const p of t.sourcePaths || []) {
      if (p.kind !== 'asphalt' || p.bridge || p.widen?.length || (p.cls || '').includes('_link') || p.w < 5) continue;
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
        if (distance > radius || !verify && world.loadedAt(px,pz)) continue;
        const minor = /service|driveway|parking/.test(p.cls || '') || p.w < 6;
        const rank = distance + (minor ? 150 : 0);
        if (rank >= score) continue;
        if ((t.sourceJunctions || []).some(j => Math.hypot(px-j.c[0],pz-j.c[1]) < Math.max(12,p.w))) continue;
        if (verify && (!world.loadedAt(px,pz) || world.surfaceAt(px,pz) !== 3 || world.waterLevelAt(px,pz) > world.heightAt(px,pz) || world.rampAt(px,pz))) continue;
        if (verify && world.buildingsNear(px,pz,6).some(b => {
          const xs=b.pts.map(a=>a[0]), zs=b.pts.map(a=>a[1]);
          return px>Math.min(...xs)-3 && px<Math.max(...xs)+3 && pz>Math.min(...zs)-3 && pz<Math.max(...zs)+3;
        })) continue;
        if (rank < score) { score=rank; best={ x:px,z:pz,yaw:Math.atan2(fx,fz),distance,offset }; }
      }
    }
  };
  search(loaded,true);
  if (!best) { radius = Infinity; search(world.knownRoadTiles?.values() || [],false); }
  return best;
}
