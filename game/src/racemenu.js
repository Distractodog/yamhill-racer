// The race menu (J): a centred panel in the V picker's style with one card per race — a small picture of the route
// drawn on the baked map (minimap.jpg), distance, vehicle, ramps (rings for aircraft), your best time and medal —
// filter tabs Car / Bike / Aircraft / All, the selected race's medal targets, Start, and in a multiplayer game with
// other players "Invite players" (mp/races.js's invite step). challenges.js owns it and passes keys in while it's open.
// Keys: ←/→/↑/↓ choose · 1–4 filter · Enter start · Esc (or J, in challenges.js) close. Mouse: click a card to select
// it, click it again (or double-click, or Start) to race.
import { fmtDist } from './units.js';
import { MEDALS, MEDAL_ICON, MEDAL_NAME } from './medals.js';

export const FILTERS = [{ id: 'car', label: 'Car' }, { id: 'bike', label: 'Bike' }, { id: 'jet', label: 'Aircraft' }, { id: 'all', label: 'All' }];
const VEHICLE = { car: { icon: '🏎️', label: 'Car' }, bike: { icon: '🏍️', label: 'Bike' }, jet: { icon: '✈️', label: 'Aircraft' } };
const PREVIEW_W = 352, PREVIEW_H = 198;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export const raceKind = c => (VEHICLE[c.vehicle] ? c.vehicle : 'car');
// what a card says about a race: distance · vehicle · ramps (or rings in the air)
export function raceFacts(c) {
  const kind = raceKind(c);
  const n = kind === 'jet' ? c.gates.length - 1 : (c.ramps || []).length;
  const extra = kind === 'jet' ? `${n} ring${n === 1 ? '' : 's'}` : n ? `${n} ramp${n === 1 ? '' : 's'}` : 'no ramps';
  return { dist: fmtDist(c.length), vehicle: VEHICLE[kind].label, icon: VEHICLE[kind].icon, extra };
}
// list indices shown under a filter, in menu order
export const filterRaces = (list, filter) => list.map((c, i) => i).filter(i => filter === 'all' || raceKind(list[i]) === filter);

// ---------------------------------------------------------------- route pictures
// The map picture as minimap.js preloaded it (shared, already decoded) and mapimage.js's level-aware drawing.
// No picture (Node tests, a failed load): the cards keep their plain background and the route alone.
let picture = null;
function mapPicture(base) {
  if (!picture) picture = (async () => {
    if (typeof Image === 'undefined') return null;
    const [mm, mi] = await Promise.all([import('./minimap.js'), import('./mapimage.js')]);
    const { meta, img } = await mm.preloadMinimap(base);
    return { meta, img, draw: mi.drawMapImage, revision: () => mi.mapImageRevision(img) };
  })().catch(() => null);
  return picture;
}

// one card's picture: the route fitted in the canvas (at least ~800 m across) over the map, start and finish marked
export function drawRoutePreview(canvas, c, pic) {
  const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
  const pts = c.route?.length > 1 ? c.route : c.gates.map(g => [g.x, g.z]);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const mpc = Math.max((x1 - x0) / (W * 0.82), (z1 - z0) / (H * 0.76), 800 / W);          // metres per canvas px
  const at = (x, z) => [W / 2 + (x - cx) / mpc, H / 2 + (z - cz) / mpc];
  ctx.fillStyle = '#21402f'; ctx.fillRect(0, 0, W, H);
  if (pic) {
    const [ex0, ez0] = pic.meta.extent;
    try { pic.draw(ctx, pic.img, W / 2 - (cx - ex0) / mpc, H / 2 - (cz - ez0) / mpc, pic.meta.mpp / mpc); } catch {}
    ctx.fillStyle = '#08120e40'; ctx.fillRect(0, 0, W, H);                                 // a little darker: the line stands out
  }
  ctx.lineJoin = ctx.lineCap = 'round';
  ctx.beginPath(); pts.forEach(([x, z], i) => { const [u, v] = at(x, z); i ? ctx.lineTo(u, v) : ctx.moveTo(u, v); });
  ctx.strokeStyle = '#0b1712d0'; ctx.lineWidth = 7; ctx.stroke();
  ctx.strokeStyle = raceKind(c) === 'jet' ? '#7fe3ff' : '#ffd23f'; ctx.lineWidth = 3.2; ctx.stroke();
  const dot = (x, z, r, fill, ring = '#0b1712') => {
    const [u, v] = at(x, z); ctx.beginPath(); ctx.arc(u, v, r, 0, Math.PI * 2);
    ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = ring; ctx.stroke();
  };
  for (const r of c.ramps || []) dot(r.x, r.z, 3.2, '#ff9a2e');
  if (raceKind(c) === 'jet') for (const g of c.gates.slice(1, -1)) dot(g.x, g.z, 3.2, '#ffffff00', '#ffffffcc');
  const [ex, ez] = pts[pts.length - 1], [sx, sz] = pts[0];
  dot(ex, ez, 6, '#ffffff'); { const [u, v] = at(ex, ez); ctx.fillStyle = '#111'; ctx.fillRect(u - 3, v - 3, 3, 3); ctx.fillRect(u, v, 3, 3); }
  dot(sx, sz, 6, '#3cdc68', '#ffffff');
}

// list: challenges.json; best(): { raceId: { time, splits } }; medals: medals.js createMedals(); rewards: rewards.js;
// fmtTime: challenges.js's; onStart(i) / onInvite(i): race i; canInvite(): show "Invite players"; racing(): a run is on;
// onClose(): the menu closed by itself (Esc, ✕, a click outside, Start)
export function createRaceMenu({ list, best, medals, rewards = null, fmtTime, base = './assets/', onStart = () => {}, onInvite = () => false,
  canInvite = () => false, racing = () => false, onClose = () => {} }) {
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./racemenu.css', import.meta.url).href; document.head.append(link);
  const root = document.createElement('section');
  root.id = 'ch-menu'; root.className = 'rm'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'rm-title');
  root.innerHTML = `<div class="rm-panel">
    <header class="rm-head"><h2 id="rm-title">Races</h2><span class="rm-tally" aria-label="Your medals"></span><button type="button" class="rm-close" aria-label="Close races">✕</button></header>
    <div class="reward-collection"></div>
    <div class="rm-tabs" role="tablist" aria-label="Vehicle">${FILTERS.map((f, k) => `<button type="button" class="rm-tab" role="tab" data-f="${f.id}"><span class="rm-key" aria-hidden="true">${k + 1}</span>${f.label} <small>${filterRaces(list, f.id).length}</small></button>`).join('')}</div>
    <div class="rm-cards" role="listbox" aria-labelledby="rm-title">${list.map((c, i) => `
      <button type="button" class="ch-item rm-card" role="option" data-i="${i}" data-kind="${raceKind(c)}" aria-describedby="rm-detail">
        <span class="rm-pic"><canvas width="${PREVIEW_W}" height="${PREVIEW_H}" aria-hidden="true"></canvas><span class="rm-badge" aria-hidden="true"></span><span class="rm-won" aria-hidden="true"></span></span>
        <span class="rm-name">${esc(c.name)}</span><span class="rm-facts"></span><span class="rm-best"></span>
      </button>`).join('')}<p class="rm-empty" hidden>No races here yet.</p></div>
    <div class="rm-foot"><div class="rm-detail" id="rm-detail" aria-live="polite"></div>
      <div class="rm-actions"><button type="button" class="rm-start">Start</button><button type="button" class="rm-invite mp-invite-btn" hidden>Invite players</button></div></div>
    <p class="rm-hint"></p>
  </div>`;
  document.body.append(root);
  const cards = [...root.querySelectorAll('.rm-card')], tabs = [...root.querySelectorAll('.rm-tab')];
  const detail = root.querySelector('.rm-detail'), inviteBtn = root.querySelector('.rm-invite');
  let open = false, sel = 0, filter = 'all', drawnRev = -1;

  const visible = () => filterRaces(list, filter);
  const timeOf = id => best()?.[id]?.time;
  function medalChips(c, have) {
    if (!c.medals) return '';
    return `<div class="rm-targets">${MEDALS.map(m => `<span class="rm-target${have && MEDALS.indexOf(m) >= MEDALS.indexOf(have) ? ' got' : ''}" title="${MEDAL_NAME[m]}: ${fmtTime(c.medals[m])} or faster">${MEDAL_ICON[m]} ${fmtTime(c.medals[m])}</span>`).join('')}</div>`;
  }

  // everything that depends on the selection, the filter, best times, medals, units or multiplayer
  function refresh() {
    const shown = new Set(visible());
    if (!shown.has(sel) && shown.size) sel = [...shown][0];
    tabs.forEach(t => t.setAttribute('aria-selected', String(t.dataset.f === filter)));
    cards.forEach((card, i) => {
      const c = list[i], f = raceFacts(c), won = medals.get(c.id), t = timeOf(c.id);
      card.hidden = !shown.has(i);
      card.classList.toggle('sel', i === sel); card.setAttribute('aria-selected', String(i === sel));
      card.querySelector('.rm-badge').textContent = `${f.icon} ${f.vehicle}`;
      card.querySelector('.rm-facts').textContent = `${f.dist} · ${f.extra}`;
      card.querySelector('.rm-won').textContent = won ? MEDAL_ICON[won] : '';
      card.querySelector('.rm-best').innerHTML = t != null ? `Best <b>${fmtTime(t)}</b>${won ? ` · ${MEDAL_NAME[won]}` : ''}` : 'No time yet';
      card.setAttribute('aria-label', `${c.name}. ${f.vehicle}, ${f.dist}, ${f.extra}. ${t != null ? `Best ${fmtTime(t)}` : 'No time yet'}${won ? `, ${MEDAL_NAME[won]} medal` : ''}.`);
    });
    root.querySelector('.rm-empty').hidden = shown.size > 0;
    const c = list[sel], won = medals.get(c?.id), t = c && timeOf(c.id);
    detail.innerHTML = c ? `<strong>${esc(c.name)}</strong> ${esc(c.desc || '')}${medalChips(c, won)}
      ${c.pace === 'top' ? '<div class="rm-you">Medal times are set for the race car flat out.</div>' : ''}
      <div class="rm-you">${t != null ? `Your best <b>${fmtTime(t)}</b>${won ? ` · ${MEDAL_ICON[won]} ${MEDAL_NAME[won]}` : ' · no medal yet'}` : 'No time yet — set one!'}</div>` : '';
    const tally = medals.tally();
    root.querySelector('.rm-tally').innerHTML = MEDALS.map(m => `<span title="${MEDAL_NAME[m]} medals">${MEDAL_ICON[m]} ${tally[m]}</span>`).join('');
    if (rewards) root.querySelector('.reward-collection').innerHTML = rewards.list().map(r => `<span class="reward-chip${r.unlocked ? ' unlocked' : ''}" title="${esc(r.description)}">${r.unlocked ? '✓' : r.completed + '/' + r.total} ${esc(r.name)}</span>`).join('');
    inviteBtn.hidden = !canInvite();
    root.querySelector('.rm-start').disabled = !c;
    root.querySelector('.rm-hint').textContent = '←/→/↑/↓ choose · 1–4 filter · Enter or click again to start · J or Esc to close' +
      (racing() ? ' · Backspace restarts your run' : '');
  }

  async function paintPreviews() {
    const pic = await mapPicture(base);
    if (!open) return;
    const rev = pic ? pic.revision() : 0;
    if (rev === drawnRev) return;
    drawnRev = rev;
    cards.forEach((card, i) => { try { drawRoutePreview(card.querySelector('canvas'), list[i], pic); } catch {} });
  }

  const focusSel = () => cards[sel]?.focus?.({ preventScroll: true });
  function select(i, { focus = true } = {}) {
    if (i == null || !list[i]) return;
    sel = i; refresh();
    cards[sel]?.scrollIntoView?.({ block: 'nearest' });
    if (focus) focusSel();
  }
  function setFilter(f) { filter = f; refresh(); cards[sel]?.scrollIntoView?.({ block: 'nearest' }); focusSel(); }
  // cards per row as laid out (for ↑/↓)
  function columns() {
    const shown = visible().map(i => cards[i]), top = shown[0]?.offsetTop;
    const n = shown.filter(c => c.offsetTop === top).length;
    return n > 0 ? n : 3;
  }
  function move(step) {
    const v = visible(); if (!v.length) return;
    const k = v.indexOf(sel), n = v.length;
    select(v[Math.abs(step) === 1 ? (k + step + n) % n : Math.min(n - 1, Math.max(0, k + step))]);
  }

  // opts.from: the button that opened it (☰ Menu → Races); dismissing the menu (Esc, ✕, a click outside) gives focus
  // back to the ☰ Menu button, as the V picker does. Opened with J or a start ring, focus is left on nothing.
  let returnFocus = null;
  function show(i = sel, opts = {}) {
    if (opts.filter) filter = opts.filter;
    if (i != null && list[i]) sel = i;
    if (!filterRaces(list, filter).includes(sel)) filter = 'all';
    if (!open) returnFocus = opts.from ? (opts.from.closest?.('#menu-panel') ? document.getElementById('menu-button') : opts.from) : null;
    open = true; root.hidden = false;
    refresh(); focusSel(); cards[sel]?.scrollIntoView?.({ block: 'nearest' });
    paintPreviews();
    setTimeout(() => { if (open) paintPreviews(); }, 900);          // patches of the map picture that arrived meanwhile
  }
  // restore: the player dismissed it. Otherwise (a race starting, another panel opening) focus just leaves the menu, so
  // the next Space is the handbrake, not a button press.
  function close({ restore = false } = {}) {
    if (!open) return;
    open = false; root.hidden = true;
    const back = restore ? returnFocus : null; returnFocus = null;
    if (back?.isConnected && !back.closest?.('[hidden]')) back.focus({ preventScroll: true });
    else if (root.contains?.(document.activeElement)) document.activeElement.blur();
    onClose();
  }
  const dismiss = () => close({ restore: true });
  const startSel = () => { if (list[sel]) onStart(sel); };

  // ---- mouse
  root.addEventListener('click', e => { if (e.target === root) dismiss(); });
  root.querySelector('.rm-close').addEventListener('click', dismiss);
  root.querySelector('.rm-start').addEventListener('click', startSel);
  inviteBtn.addEventListener('click', () => { if (!onInvite(sel)) refresh(); });       // (nobody to invite any more: hide it)
  tabs.forEach(t => t.addEventListener('click', () => setFilter(t.dataset.f)));
  // (pressing a card focuses it, which selects it, so a click looks at the selection from before the press)
  let downSel = 0;
  root.addEventListener('pointerdown', () => { downSel = sel; }, true);
  cards.forEach((card, i) => {
    card.addEventListener('click', e => {
      const was = e.detail === 0 ? sel : downSel;           // detail 0: Space / Enter on the focused card
      if (i === was && e.detail <= 1) startSel(); else if (i !== sel) select(i, { focus: false });
    });
    card.addEventListener('dblclick', () => { if (i === sel && !root.hidden) startSel(); });
  });
  // Tab focus moves the selection with it
  root.addEventListener('focusin', e => { const card = e.target.closest?.('.rm-card'); if (card && +card.dataset.i !== sel) select(+card.dataset.i, { focus: false }); });

  // ---- keys (challenges.js calls this from its capture listener while the menu is open); true = handled here
  function keydown(e) {
    const code = e.code, focused = document.activeElement?.closest?.('#ch-menu button');
    // Space on any focused button, Enter on one that isn't a card: its own (native) click; gameUI keeps main.js from
    // cancelling it as a driving key
    if (focused && (code === 'Space' || (/Enter$/.test(code) && !focused.classList.contains('rm-card')))) { e.gameUI = true; return false; }
    let handled = true;
    if (code === 'ArrowLeft') move(-1);
    else if (code === 'ArrowRight') move(1);
    else if (code === 'ArrowUp') move(-columns());
    else if (code === 'ArrowDown') move(columns());
    else if (/^(Digit|Numpad)[1-4]$/.test(code)) setFilter(FILTERS[+code.slice(-1) - 1].id);
    else if (code === 'Enter' || code === 'NumpadEnter') startSel();
    else if (code === 'Escape') dismiss();
    else handled = false;
    if (handled) { e.preventDefault(); e.gameUI = true; e.stopImmediatePropagation(); }
    return handled;
  }

  // the race after `i` in the menu's current filter (wraps), for the finish screen's "Next race"
  function nextAfter(i) {
    const v = filterRaces(list, filter).includes(i) ? filterRaces(list, filter) : list.map((c, k) => k);
    return v[(v.indexOf(i) + 1) % v.length];
  }

  return { root, show, close, keydown, refresh, select, nextAfter, setFilter,
    get open() { return open; }, get selected() { return sel; }, get filter() { return filter; } };
}
