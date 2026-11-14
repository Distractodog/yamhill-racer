import { createRoadGraph, routeProgress } from './navigation.js';

const fmt = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
export function createDirections({ minimap, car, world }) {
  let graph=null, loading=null, active=null, selecting=false, timer=0, request=0;
  const hud=document.createElement('div'); hud.id='directions-hud'; hud.hidden=true;
  hud.innerHTML='<span role="status"></span><button aria-label="Clear directions">✕</button>';
  const style=document.createElement('style');
  style.textContent='#directions-hud { position:fixed; left:50%; bottom:90px; transform:translateX(-50%); z-index:30; max-width:80vw; padding:12px 18px; border-radius:12px; background:#10251fee; color:white; font:600 16px system-ui; box-shadow:0 3px 15px #0007 } #directions-hud[hidden] { display:none } #directions-hud button { margin-left:16px; color:white; background:transparent; border:0; cursor:pointer; font-size:18px }';
  document.head.append(style); document.body.append(hud);
  const message=text=>{ hud.hidden=false; hud.querySelector('span').textContent=text; };
  function clear() { request++; active=null; selecting=false; minimap.setDirections(null); minimap.setDirectionMode(false); hud.hidden=true; }
  hud.querySelector('button').onclick=clear;
  minimap.onPin(clear);
  async function load() {
    if(graph) return graph;
    if(!loading) loading=fetch('./assets/navigation.json').then(r=>{if(!r.ok) throw Error('Road data unavailable'); return r.json();}).then(data=>graph=createRoadGraph(data)).catch(e=>{loading=null; throw e;});
    return loading;
  }
  function onRoad() {
    return car.grounded && world.loadedAt(car.pos.x,car.pos.z) && [3,4].includes(world.surfaceAt(car.pos.x,car.pos.z));
  }
  async function begin() {
    if(selecting || active) { clear(); return; }
    if(!onRoad()) { message('Drive onto a road before asking for directions.'); return; }
    const token=++request; message('Loading roads…');
    try { await load(); } catch { if(token===request) message('Could not load roads. Try Directions again.'); return; }
    if(token!==request) return;
    if(!onRoad() || !graph.snap(car.pos.x,car.pos.z,0,car.pos.y)) { message('Drive onto a mapped road to get directions.'); return; }
    selecting=true; minimap.setDirectionMode(true); message('Click a road destination · zoom in for smaller roads');
  }
  function choose(x,z,tolerance) {
    if(!selecting) return;
    if(!onRoad()) { message('You must be on a road to get directions.'); return; }
    const start=graph.snap(car.pos.x,car.pos.z,0,car.pos.y), end=graph.snap(x,z,Math.min(15,tolerance));
    if(!start) { message('Drive onto a mapped road to get directions.'); return; }
    if(!end) { message('Choose a spot on a road. Zoom in for a closer view.'); return; }
    const route=graph.route(start,end);
    if(!route) { message('No connected road route to that spot. Choose another road.'); return; }
    minimap.setPin(null); // clear the straight-line pin guide before activating road directions
    active={...route,end}; selecting=false; minimap.setDirectionMode(false); minimap.setDirections(route.points);
    message(`Follow the highlighted road route · ${fmt(route.distance)}`); timer=0;
  }
  minimap.setDirectionHandlers(begin,choose);
  function update(dt) {
    if(!active || (timer-=dt)>0) return;
    timer=0.5;
    const p=routeProgress(active.points,car.pos.x,car.pos.z);
    if(!p) { clear(); message('You have arrived!'); return; }
    const end=active.end.point;
    if(onRoad() && p.remaining<20 && Math.hypot(car.pos.x-end[0],car.pos.z-end[1])<20) { clear(); message('You have arrived!'); return; }
    if(p.distance>25) {
      if(!onRoad()) { message('Return to a road to continue directions.'); return; }
      const start=graph.snap(car.pos.x,car.pos.z,0,car.pos.y), reroute=start && graph.route(start,active.end);
      if(!reroute) { message('No connected route here. Return to the highlighted road.'); return; }
      active={...reroute,end:active.end}; minimap.setDirections(active.points); message(`Route updated · ${fmt(active.distance)}`); return;
    }
    // Use bends at least 15 m apart to avoid noisy instructions on detailed road geometry.
    let distance=Math.hypot(active.points[p.index+1][0]-p.point[0],active.points[p.index+1][1]-p.point[1]);
    let instruction='Continue on the highlighted road';
    for(let i=p.index+1;i<active.points.length-1;i++) {
      const b=active.points[i]; let a=i-1,c=i+1;
      while(a>0 && Math.hypot(b[0]-active.points[a][0],b[1]-active.points[a][1])<15) a--;
      while(c<active.points.length-1 && Math.hypot(b[0]-active.points[c][0],b[1]-active.points[c][1])<15) c++;
      const before=active.points[a],after=active.points[c];
      const ux=b[0]-before[0],uz=b[1]-before[1],vx=after[0]-b[0],vz=after[1]-b[1];
      const angle=Math.atan2(ux*vz-uz*vx,ux*vx+uz*vz);
      if(Math.abs(angle)>0.6 && distance>10) { instruction=`In ${fmt(distance)}, turn ${angle>0?'right':'left'}`; break; }
      distance+=Math.hypot(active.points[i+1][0]-b[0],active.points[i+1][1]-b[1]);
    }
    const next=active.points[p.index+1], here=active.points[p.index];
    const dx=next[0]-here[0], dz=next[1]-here[1];
    if (Math.sin(car.yaw)*dx+Math.cos(car.yaw)*dz < -0.4*Math.hypot(dx,dz)) instruction='Turn around to follow the route';
    message(`${instruction} · ${fmt(p.remaining)} remaining`);
  }
  return { begin, choose, clear, update, get active() { return active; } };
}
