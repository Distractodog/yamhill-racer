import { createRoadGraph, routeProgress } from './navigation.js';

const fmt = m => m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
export function createDirections({ minimap, car, world }) {
  let graph=null, loading=null, active=null, selecting=false, timer=0, request=0;
  const message=text=>minimap.setDirectionsStatus(text);
  function clear() { request++; active=null; selecting=false; minimap.setDirections(null); minimap.setDirectionMode(false); message(null); }
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
    if(!onRoad()) { message('Start on a road'); return; }
    const token=++request; message('Loading roads…');
    try { await load(); } catch { if(token===request) message('Roads unavailable · try again'); return; }
    if(token!==request) return;
    if(!onRoad() || !graph.snap(car.pos.x,car.pos.z,0,car.pos.y)) { message('Start on a mapped road'); return; }
    selecting=true; minimap.setDirectionMode(true); message('Click a road destination');
  }
  function choose(x,z,tolerance) {
    if(!selecting) return;
    if(!onRoad()) { message('Start on a road'); return; }
    const start=graph.snap(car.pos.x,car.pos.z,0,car.pos.y), end=graph.snap(x,z,Math.min(15,tolerance));
    if(!start) { message('Start on a mapped road'); return; }
    if(!end) { message('Choose a road · zoom in if needed'); return; }
    const route=graph.route(start,end);
    if(!route) { message('No connected route · choose another road'); return; }
    minimap.setPin(null); // clear the straight-line pin guide before activating road directions
    active={...route,end}; selecting=false; minimap.setDirectionMode(false); minimap.setDirections(route.points);
    message(`${fmt(route.distance)} to destination`); timer=0;
  }
  minimap.setDirectionHandlers(begin,choose,clear);
  function update(dt) {
    if(!active || (timer-=dt)>0) return;
    timer=0.5;
    const p=routeProgress(active.points,car.pos.x,car.pos.z);
    if(!p) { clear(); message('Arrived · 0 m'); return; }
    const end=active.end.point;
    if(onRoad() && p.remaining<20 && Math.hypot(car.pos.x-end[0],car.pos.z-end[1])<20) { clear(); message('Arrived · 0 m'); return; }
    if(p.distance>25) {
      if(!onRoad()) { message(`Off road · ${fmt(p.remaining)} remaining`); return; }
      const start=graph.snap(car.pos.x,car.pos.z,0,car.pos.y), reroute=start && graph.route(start,active.end);
      if(!reroute) { message(`Route unavailable · ${fmt(p.remaining)} remaining`); return; }
      active={...reroute,end:active.end}; minimap.setDirections(active.points); message(`${fmt(active.distance)} to destination`); return;
    }
    message(`${fmt(p.remaining)} to destination`);
  }
  return { begin, choose, clear, update, get active() { return active; } };
}
