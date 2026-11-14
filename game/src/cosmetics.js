import * as THREE from 'three';
import { buildCarModel } from './carmodel.js';
import { buildBikeModel } from './bike.js';
import { buildJetModel } from './jet.js';

export const COSMETIC_KEY = 'yr-cosmetics-1';
export const LIVERIES = [
  { id: 'classic', name: 'Classic', description: 'Clean factory finish' },
  { id: 'stripes', name: 'Twin stripes', description: 'A pair of racing stripes' },
  { id: 'number', name: 'Race number', description: 'Your own competition number' },
  { id: 'campus', name: 'Delphian green', unlock: 'campus', description: 'Finish the Long Walk race' },
  { id: 'trail', name: 'Trail explorer', unlock: 'trail', description: 'Complete the dirt-bike series' },
  { id: 'jet', name: 'Sky captain', unlock: 'jet', description: 'Complete the jet series' },
];
export const DEFAULT_COSMETICS = {
  car: { body: '#e8402f', trim: '#ffffff', wheels: '#d9dce2', helmet: '#ffd23a', jacket: '#ffffff', gloves: '#20242a', livery: 'classic', number: '07', wheelStyle: 'factory' },
  bike: { body: '#ff7a1a', trim: '#f2f2ee', wheels: '#8a9099', helmet: '#ff7a1a', jacket: '#f2f2ee', gloves: '#1d1f24', livery: 'classic', number: '07', wheelStyle: 'factory' },
  jet: { body: '#eef0f2', trim: '#ff6a1a', wheels: '#8a9099', helmet: '#ffd23a', jacket: '#ffffff', gloves: '#20242a', livery: 'classic', number: '07', wheelStyle: 'factory' },
};
const COLOR_FIELDS = ['body', 'trim', 'wheels', 'helmet', 'jacket', 'gloves'];
export function sanitizeCosmetics(value, kind = 'car', isUnlocked = () => false) {
  const base = { ...DEFAULT_COSMETICS[kind] };
  if (!value || typeof value !== 'object') return base;
  for (const key of COLOR_FIELDS) if (typeof value[key] === 'string' && /^#[0-9a-f]{6}$/i.test(value[key])) base[key] = value[key];
  const livery = LIVERIES.find(l => l.id === value.livery);
  if (livery && (!livery.unlock || isUnlocked(livery.unlock))) base.livery = livery.id;
  if (typeof value.number === 'string' && /^\d{1,2}$/.test(value.number)) base.number = value.number;
  if (['factory', 'sport', 'rally'].includes(value.wheelStyle)) base.wheelStyle = value.wheelStyle;
  return base;
}
const BUILDERS = { car: buildCarModel, bike: buildBikeModel, jet: buildJetModel };
const mudColor = new THREE.Color('#66523b'), scratchColor = new THREE.Color('#aeb2b3');
function disposeTree(group) {
  const materials = new Set(), geometries = new Set(), textures = new Set();
  group.traverse(o => { if (o.geometry) geometries.add(o.geometry); for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) { materials.add(m); if (m.map) textures.add(m.map); } });
  geometries.forEach(g => g.dispose()); textures.forEach(t => t.dispose()); materials.forEach(m => m.dispose());
}
export { disposeTree as disposeCosmeticPreview };
function bindModel(model, kind) {
  const materials = new Map(), vertex = [], tyres = [], wheels = model.userData.wheels || [];
  model.traverse(o => {
    if (!o.isMesh) return;
    const role = o.material?.userData?.cosmeticRole;
    if (role) materials.set(o.material, role);
    if (kind === 'car' && o.geometry?.attributes.color) {
      const a = o.geometry.attributes.color, mask = new Uint8Array(a.count);
      const palette = [null, new THREE.Color('#e8402f'), new THREE.Color('#ffffff'), new THREE.Color('#ffd23a')];
      for (let i = 0; i < a.count; i++) for (let j = 1; j < palette.length; j++) {
        const c = palette[j]; if (Math.abs(a.getX(i) - c.r) + Math.abs(a.getY(i) - c.g) + Math.abs(a.getZ(i) - c.b) < .001) { mask[i] = j; break; }
      }
      vertex.push({ a, mask });
    }
  });
  if (kind === 'car') for (const w of wheels) materials.set(w.spin.children[1].material, 'wheels');
  for (const w of wheels) {
    const tyre = w.spin.children[0];
    if (tyre?.material?.color) { tyre.material = tyre.material.clone(); tyres.push(tyre.material); }
  }
  const parent = kind === 'car' ? model.userData.bodyPivot : kind === 'bike' ? model.userData.lean.children[0] : model;
  const decals = new THREE.Group(); decals.name = 'cosmetic-livery'; parent.add(decals);
  const scratches = makeScratches(kind); parent.add(scratches);
  const trim = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
  const hubs = [];
  for (const w of wheels) {
    const g = new THREE.CylinderGeometry(w.r * .72, w.r * .72, kind === 'car' ? .48 : .17, 12).rotateZ(Math.PI / 2);
    const hub = new THREE.Mesh(g, trim); hub.visible = false; w.spin.add(hub); hubs.push(hub);
  }
  return { model, kind, materials, vertex, tyres: [...new Set(tyres)], decals, scratches, hubs, trim, signature: '', wearSignature: '' };
}
function makeScratches(kind) {
  const group = new THREE.Group(); group.name = 'cosmetic-scuffs';
  if (typeof document === 'undefined') return group;
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d'); ctx.strokeStyle = '#c4c7c3';
  for (let i=0;i<18;i++) { const x=(i*37)%110,y=(i*23)%110; ctx.lineWidth=i%3===0?2:1; ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+12+(i%9),y+5);ctx.stroke(); }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({map:texture,transparent:true,opacity:0,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-3});
  const add=(w,h,x,y,z,rx,ry=0)=>{const mesh=new THREE.Mesh(new THREE.PlaneGeometry(w,h),material);mesh.position.set(x,y,z);mesh.rotation.set(rx,ry,0);mesh.renderOrder=4;group.add(mesh);};
  if(kind==='car')for(const side of [-1,1])add(.42,.65,side*.58,.278,-.22,-Math.PI/2);
  if(kind==='bike')for(const side of [-1,1])add(.3,.16,side*.177,.22,-.45,0,side*Math.PI/2);
  if(kind==='jet')for(const side of [-1,1])add(1.1,.65,side*2.5,.09,-1.2,-Math.PI/2);
  return group;
}
function decalTexture(config) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = config.trim;
  if (config.livery === 'stripes') { ctx.fillRect(55, 0, 44, 256); ctx.fillRect(157, 0, 44, 256); }
  else {
    ctx.fillStyle = ({ campus: '#164a39', trail: '#b97027', jet: '#244f8c' })[config.livery] || config.trim;
    ctx.fillRect(8, 8, 240, 240);
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 8; ctx.strokeRect(16, 16, 224, 224);
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '900 128px system-ui'; ctx.fillText(config.number, 128, 133);
    if (config.livery !== 'number') { ctx.font = '700 23px system-ui'; ctx.fillText(({campus:'DELPHIAN',trail:'TRAIL',jet:'SKY CAPTAIN'})[config.livery] || '',128,216); }
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
function applyBinding(binding, config, wear) {
  const { kind, materials, vertex, decals, hubs, trim } = binding;
  binding.wearSignature = [wear.dirt,wear.scuff,wear.wet].map(v=>Math.round(v*1000)).join('/');
  binding.scratches.visible = wear.scuff > .01;
  binding.scratches.children.forEach(mesh=>{mesh.material.opacity=Math.min(.7,wear.scuff);});
  const tint = role => new THREE.Color(config[role]).lerp(mudColor, role === 'body' || role === 'wheels' ? wear.dirt * .55 : wear.dirt * .18).lerp(scratchColor, role === 'body' ? wear.scuff * .12 : 0).multiplyScalar(1 - wear.wet * .12);
  for (const [material, role] of materials) material.color.copy(tint(role));
  const colors = [null, tint('body'), tint('trim'), tint('helmet')];
  for (const { a, mask } of vertex) { for (let i = 0; i < mask.length; i++) if (mask[i]) { const c = colors[mask[i]]; a.setXYZ(i, c.r, c.g, c.b); } a.needsUpdate = true; }
  for (const m of binding.tyres) m.color.set('#1d1e22').lerp(mudColor, wear.dirt * .7).multiplyScalar(1 - wear.wet * .15);
  trim.color.copy(tint('wheels'));
  hubs.forEach(h => { h.visible = config.wheelStyle !== 'factory'; h.scale.set(1, config.wheelStyle === 'sport' ? .72 : 1, config.wheelStyle === 'sport' ? .72 : 1); });
  const signature = [config.livery, config.trim, config.number].join('/');
  if (signature === binding.signature) return;
  binding.signature = signature;
  for (const child of [...decals.children]) { decals.remove(child); disposeTree(child); }
  if (config.livery === 'classic') return;
  const texture = decalTexture(config); if (!texture) return;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
  const add = (w, h, x, y, z, rx, ry = 0) => { const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material); mesh.position.set(x,y,z); mesh.rotation.set(rx,ry,0); mesh.renderOrder = 3; decals.add(mesh); };
  if (kind === 'car') { add(.38,.65,0,.32,1.0,-Math.PI/2); for (const side of [-1,1]) add(.58,.72,side*.58,.272,-.2,-Math.PI/2); }
  if (kind === 'bike') for (const side of [-1,1]) add(.3,.16,side*.174,.22,-.45,0,side*Math.PI/2);
  if (kind === 'jet') for (const side of [-1,1]) add(1.35,1.05,side*2.6,.085,-1.15,-Math.PI/2);
}

function browserStorage() { try { return globalThis.localStorage; } catch { return null; } }
export function createCosmetics(vehicles, { isUnlocked = () => false, storage = browserStorage() } = {}) {
  let saved = {}; try { saved = JSON.parse(storage?.getItem(COSMETIC_KEY) || '{}'); } catch {}
  const configs = {}, bindings = {}, wear = {}, listeners = new Set(); let accumulator = 0, forcedWet = 0;
  for (const kind of Object.keys(BUILDERS)) { configs[kind] = sanitizeCosmetics(saved?.[kind], kind, isUnlocked); bindings[kind] = bindModel(vehicles.all[kind].mesh, kind); wear[kind] = { dirt: 0, scuff: 0, wet: 0 }; applyBinding(bindings[kind], configs[kind], wear[kind]); }
  const persist = () => { try { if (!storage) return false; storage.setItem(COSMETIC_KEY, JSON.stringify(configs)); return true; } catch { return false; } };
  const notify = kind => listeners.forEach(fn => fn(kind));
  const api = {
    get: kind => ({ ...configs[kind] }),
    getWear: kind => ({ ...wear[kind] }),
    isUnlocked,
    set(kind, patch) { if (!configs[kind]) return; configs[kind] = sanitizeCosmetics({ ...configs[kind], ...patch }, kind, isUnlocked); applyBinding(bindings[kind], configs[kind], wear[kind]); const saved = persist(); notify(kind); return saved; },
    reset(kind) { api.set(kind, DEFAULT_COSMETICS[kind]); api.wash(kind); },
    wash(kind) { if (!wear[kind]) return; wear[kind] = { dirt: 0, scuff: 0, wet: 0 }; applyBinding(bindings[kind], configs[kind], wear[kind]); notify(kind); },
    setWetness(value) { forcedWet = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refreshUnlocks() { notify(vehicles.current.kind); },
    createPreview(kind) { const model = BUILDERS[kind](); const binding = bindModel(model, kind); applyBinding(binding, configs[kind], wear[kind]); return model; },
    update(dt, vehicle = vehicles.current) {
      if (!vehicle || !wear[vehicle.kind] || !Number.isFinite(dt)) return;
      const state = wear[vehicle.kind], speed = vehicle.vel.length();
      const dirty = vehicle.grounded && [0,1,2,4].includes(vehicle.surface) && speed > 2;
      state.dirt = Math.min(1, state.dirt + (dirty ? dt * Math.min(speed, 50) * .00015 : 0));
      state.scuff = Math.min(1, state.scuff + (vehicle.hit > .1 ? dt * .06 : 0));
      state.wet = vehicle.surface === 5 ? 1 : Math.max(forcedWet, state.wet - dt * .02);
      accumulator += dt; if (accumulator < .2) return; accumulator = 0;
      const wearSignature = [state.dirt,state.scuff,state.wet].map(v=>Math.round(v*1000)).join('/');
      if (wearSignature !== bindings[vehicle.kind].wearSignature) applyBinding(bindings[vehicle.kind], configs[vehicle.kind], state);
    },
  };
  return api;
}
