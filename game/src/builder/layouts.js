import { BY_ID } from './pieces.js';
export const STORAGE_KEY = 'yr-builder-1', MAX_PIECES = 1000, MAX_CODE = 512000;
const clone = value => JSON.parse(JSON.stringify(value));
export function validateLayout(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.pieces) || value.pieces.length > MAX_PIECES) throw new Error('Expected a version 1 builder layout (up to 1000 pieces).');
  const ids = new Set();
  const pieces = value.pieces.map(p => {
    if (!p || !BY_ID.has(p.type) || typeof p.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(p.id) || ids.has(p.id)) throw new Error('Unknown piece or duplicate piece ID.');
    ids.add(p.id);
    for (const k of ['x','y','z','yaw','scale']) if (!Number.isFinite(p[k])) throw new Error('Piece coordinates must be finite numbers.');
    if (Math.abs(p.x)>100000 || Math.abs(p.z)>100000 || Math.abs(p.y)>20000 || Math.abs(p.yaw)>100000 || p.scale<.25 || p.scale>8) throw new Error('Piece position or scale is out of range.');
    return {id:p.id,type:p.type,x:p.x,y:p.y,z:p.z,yaw:p.yaw,scale:p.scale};
  });
  return {version:1,pieces};
}
export const emptyLayout = () => ({version:1,pieces:[]});
export function encodeLayout(value) { return JSON.stringify(validateLayout(value)); }
export function decodeLayout(text) {
  if (typeof text !== 'string' || text.length > MAX_CODE) throw new Error('Layout code is too large.');
  try { return validateLayout(JSON.parse(text)); } catch(e) { throw new Error(`Cannot read layout: ${e.message}`); }
}
export function createLayouts(storage) {
  let state={enabled:false,current:emptyLayout(),named:{}};
  let warning='';
  try {
    const saved=storage?.getItem(STORAGE_KEY);
    if(saved) {
      const s=JSON.parse(saved);state.enabled=s.enabled===true;state.current=validateLayout(s.current);
      for(const [name,layout] of Object.entries(s.named || {})) if(name.length<=80) Object.defineProperty(state.named,name,{value:validateLayout(layout),enumerable:true,writable:true,configurable:true});
    }
  } catch { warning='Saved builder data could not be read; it has not been overwritten.'; }
  function persist() {
    try { if(!storage) throw new Error();storage.setItem(STORAGE_KEY,JSON.stringify(state));warning='';return true; }
    catch { warning='Browser storage is unavailable or full. Export your layout to keep it.';return false; }
  }
  return {
    get warning(){return warning;}, get enabled(){return state.enabled;}, get current(){return clone(state.current);},
    names:()=>Object.keys(state.named).sort(),
    update(layout,enabled=state.enabled){state.current=validateLayout(layout);state.enabled=!!enabled;return persist();},
    save(name,layout){name=String(name).trim();if(!name || name.length>80) throw new Error('Use a name of 1–80 characters.');Object.defineProperty(state.named,name,{value:validateLayout(layout),enumerable:true,writable:true,configurable:true});persist();},
    load(name){if(!Object.hasOwn(state.named,name)) throw new Error('Layout not found.');return clone(state.named[name]);},
    remove(name){delete state.named[name];persist();},
  };
}
export function createHistory(initial=emptyLayout()) {
  let current=validateLayout(initial), past=[],future=[];
  return {
    get value(){return clone(current);},
    reset(value){current=validateLayout(value);past=[];future=[];},
    commit(value){value=validateLayout(value);if(encodeLayout(value)===encodeLayout(current))return false;past.push(current);if(past.length>100)past.shift();current=value;future=[];return true;},
    undo(){if(!past.length)return false;future.push(current);current=past.pop();return true;},
    redo(){if(!future.length)return false;past.push(current);current=future.pop();return true;},
  };
}
