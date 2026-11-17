import * as THREE from 'three';
import { PIECES, BY_ID, CATEGORIES, snapPlacement } from './pieces.js';
import { createLayouts, createHistory, emptyLayout, encodeLayout, decodeLayout, MAX_PIECES } from './layouts.js';
import { createPlacedLayer, createPlacedMeshes } from './placed.js';
import { layoutChunks, acceptChunk } from './wire.js';

// Register before main constructs the vehicle picker and Settings capture handlers.
let keyboardHandler = null;
if (typeof addEventListener === 'function') addEventListener('keydown', e => keyboardHandler?.(e), true);

export function createBuilder({scene,camera,renderer,world,vehicle,mp,canOpen=()=>true,beforeOpen=()=>{},onDrive=()=>{},clearKeys=()=>{}}) {
  let storage;try{storage=localStorage;}catch{}
  const layouts=createLayouts(storage),history=createHistory(layouts.current),layer=createPlacedLayer(),meshes=createPlacedMeshes(scene);
  let enabled=layouts.enabled,opened=false,remote=null,pending=null,revision=0,selected=null,mode='ramp-medium',moving=false;
  let fineRotation=false,yaw=0,scale=1,lift=0,snap=true,ghost=null,draft=null,lookYaw=0,lookPitch=-.45,drag=null,dirty=true;
  const selectionBox=new THREE.Box3Helper(new THREE.Box3(),0x98e5c5);selectionBox.visible=false;scene.add(selectionBox);
  const held=new Set(),pointer=new THREE.Vector2(),ray=new THREE.Raycaster(),direction=new THREE.Vector3();
  const css=document.createElement('link');css.rel='stylesheet';css.href=new URL('./builder.css',import.meta.url).href;document.head.append(css);
  const panel=document.createElement('section');panel.id='builder-panel';panel.hidden=true;panel.setAttribute('aria-label','Builder');
  panel.innerHTML=`<h2>Builder</h2><p>Make your own place to race.</p><div class="builder-row"><button id="builder-drive">Drive · B</button><button id="builder-select">Select</button></div>
    <label>Piece category<select id="builder-category"></select></label><div id="builder-palette"></div>
    <div class="builder-row"><button id="builder-move">Move</button><button id="builder-duplicate">Duplicate</button><button id="builder-delete">Delete</button></div>
    <div class="builder-row"><button id="builder-undo">Undo</button><button id="builder-redo">Redo</button><button id="builder-snap" aria-pressed="true">Snap: on</button></div>
    <p id="builder-status" role="status"></p><small>WASD fly · drag to look · Shift fast<br>Wheel up/down · Q/E rotate (Shift fine)<br>R/F raise/lower · [ ] scale · G snap<br>Click place/select · Del remove<br>Ctrl/⌘ D duplicate · Z undo · Y redo<br>Esc cancels placement · B drives</small>
    <h3>Layouts</h3><input id="builder-name" aria-label="Layout name" placeholder="Name this layout" maxlength="80"><div class="builder-row"><button id="builder-save">Save</button><button id="builder-new">New</button></div>
    <select id="builder-layouts" aria-label="Saved layouts"></select><div class="builder-row"><button id="builder-load">Load</button><button id="builder-remove">Delete saved</button></div>
    <h3>Share</h3><div class="builder-row"><button id="builder-export">Export JSON</button><button id="builder-code">Show code</button><button id="builder-file">Import file</button></div>
    <textarea id="builder-text" aria-label="Layout code" placeholder="Paste a layout code here"></textarea><div class="builder-row"><button id="builder-copy">Copy code</button><button id="builder-import">Import code</button></div><input id="builder-file-input" type="file" accept=".json,application/json" hidden>`;
  document.body.append(panel);
  const button=document.createElement('button');button.id='builder-open';button.textContent='Builder · B';document.body.append(button);
  const el=id=>panel.querySelector(`#builder-${id}`), status=text=>{el('status').textContent=text;};
  const readOnly=()=>!!mp?.roomCode && !mp.isHost;
  const listeners=new Set();
  function notify(){button.hidden=!enabled || opened || readOnly();for(const fn of listeners)fn();}
  function apply(save=true) {
    const current=remote ?? (enabled?history.value:emptyLayout());
    layer.set(current);meshes.set(current);world.setPlacedPieces(current.pieces.length?layer:null);
    if(save && !readOnly()){layouts.update(history.value,enabled);broadcast();}
    if(layouts.warning)status(layouts.warning);else status(`${current.pieces.length} pieces · ${readOnly()?'Host layout · read-only':'Autosaved'}`);
    highlight();dirty=true;notify();
  }
  function broadcast(){if(mp?.inGame && mp.isHost){const code=encodeLayout(enabled?history.value:emptyLayout());for(const chunk of layoutChunks(code,`${Date.now()}_${++revision}`))mp.send(chunk);}}
  function commit(value){if(readOnly())return;history.commit(value);apply();}
  function mutate(fn){const next=history.value;fn(next.pieces);commit(next);}
  function freshId(){return globalThis.crypto?.randomUUID?.() ?? `p${Date.now()}_${Math.random().toString(36).slice(2)}`;}
  function removeGhost(){if(ghost){scene.remove(ghost);ghost.traverse(o=>{if(o.isMesh)o.material.dispose();});ghost=null;}draft=null;}
  function preview(type){removeGhost();if(!type)return;ghost=BY_ID.get(type).build().clone(true);ghost.traverse(o=>{if(o.isMesh){o.material=o.material.clone();o.material.transparent=true;o.material.opacity=.46;o.material.depthWrite=false;o.castShadow=false;}});scene.add(ghost);dirty=true;}
  function choose(type){mode=type;selected=null;moving=false;selectionBox.visible=false;lift=0;preview(type);status(`${BY_ID.get(type).name} · click to place`);}
  function selectMode(){mode=null;selected=null;moving=false;selectionBox.visible=false;removeGhost();status('Click a placed piece to select it.');}
  function selectedPiece(){return history.value.pieces.find(p=>p.id===selected);}
  function highlight(){
    const p=selectedPiece();selectionBox.visible=opened&&!!p&&!moving;
    if(!selectionBox.visible)return;
    const object=BY_ID.get(p.type).build().clone(true);object.position.set(p.x,p.y,p.z);object.rotation.y=p.yaw;object.scale.setScalar(p.scale);object.updateMatrixWorld(true);selectionBox.box.setFromObject(object);selectionBox.updateMatrixWorld(true);
  }
  function editSelected(fn){const p=selectedPiece();if(!p)return;mutate(list=>{const q=list.find(q=>q.id===selected);fn(q);});}
  const supportHeight=(x,z,exclude,ceiling)=>Math.max(world.baseHeightAt(x,z),layer.sample(x,z,undefined,exclude,ceiling)?.h ?? -Infinity);
  function duplicate(){const p=selectedPiece();if(!p)return;mode=p.type;selected=null;moving=false;yaw=p.yaw;scale=p.scale;lift=p.y-supportHeight(p.x,p.z,p.id,p.y+.01);selectionBox.visible=false;preview(mode);status('Duplicate · click to place');}
  function move(){const p=selectedPiece();if(!p)return;mode=p.type;moving=true;yaw=p.yaw;scale=p.scale;lift=p.y-supportHeight(p.x,p.z,p.id,p.y+.01);selectionBox.visible=false;preview(mode);status('Move · click to confirm');}
  function remove(){if(!selected)return;mutate(list=>{const i=list.findIndex(p=>p.id===selected);if(i>=0)list.splice(i,1);});selectMode();}
  function undo(redo=false){if(readOnly())return;selectMode();if(redo?history.redo():history.undo())apply();}
  function setEnabled(value){if(readOnly())return false;if(!value && opened)close(false);enabled=!!value;apply();return true;}
  function open(){if(!enabled || readOnly() || !canOpen())return false;beforeOpen();clearKeys();held.clear();opened=true;panel.hidden=false;el('drive').focus({preventScroll:true});camera.position.copy(vehicle.pos).add(new THREE.Vector3(0,22,25));lookYaw=0;lookPitch=-.55;orient();choose('ramp-medium');notify();return true;}
  function close(drive=true){
    if(!opened)return true;
    if(drive){const hit=pick(new THREE.Vector2(0,0));if(!hit || !world.loadedAt(hit.x,hit.z)){status('Look at loaded ground or a piece before driving.');return false;}onDrive(hit,Math.atan2(direction.x,direction.z));}
    opened=false;selectionBox.visible=false;panel.hidden=true;if(panel.contains(document.activeElement))document.activeElement.blur();removeGhost();held.clear();drag=null;clearKeys();notify();return true;
  }
  function orient(){camera.rotation.set(lookPitch,lookYaw,0,'YXZ');camera.updateMatrixWorld();direction.set(0,0,-1).applyQuaternion(camera.quaternion);dirty=true;}
  function pick(ndc=pointer){
    // Use original drivable height plus other builder surfaces. Exclude the piece being moved.
    camera.updateMatrixWorld();
    ray.setFromCamera(ndc,camera);
    const height=(x,z)=>supportHeight(x,z,moving?selected:undefined);
    let last=0;
    for(let t=1;t<=1800;t+=Math.max(1,t*.012)) {
      const p=ray.ray.at(t,new THREE.Vector3());
      if(p.y<=height(p.x,p.z)) {
        let lo=last,hi=t;for(let i=0;i<12;i++){const mid=(lo+hi)/2,q=ray.ray.at(mid,new THREE.Vector3());if(q.y<=height(q.x,q.z))hi=mid;else lo=mid;}
        const hit=ray.ray.at(hi,new THREE.Vector3());if(!world.loadedAt(hit.x,hit.z))return null;return hit;
      }
      last=t;
    }
    return null;
  }
  function updatePreview(){
    if(!ghost)return;const hit=pick();ghost.visible=!!hit;if(!hit){draft=null;return;}
    draft=snapPlacement({id:moving?selected:freshId(),type:mode,x:hit.x,y:hit.y+lift,z:hit.z,yaw,scale},snap,fineRotation);
    ghost.position.set(draft.x,draft.y,draft.z);ghost.rotation.y=draft.yaw;ghost.scale.setScalar(draft.scale);ghost.updateMatrixWorld(true);
  }
  function place(){
    if(readOnly())return;
    if(mode && draft){if(history.value.pieces.length>=MAX_PIECES && !moving){status('Layout limit reached (1000 pieces).');return;}
      const p={...draft};mutate(list=>{if(moving){const i=list.findIndex(q=>q.id===selected);if(i>=0)list[i]=p;}else list.push(p);});
      if(moving){selected=p.id;mode=null;moving=false;removeGhost();highlight();status('Piece moved.');}else dirty=true;
    }else if(!mode){ray.setFromCamera(pointer,camera);meshes.group.updateMatrixWorld(true);const hit=ray.intersectObject(meshes.group,true)[0];selected=hit?.object.userData.pieces?.[hit.instanceId]?.id ?? null;const p=selectedPiece();highlight();status(p?`${BY_ID.get(p.type).name} selected · Move, rotate, scale or Delete`:'Click a placed piece.');}
  }
  function rotateOrRaise(code,fine){
    fineRotation=fine;
    const angle=(fine?1:15)*Math.PI/180,delta=fine?.1:1;
    const change=p=>{if(code==='KeyQ')p.yaw-=angle;if(code==='KeyE')p.yaw+=angle;if(code==='KeyR')p.y+=delta;if(code==='KeyF')p.y-=delta;if(code==='BracketLeft')p.scale=Math.max(.25,p.scale-.25);if(code==='BracketRight')p.scale=Math.min(8,p.scale+.25);};
    if(!mode && selected)editSelected(change);
    else {const p={yaw,y:lift,scale};change(p);yaw=p.yaw;lift=p.y;scale=p.scale;dirty=true;}
  }
  function toggleSnap(){snap=!snap;el('snap').textContent=`Snap: ${snap?'on':'off'}`;el('snap').setAttribute('aria-pressed',String(snap));dirty=true;}
  // Capture on window before game/menu handlers so builder keys never reset or drive a vehicle.
  keyboardHandler=e=>{
    const typing=e.target instanceof Element && e.target.matches('input,textarea,select,[contenteditable=true]');
    if(opened){if(typing || e.code==='Tab' || (panel.contains(e.target) && ['Enter','Space'].includes(e.code))){e.gameUI=true;return;}e.preventDefault();e.stopImmediatePropagation();if(!e.ctrlKey&&!e.metaKey)held.add(e.code);
      if(e.code==='KeyB' && !e.repeat)close();
      else if(e.code==='Escape'){selectMode();}
      else if((e.ctrlKey||e.metaKey) && !e.repeat){if(e.code==='KeyD')duplicate();if(e.code==='KeyZ')undo(e.shiftKey);if(e.code==='KeyY')undo(true);}
      else if(e.code==='Delete'||e.code==='Backspace')remove();
      else if(e.code==='KeyG'&&!e.repeat)toggleSnap();
      else if(['KeyQ','KeyE','KeyR','KeyF','BracketLeft','BracketRight'].includes(e.code))rotateOrRaise(e.code,e.shiftKey);
    }else if(e.code==='KeyB'&&!typing&&!e.repeat&&enabled&&!readOnly()&&canOpen()){e.preventDefault();e.stopImmediatePropagation();open();}
  };
  // Native button activation uses Space key-up; game key-up handlers only release held input.
  addEventListener('keyup',e=>held.delete(e.code),true);
  addEventListener('blur',()=>{held.clear();drag=null;clearKeys();});
  document.addEventListener('visibilitychange',()=>{held.clear();drag=null;clearKeys();});
  const canvas=renderer.domElement;
  const setPointer=e=>{const r=canvas.getBoundingClientRect();pointer.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);dirty=true;};
  canvas.addEventListener('pointerdown',e=>{if(!opened)return;if(panel.contains(document.activeElement))document.activeElement.blur();e.preventDefault();setPointer(e);drag={x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:false,button:e.button};canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!opened)return;setPointer(e);if(drag){const dx=e.clientX-drag.lastX,dy=e.clientY-drag.lastY;drag.moved ||= Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>4;if(drag.moved||drag.button===2){lookYaw-=dx*.004;lookPitch=THREE.MathUtils.clamp(lookPitch-dy*.004,-1.5,1.4);orient();}drag.lastX=e.clientX;drag.lastY=e.clientY;}});
  canvas.addEventListener('pointerup',e=>{if(!opened)return;if(drag&&!drag.moved&&drag.button===0){updatePreview();place();}drag=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);});
  canvas.addEventListener('pointercancel',()=>{drag=null;});
  canvas.addEventListener('contextmenu',e=>{if(opened)e.preventDefault();});
  canvas.addEventListener('wheel',e=>{if(!opened)return;e.preventDefault();camera.position.y-=Math.sign(e.deltaY)*(e.shiftKey?10:2);dirty=true;},{passive:false});
  function action(id,fn){el(id).addEventListener('click',()=>{try{fn();}catch(e){status(e.message);}});}
  button.addEventListener('click',open);action('drive',()=>close());action('select',selectMode);action('move',move);action('duplicate',duplicate);action('delete',remove);
  action('undo',()=>undo());action('redo',()=>undo(true));action('snap',toggleSnap);
  function names(){el('layouts').replaceChildren(...layouts.names().map(name=>{const o=document.createElement('option');o.value=o.textContent=name;return o;}));}
  action('save',()=>{layouts.save(el('name').value,history.value);names();status(layouts.warning||'Named layout saved.');});
  action('load',()=>{selectMode();commit(layouts.load(el('layouts').value));});action('remove',()=>{layouts.remove(el('layouts').value);names();});
  action('new',()=>{selectMode();commit(emptyLayout());});
  action('code',()=>{el('text').value=encodeLayout(history.value);el('text').focus();el('text').select();status('Layout code is ready to copy.');});
  action('copy',()=>{el('text').value=encodeLayout(history.value);el('text').focus();el('text').select();navigator.clipboard?.writeText(el('text').value).then(()=>status('Code copied.'),()=>status('Select the code and copy it with Ctrl/⌘ C.'));});
  action('import',()=>{const value=decodeLayout(el('text').value);selectMode();commit(value);});
  action('export',()=>{const url=URL.createObjectURL(new Blob([encodeLayout(history.value)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='yamhill-layout.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  action('file',()=>el('file-input').click());el('file-input').addEventListener('change',async()=>{try{const file=el('file-input').files[0];if(!file)return;if(file.size>512000)throw new Error('Layout file is too large.');const value=decodeLayout(await file.text());selectMode();commit(value);}catch(e){status(e.message);}finally{el('file-input').value='';}});
  // Tiny previews use the same prototype meshes. Build one per frame, only while the editor is open.
  let thumbRenderer=null,thumbScene=null,thumbCamera=null,thumbQueue=[];
  function palette(){thumbQueue=[];el('palette').replaceChildren();for(const d of PIECES.filter(p=>p.category===el('category').value)){const b=document.createElement('button'),c=document.createElement('canvas');c.width=128;c.height=72;b.append(c,document.createTextNode(d.name));b.title=d.name;b.addEventListener('click',()=>choose(d.id));el('palette').append(b);thumbQueue.push({d,c});}}
  for(const category of CATEGORIES){const o=document.createElement('option');o.value=o.textContent=category;el('category').append(o);}el('category').addEventListener('change',palette);palette();names();
  function thumbnail(){
    if(!thumbQueue.length)return;
    if(!thumbRenderer){thumbRenderer=new THREE.WebGLRenderer({alpha:true,antialias:true});thumbRenderer.setSize(128,72);thumbScene=new THREE.Scene();thumbScene.add(new THREE.HemisphereLight(0xffffff,0x556655,3));thumbCamera=new THREE.PerspectiveCamera(35,128/72,.1,1000);}
    const {d,c}=thumbQueue.shift(),model=d.build().clone(true);thumbScene.add(model);
    const box=new THREE.Box3().setFromObject(model),center=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length();thumbCamera.position.copy(center).add(new THREE.Vector3(size*.8,size*.65,size*.95));thumbCamera.lookAt(center);thumbRenderer.render(thumbScene,thumbCamera);c.getContext('2d').drawImage(thumbRenderer.domElement,0,0);thumbScene.remove(model);
  }
  mp?.on('connected',()=>{pending=null;if(readOnly()){close(false);remote=emptyLayout();apply(false);}else{remote=null;apply(false);broadcast();}});
  mp?.on('layout',m=>{if(!readOnly() || !mp.players.get(m.from)?.host)return;const result=acceptChunk(pending,m);pending=result.pending;if(result.complete){try{remote=decodeLayout(result.complete.map(c=>c.data).join(''));apply(false);}catch(e){status(e.message);}}});
  mp?.on('disconnected',({retrying})=>{if(!retrying){remote=null;pending=null;apply(false);}});
  apply(false);
  return {
    get open(){return opened;},get enabled(){return enabled;},get readOnly(){return readOnly();},get layout(){return remote??history.value;},layer,
    setEnabled,show:open,close,choose,select:selectMode,
    subscribe(fn){listeners.add(fn);fn();return()=>listeners.delete(fn);},
    replace(layout){if(readOnly())throw new Error('Only the host can edit this layout.');selectMode();commit(layout);},
    exportCode:()=>encodeLayout(remote??history.value),
    update(dt){if(!opened)return;const speed=(held.has('ShiftLeft')||held.has('ShiftRight')?100:25)*dt;const x=(held.has('KeyD')?1:0)-(held.has('KeyA')?1:0),z=(held.has('KeyS')?1:0)-(held.has('KeyW')?1:0);if(x||z){camera.position.x+=(Math.cos(lookYaw)*x+Math.sin(lookYaw)*z)*speed;camera.position.z+=(-Math.sin(lookYaw)*x+Math.cos(lookYaw)*z)*speed;dirty=true;}if(dirty || (ghost && !draft)){updatePreview();dirty=false;}thumbnail();},
    step(v){if(enabled||remote)layer.applyBoost(v);},
  };
}
