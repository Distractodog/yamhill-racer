// Detailed map imagery is independent of world streaming: only visible map tiles load.
// Keep decoded images bounded (at most twelve 2000px tiles) and two requests in flight.
export function createMapDetail(meta, base, loadImage = async url => {
  const image = new Image(); image.src = url; await image.decode(); return image;
}) {
  const spec = meta.detail;
  if (!spec) return { draw() {} };
  const available = new Set(spec.tiles.map(([x,z])=>`${x}_${z}`));
  const cache = new Map(), retry = new Map();
  let visible = new Set(), pending = 0, queue = [], stamp = 0, revision = 0;
  const LIMIT = 12, T = spec.tile;
  function prune() {
    const unused = [...cache].filter(([key,entry])=>!visible.has(key) && entry.image).sort((a,b)=>a[1].used-b[1].used);
    while(cache.size>LIMIT && unused.length) {
      const [key,entry]=unused.shift(); entry.image?.close?.(); cache.delete(key);
    }
  }
  function pump() {
    while(pending<2 && queue.length) {
      const key=queue.shift();
      if(!visible.has(key) || cache.has(key) || (retry.get(key)||0)>Date.now()) continue;
      const entry={image:null,used:++stamp}; cache.set(key,entry); pending++;
      loadImage(base+spec.path+key+'.webp').then(image=>{ entry.image=image; revision++; retry.delete(key); })
        .catch(()=>{ if(cache.get(key)===entry) cache.delete(key); retry.set(key,Date.now()+30000); })
        .finally(()=>{ pending--; prune(); pump(); });
    }
    prune();
  }
  // ox/oy are the overview image origin, s is canvas pixels per overview pixel.
  // load = false (the full map while it moves): draw only images already shown, request nothing, keep the wanted set.
  function draw(ctx, ox, oy, s, { load = true } = {}) {
    const scale=s/meta.mpp, w=ctx.canvas.width, h=ctx.canvas.height;
    const x0=meta.extent[0]-ox/scale, z0=meta.extent[1]-oy/scale;
    const x1=x0+w/scale, z1=z0+h/scale;
    const coords=[];
    // At wide zoom use the overview; never download the entire map while fitting it.
    if(scale>=0.25) {
      const minX=Math.floor((x0+T/2)/T),maxX=Math.floor((x1+T/2-1e-6)/T);
      const minZ=Math.floor((z0+T/2)/T),maxZ=Math.floor((z1+T/2-1e-6)/T);
      if((maxX-minX+1)*(maxZ-minZ+1)<=LIMIT)
        for(let z=minZ;z<=maxZ;z++) for(let x=minX;x<=maxX;x++) if(available.has(`${x}_${z}`)) coords.push([x,z]);
    }
    if(load) { visible = new Set(coords.map(([x,z])=>`${x}_${z}`)); queue=[]; }
    // The first draw of a newly loaded 2000px image is the costly one (scaled-down copies get built): at most one new
    // image per frame, so after a reset / respawn / H several don't land in the same frame. A skipped one shows on the
    // next frame (revision changes so a cached full map is redrawn too).
    let fresh=load?0:1;
    for(const [x,z] of coords) {
      const key=`${x}_${z}`,entry=cache.get(key);
      if(!entry) {if(load)queue.push(key);continue;}
      if(load) entry.used=++stamp;
      if(entry.image) {
        if(!entry.shown && fresh++) {if(load)revision++;continue;}
        entry.shown=true;
        const dx=ox+(x*T-T/2-meta.extent[0])*scale,dy=oy+(z*T-T/2-meta.extent[1])*scale;
        // Rounded adjoining boundaries prevent hairline seams between tile images.
        const left=Math.round(dx),top=Math.round(dy);
        ctx.drawImage(entry.image,left,top,Math.round(dx+T*scale)-left,Math.round(dy+T*scale)-top);
      }
    }
    if(load) pump();
  }
  return { draw, get revision() { return revision; } };
}
