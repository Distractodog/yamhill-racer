import * as THREE from 'three';
import { LIVERIES, sanitizeCosmetics, disposeCosmeticPreview } from './cosmetics.js';

let activeKeyboard = null;
// Registered during module evaluation, before settings/vehicle/race capture handlers.
if (typeof addEventListener === 'function') addEventListener('keydown', e => activeKeyboard?.(e), true);
const PRESET_KEY = 'yr-garage-presets-1';
const NAMES = { car: 'Car', bike: 'Dirt bike', jet: 'Jet' };
export function createGarage({ cosmetics, vehicles, onOpen = () => {}, onClose = () => {}, canOpen = () => true, rewards = null }) {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./garage.css', import.meta.url).href; document.head.append(link);
  let button = document.getElementById('garage-button');
  if (!button) { button = document.createElement('button'); button.id = 'garage-button'; button.className = 'menu-button'; button.textContent = 'Garage'; (document.getElementById('menu-bar') || document.body).append(button); }
  button.disabled = false;
  const dialog = document.createElement('section'); dialog.id = 'cosmetic-garage'; dialog.hidden = true; dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-labelledby','garage-title');
  dialog.innerHTML = `<div class="garage-shell"><header><div><h2 id="garage-title">Garage</h2></div><button type="button" class="garage-close" aria-label="Close garage">✕</button></header>
    <nav class="garage-tabs" aria-label="Customize vehicle">${Object.entries(NAMES).map(([k,n])=>`<button type="button" data-kind="${k}" aria-pressed="false">${n}</button>`).join('')}</nav>
    <div class="garage-layout"><div class="garage-preview"><div class="garage-canvas"></div><p class="garage-preview-help">Drag to turn · scroll to zoom</p><div class="garage-condition"></div><button type="button" class="garage-wash">Wash & repair</button></div>
    <form class="garage-controls"><h3>Paint & finish</h3><div class="garage-colors">${[['body','Body'],['trim','Trim'],['wheels','Wheels'],['helmet','Helmet'],['jacket','Jacket & pants'],['gloves','Gloves']].map(([key,label])=>`<label data-role="${key}"><span>${label}</span><input type="color" name="${key}" aria-label="${label} color"></label>`).join('')}</div>
    <div class="garage-pair"><label>Wheel style<select name="wheelStyle"><option value="factory">Factory spokes</option><option value="sport">Sport hubs</option><option value="rally">Rally discs</option></select></label><label>Race number<input name="number" inputmode="numeric" maxlength="2" pattern="[0-9]{1,2}" aria-label="Race number"></label></div>
    <h3>Livery</h3><div class="garage-liveries"></div>
    <h3>Saved looks</h3><div class="garage-presets">${[0,1,2].map(i=>`<div><span>Look ${i+1}</span><button type="button" data-save="${i}">Save</button><button type="button" data-load="${i}">Load</button></div>`).join('')}</div>
    <div class="garage-actions"><button type="button" class="garage-reset">Factory colors</button><button type="button" class="garage-done">Done</button></div><p class="garage-status" role="status" aria-live="polite">Changes save automatically.</p></form></div></div>`;
  document.body.append(dialog);
  const canvasHost = dialog.querySelector('.garage-canvas'), status = dialog.querySelector('.garage-status');
  let open = false, kind = vehicles.current.kind, renderer = null, scene = null, camera = null, model = null, platform = null;
  let rotation = .65, zoom = 1, pitch = .27, drag = null, previousFocus = null, presets = {}, modelRadius = 1, modelHeight = 1;
  try { const saved = JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); if (saved && typeof saved === 'object' && !Array.isArray(saved)) presets = saved; } catch {}
  const message = text => { status.textContent = text; };
  function preview() {
    if (!renderer) return;
    if (model) { scene.remove(model); disposeCosmeticPreview(model); }
    model = cosmetics.createPreview(kind); scene.add(model);
    const bounds = new THREE.Box3().setFromObject(model), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    model.position.sub(center); model.position.y += size.y/2;
    modelRadius = Math.max(size.x,size.z,size.y); modelHeight = size.y;
    orbit();
    platform.scale.set(modelRadius*.78,1,modelRadius*.78);
  }
  function orbit() {
    if (!camera) return;
    const distance = modelRadius * 1.6 * zoom;
    camera.position.set(Math.sin(rotation)*distance, modelHeight*.7+distance*pitch, Math.cos(rotation)*distance);
    camera.lookAt(0,modelHeight*.5,0);
  }
  function initRenderer() {
    if (renderer) return;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace; canvasHost.append(renderer.domElement);
      scene = new THREE.Scene(); camera = new THREE.PerspectiveCamera(38,1,.01,100);
      scene.add(new THREE.HemisphereLight('#e3f3ff','#655a47',2.2));
      const key = new THREE.DirectionalLight('#fff0db',2.4); key.position.set(3,6,5);scene.add(key);
      const rim = new THREE.DirectionalLight('#b2d6ff',1.6);rim.position.set(-4,3,-4);scene.add(rim);
      platform = new THREE.Mesh(new THREE.CylinderGeometry(1,1,.06,48),new THREE.MeshLambertMaterial({color:'#243a34'})); platform.position.y=-.08;scene.add(platform);
    } catch {
      renderer?.dispose(); renderer = null; scene = null; camera = null; platform = null;
      canvasHost.textContent='Live preview is unavailable on this device. Your colors still apply in the game.';
    }
  }
  function refresh() {
    const focusedLivery = dialog.contains(document.activeElement) ? document.activeElement?.dataset?.livery : null;
    const config=cosmetics.get(kind);
    dialog.querySelectorAll('[data-kind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.kind===kind)));
    for(const [name,value] of Object.entries(config)){const field=dialog.querySelector(`[name="${name}"]`);if(field)field.value=value;}
    for(const role of ['jacket','gloves'])dialog.querySelector(`[data-role="${role}"]`).hidden=kind!=='bike';
    dialog.querySelector('[data-role="helmet"]').hidden=kind==='jet';
    dialog.querySelector('[name="wheelStyle"]').closest('label').hidden=kind==='jet';
    dialog.querySelector('[data-role="wheels"]').hidden=kind==='jet';
    const list=dialog.querySelector('.garage-liveries');list.replaceChildren();
    for(const livery of LIVERIES){
      const b=document.createElement('button');b.type='button';b.dataset.livery=livery.id;
      const locked=livery.unlock&&!cosmetics.isUnlocked(livery.unlock);b.disabled=locked;b.setAttribute('aria-pressed',String(config.livery===livery.id));
      const title=document.createElement('strong');title.textContent=(locked?'🔒 ':'')+livery.name;
      const detail=document.createElement('span');detail.textContent=locked?livery.description:livery.description==='Clean factory finish'?'Original styling':livery.unlock?'Unlocked':'Available';b.append(title,detail);list.append(b);
      b.addEventListener('click',()=>{const saved=cosmetics.set(kind,{livery:livery.id});message(saved?'Saved to this browser.':'Browser storage is unavailable; changes last until you reload.');});
    }
    dialog.querySelectorAll('[data-load]').forEach(b=>b.disabled=!presets[kind]?.[+b.dataset.load]);
    const wear=cosmetics.getWear(kind);dialog.querySelector('.garage-condition').textContent=wear.dirt>.1?'Dusty':wear.scuff>.1?'Scuffed':wear.wet>.1?'Wet finish':'Clean';
    preview();
    if (focusedLivery) list.querySelector(`[data-livery="${focusedLivery}"]`)?.focus();
  }
  function show() {
    if(open||!canOpen())return;
    previousFocus=document.activeElement;onOpen();open=true;kind=vehicles.current.kind;dialog.hidden=false;button.setAttribute('aria-expanded','true');
    initRenderer();refresh();dialog.querySelector('.garage-close').focus();update(0);
  }
  function close() { if(!open)return;open=false;dialog.hidden=true;button.setAttribute('aria-expanded','false');onClose();previousFocus?.focus?.(); }
  function update() {
    if(!open||!renderer||!model)return;
    const r=canvasHost.getBoundingClientRect();if(r.width<1||r.height<1)return;
    const width=Math.round(r.width),height=Math.round(r.height);const current=renderer.getSize(new THREE.Vector2());
    if(current.x!==width||current.y!==height){renderer.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();}
    renderer.render(scene,camera);
  }
  dialog.querySelector('.garage-close').addEventListener('click',close);dialog.querySelector('.garage-done').addEventListener('click',close);
  button.addEventListener('click',()=>open?close():show());button.setAttribute('aria-controls','cosmetic-garage');button.setAttribute('aria-expanded','false');
  dialog.querySelector('form').addEventListener('submit',e=>e.preventDefault());
  dialog.querySelectorAll('[data-kind]').forEach(b=>b.addEventListener('click',()=>{kind=b.dataset.kind;rotation=.65;zoom=1;refresh();}));
  dialog.querySelectorAll('input,select').forEach(field=>field.addEventListener('input',()=>{if(field.name==='number'&&!/^\d{1,2}$/.test(field.value))return;const saved=cosmetics.set(kind,{[field.name]:field.value});message(saved?'Saved to this browser.':'Browser storage is unavailable; changes last until you reload.');}));
  dialog.querySelector('.garage-wash').addEventListener('click',()=>{cosmetics.wash(kind);message('Washed, dried and polished.');});
  dialog.querySelector('.garage-reset').addEventListener('click',()=>{cosmetics.reset(kind);message('Factory colors restored. Saved looks are still available.');});
  dialog.querySelectorAll('[data-save]').forEach(b=>b.addEventListener('click',()=>{const slot=+b.dataset.save;if(!Array.isArray(presets[kind]))presets[kind]=[];presets[kind][slot]=cosmetics.get(kind);try{localStorage.setItem(PRESET_KEY,JSON.stringify(presets));message(`Look ${slot+1} saved for your ${NAMES[kind].toLowerCase()}.`);}catch{message('Browser storage is unavailable; this look lasts until you reload.');}refresh();}));
  dialog.querySelectorAll('[data-load]').forEach(b=>b.addEventListener('click',()=>{const p=presets[kind]?.[+b.dataset.load];if(p){cosmetics.set(kind,sanitizeCosmetics(p,kind,cosmetics.isUnlocked));message(`Look ${+b.dataset.load+1} loaded.`);}}));
  canvasHost.addEventListener('pointerdown',e=>{drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvasHost.setPointerCapture(e.pointerId);});
  canvasHost.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;rotation+=(e.clientX-drag.x)*.012;pitch=Math.max(.05,Math.min(.8,pitch+(e.clientY-drag.y)*.004));drag.x=e.clientX;drag.y=e.clientY;orbit();});
  for(const event of ['pointerup','pointercancel'])canvasHost.addEventListener(event,()=>{drag=null;});
  canvasHost.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(.65,Math.min(1.7,zoom+e.deltaY*.001));orbit();},{passive:false});
  const keyboard=e=>{
    if(!open)return;e.gameUI=true;
    if(e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();return;}
    if(e.code==='Tab'){
      const items=[...dialog.querySelectorAll('button,input,select')].filter(el=>!el.disabled&&el.getClientRects().length);const first=items[0],last=items.at(-1);
      if(!items.length){e.preventDefault();return;}
      if(e.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){e.preventDefault();last.focus();}else if(!e.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){e.preventDefault();first.focus();}
    }
    // Keep gameplay listeners from handling keys while preserving native form controls.
    e.stopImmediatePropagation();
  };
  activeKeyboard = keyboard;
  cosmetics.subscribe(()=>{if(open)refresh();});rewards?.subscribe?.(()=>{cosmetics.refreshUnlocks();});
  return { show,close,update,get open(){return open;},get selectedKind(){return kind;} };
}
