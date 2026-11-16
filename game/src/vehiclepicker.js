// The V picker: a centred panel with three big cards (Car · Bike · Aircraft), each a picture of your current type in
// your paint (vehiclethumbs.js), its name and key 1/2/3; under the selected card a row of that vehicle's types with
// pictures and 1–5 stat bars (vehiclestats.js), so vehicle and type are picked in one go. Choosing goes through
// vehicles.choose (vehicles.js: the Garage's setType, then switchTo).
// Keys (read by vehicles.js's listener): V / Esc close · 1–3 switch at once · ←/→ or A/D move · ↓/S into the types,
// ↑/W back · Enter chooses · Tab cycles inside. Mouse: hover a card to see its types, click to choose, click outside
// to close. Game keys are held off while it's open (main.js readInput; single-player also pauses physics there).
// During a race the type chips are locked, as the Garage is (switching vehicle still ends the race, like before).
import { VEHICLE_TYPES, typeInfo } from './vehicletypes.js';
import { VEHICLES } from './vehicles.js';
import { typeStats } from './vehiclestats.js';
import { THUMB_W, THUMB_H } from './vehiclethumbs.js';

const KINDS = VEHICLES.map(v => v.kind);
const LABEL = { car: 'Car', bike: 'Bike', jet: 'Aircraft' };
const ICON = { car: '🏎️', bike: '🏍️', jet: '✈️', heli: '🚁' };
const CHIP_W = 180, CHIP_H = 112;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function statsHTML(kind, id) {
  const s = typeStats(kind, id);
  return `<span class="vp-stats" aria-hidden="true">${[s.top, s.handling, s.offroad].map((n, i) =>
    `<span class="vp-stat"><span class="vp-stat-l">${s.labels[i]}</span><span class="vp-bars">${'<i class="on"></i>'.repeat(n)}${'<i></i>'.repeat(5 - n)}</span></span>`).join('')}</span>`;
}
const statsText = (kind, id) => { const s = typeStats(kind, id); return [s.top, s.handling, s.offroad].map((n, i) => `${s.labels[i]} ${n} of 5`).join(', '); };

// vehicles (vehicles.js), thumbs (vehiclethumbs.js); onOpen: close other panels and drop held keys;
// racing(): a race is on (types locked, a switch ends it); canOpen(): false while it may not open (the spawn map)
export const RACE_LOCKED = 'Finish or leave your race to change type';      // (the Garage's race message, main.js)
export function createVehiclePicker({ vehicles, thumbs, onOpen = () => {}, onClose = () => {}, racing = () => false, canOpen = () => true }) {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./vehiclepicker.css', import.meta.url).href; document.head.append(link);
  const root = document.createElement('section');
  root.id = 'veh-menu'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'vp-title');
  root.innerHTML = `<div class="vp-panel">
    <header class="vp-head"><h2 id="vp-title">Vehicles</h2><button type="button" class="vp-close" aria-label="Close vehicles">✕</button></header>
    <div class="vp-cards" role="group" aria-label="Vehicle">${KINDS.map((kind, i) => `
      <button type="button" class="vp-card" data-kind="${kind}" data-row="cards" aria-describedby="vp-desc">
        <span class="vp-key" aria-hidden="true">${i + 1}</span><span class="vp-now" aria-hidden="true">Driving</span>
        <span class="vp-pic"><span class="vp-icon" aria-hidden="true"></span><canvas width="${THUMB_W}" height="${THUMB_H}" aria-hidden="true"></canvas></span>
        <span class="vp-kind" aria-hidden="true">${LABEL[kind]}</span><span class="vp-name" aria-hidden="true"></span><span class="vp-card-stats"></span>
      </button>`).join('')}</div>
    <div class="vp-types">${KINDS.map(kind => `
      <div class="vp-row" data-kind="${kind}" role="group" aria-label="${LABEL[kind]} types" hidden>${VEHICLE_TYPES[kind].map(t => `
        <button type="button" class="vp-chip" data-kind="${kind}" data-type="${t.id}" data-row="types" aria-describedby="vp-desc">
          <span class="vp-pic"><span class="vp-icon" aria-hidden="true">${ICON[t.id] || ICON[kind]}</span><canvas width="${CHIP_W}" height="${CHIP_H}" aria-hidden="true"></canvas></span>
          <span class="vp-name" aria-hidden="true">${esc(t.name)}</span>${statsHTML(kind, t.id)}
        </button>`).join('')}</div>`).join('')}
      <p class="vp-lock" id="vp-lock" role="status" hidden>🔒 ${RACE_LOCKED}</p></div>
    <p class="vp-desc" id="vp-desc"></p>
    <p class="vp-help"></p>
    <p class="vp-hint"></p>
  </div>`;
  document.body.append(root);
  const cards = [...root.querySelectorAll('.vp-card')], rows = [...root.querySelectorAll('.vp-row')];
  const chipsOf = kind => [...root.querySelectorAll(`.vp-chip[data-kind="${kind}"]`)];
  const lockNote = root.querySelector('.vp-lock');
  let open = false, sel = 0, row = 'cards', tsel = 0, returnFocus = null, touch = false, downSel = 0;

  const kindAt = i => KINDS[i];
  const typeIndex = kind => Math.max(0, VEHICLE_TYPES[kind].findIndex(t => t.id === vehicles.getType(kind)));
  function helpFor(kind, id) {
    const v = vehicles.vehicleFor(kind, id), base = VEHICLES.find(x => x.kind === kind).help;
    if (v?.help) return v.help;                               // (the helicopter brings its own)
    return typeInfo(kind, id)?.physics?.noWheelie ? base.replace('Shift wheelie · ', '') : base;
  }

  function paint(canvas, kind, id) {
    const img = thumbs?.get(kind, id), pic = canvas.parentElement;
    pic.classList.toggle('vp-empty', !img);
    if (!img) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }
  function paintAll(kind = null, id = null) {
    cards.forEach(c => { const k = c.dataset.kind; if (!kind || (k === kind && vehicles.getType(k) === id)) paint(c.querySelector('canvas'), k, vehicles.getType(k)); });
    root.querySelectorAll('.vp-chip').forEach(c => { if (!kind || (c.dataset.kind === kind && c.dataset.type === id)) paint(c.querySelector('canvas'), c.dataset.kind, c.dataset.type); });
  }
  thumbs?.onUpdate((kind, id) => { if (open) paintAll(kind, id); });

  // everything that depends on the current vehicle / types / selection
  function refresh() {
    const curKind = vehicles.current.kind, kind = kindAt(sel), race = racing();
    cards.forEach((c, i) => {
      const k = c.dataset.kind, id = vehicles.getType(k), t = typeInfo(k, id), now = k === curKind;
      c.classList.toggle('cur', now); c.classList.toggle('sel', i === sel);
      c.querySelector('.vp-name').textContent = t.name;
      c.querySelector('.vp-icon').textContent = ICON[id] || ICON[k];
      c.querySelector('.vp-card-stats').innerHTML = statsHTML(k, id);
      if (now) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current');
      c.setAttribute('aria-label', `${LABEL[k]}: ${t.name}. Key ${i + 1}. ${statsText(k, id)}.${now ? ' Driving now.' : ''}`);
    });
    rows.forEach(r => { r.hidden = r.dataset.kind !== kind; });
    root.querySelector('.vp-types').style.setProperty('--at', sel);
    chipsOf(kind).forEach((c, i) => {
      const id = c.dataset.type, mine = id === vehicles.getType(kind), now = mine && kind === curKind;
      c.classList.toggle('cur', mine); c.classList.toggle('sel', row === 'types' && i === tsel);
      if (mine) c.setAttribute('aria-current', 'true'); else c.removeAttribute('aria-current');
      // locked in a race: still focusable (so the reason is read out), but choosing it only shows the message
      c.setAttribute('aria-disabled', String(race));
      c.setAttribute('aria-label', `${typeInfo(kind, id).name}. ${statsText(kind, id)}.${now ? ' Driving now.' : mine ? ' Your ' + LABEL[kind].toLowerCase() + '.' : ''}${race ? ' ' + RACE_LOCKED + '.' : ''}`);
    });
    root.querySelector('.vp-types').classList.toggle('locked', race);
    if (!race) lockNote.classList.remove('flash');
    lockNote.hidden = !race;
    const shown = row === 'types' ? VEHICLE_TYPES[kind][tsel] : typeInfo(kind, vehicles.getType(kind));
    root.querySelector('.vp-desc').innerHTML = `<strong>${esc(shown.name)}</strong> ${esc(shown.description)}`;
    root.querySelector('.vp-help').textContent = helpFor(kind, shown.id);
    root.querySelector('.vp-hint').textContent = `1–3 switch · ←/→ vehicle · ↓ types · Enter or click to choose · V or Esc to close` +
      (race ? ' · switching vehicle ends the race you\'re in' : '');
    thumbs?.want([...KINDS.map(k => [k, vehicles.getType(k)]), ...VEHICLE_TYPES[kind].map(t => [kind, t.id])]);
  }
  const focusSel = () => (row === 'types' ? chipsOf(kindAt(sel))[tsel] : cards[sel])?.focus({ preventScroll: true });
  function select(i, { r = row, t = null, focus = true } = {}) {
    const changed = i !== sel;
    sel = (i + KINDS.length) % KINDS.length; row = r;
    if (t !== null) tsel = t; else if (changed || r === 'cards') tsel = typeIndex(kindAt(sel));
    refresh(); if (focus) focusSel();
  }

  // a type chip in a race: no change, the message flashes (the picker stays open)
  function chooseType(kind, id) {
    if (!racing()) { choose(kind, id); return; }
    lockNote.classList.remove('flash'); void lockNote.offsetWidth; lockNote.classList.add('flash');
  }
  function choose(kind, id = null) {
    close({ restore: false });                // back to driving: focus leaves the page's buttons (Space = handbrake)
    vehicles.choose(kind, id);
  }
  // from: the button that opened it (☰ Menu → Vehicles); Esc / ✕ / a click outside give focus back to the menu. Opened
  // with V, focus is left on nothing, so the next Space can't press a menu button.
  function show(from = null) {
    if (open || !canOpen()) return;
    onOpen();
    returnFocus = from ? (from.closest?.('#menu-panel') ? document.getElementById('menu-button') : from) : null;
    open = true; root.hidden = false;
    sel = Math.max(0, KINDS.indexOf(vehicles.current.kind)); row = 'cards'; tsel = typeIndex(kindAt(sel));
    refresh(); paintAll(); focusSel();
  }
  function close({ restore = true } = {}) {
    if (!open) return;
    open = false; root.hidden = true;
    const back = restore ? returnFocus : null; returnFocus = null;
    if (back?.isConnected && !back.closest('[hidden]')) back.focus({ preventScroll: true });
    else if (root.contains(document.activeElement)) document.activeElement.blur();
    onClose();
  }

  // ---- mouse / touch
  // (pointerdown focuses the card, which selects it, so the tap rule below looks at the selection from before)
  root.addEventListener('pointerdown', e => { touch = e.pointerType === 'touch'; downSel = sel; }, true);
  root.addEventListener('click', e => { if (e.target === root) close(); });
  root.querySelector('.vp-close').addEventListener('click', () => close());
  cards.forEach((c, i) => {
    c.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse' && i !== sel) select(i, { r: 'cards', focus: false }); });
    // a tap on another card first shows its types (no hover on touch); a click or second tap chooses
    c.addEventListener('click', e => {
      if (touch && i !== downSel && e.detail) { select(i, { r: 'cards', focus: false }); return; }
      choose(c.dataset.kind);
    });
  });
  root.querySelectorAll('.vp-chip').forEach(c => c.addEventListener('click', () => chooseType(c.dataset.kind, c.dataset.type)));
  // Tab / click focus moves the selection with it
  root.addEventListener('focusin', e => {
    const b = e.target.closest?.('[data-row]'); if (!b) return;
    const i = KINDS.indexOf(b.dataset.kind), t = b.dataset.type ? chipsOf(b.dataset.kind).indexOf(b) : null;
    if (i !== sel || b.dataset.row !== row || (t !== null && t !== tsel)) select(i, { r: b.dataset.row, t, focus: false });
  });

  // ---- keys (vehicles.js calls this from its capture listener)
  function keydown(e) {
    if (e.gameUI) return;
    if (e.code === 'KeyV') { if (!e.repeat) open ? close({ restore: false }) : show(); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (!open) return;
    const letter = e.key?.length === 1 ? e.key.toLowerCase() : '';     // (A/D/W/S by the printed letter too)
    e.gameUI = true; e.stopImmediatePropagation();
    const is = (code, l) => e.code === code || letter === l;
    const step = is('ArrowLeft') || is('KeyA', 'a') ? -1 : is('ArrowRight') || is('KeyD', 'd') ? 1 : 0;
    if (e.code === 'Escape') { e.preventDefault(); close(); }
    else if (/^(Digit|Numpad)[1-9]$/.test(e.code)) { const k = KINDS[+e.code.slice(-1) - 1]; if (k) { e.preventDefault(); choose(k); } }
    else if (step) {
      e.preventDefault();
      if (row === 'cards') select(sel + step);
      else { const n = VEHICLE_TYPES[kindAt(sel)].length; select(sel, { t: (tsel + step + n) % n }); }
    }
    else if (is('ArrowDown') || is('KeyS', 's')) { e.preventDefault(); if (row === 'cards') select(sel, { r: 'types', t: typeIndex(kindAt(sel)) }); }
    else if (is('ArrowUp') || is('KeyW', 'w')) { e.preventDefault(); if (row === 'types') select(sel, { r: 'cards' }); }
    else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (document.activeElement?.classList.contains('vp-close')) close();
      else if (row === 'types') chooseType(kindAt(sel), chipsOf(kindAt(sel))[tsel]?.dataset.type); else choose(kindAt(sel));
    }
    else if (e.code === 'Tab') {
      const items = [...root.querySelectorAll('button')].filter(b => b.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    }
    // Space: the focused button's own click (chooses it); anything else is kept from the game
  }

  vehicles.onSwitch(() => { if (open) refresh(); });
  vehicles.onTypeChange?.(() => { if (open) { refresh(); paintAll(); } });
  const api = { show, close, keydown, get open() { return open; }, get selected() { return { kind: kindAt(sel), row, type: row === 'types' ? VEHICLE_TYPES[kindAt(sel)][tsel].id : vehicles.getType(kindAt(sel)) }; } };
  vehicles.setPicker?.(api);
  return api;
}
