import { chatText } from './chatwire.js';

export const editingInput = target => !!target?.matches?.('input, textarea, select, [contenteditable="true"]');
// Register before other capture listeners: they all honor gameUI. Native editing still works.
export function protectChatKeys(e) { if (e.target?.id === 'mp-chat-input') e.gameUI = true; }

export function createChat({ mp, clearKeys, canOpen = () => true, doc = document, events = window,
  now = () => performance.now(), timers = globalThis }) {
  const root = doc.createElement('section'); root.id = 'mp-chat'; root.hidden = true;
  const list = doc.createElement('div'); list.id = 'mp-chat-lines'; list.setAttribute('role', 'log');
  const input = doc.createElement('input'); input.id = 'mp-chat-input'; input.maxLength = 200;
  input.placeholder = 'Chat';
  input.setAttribute('aria-label', input.placeholder); input.autocomplete = 'off'; input.hidden = true;
  const status = doc.createElement('div'); status.setAttribute('role', 'status');
  root.append(list, input, status); doc.body.append(root);
  const rows = []; let open = false, lastSent = -Infinity, timer, noticeUntil = 0;
  function place() {
    const hud = doc.getElementById?.('hud'), health = doc.getElementById?.('combat-health');
    if (!hud?.getBoundingClientRect) return;
    const top = Math.min(hud.getBoundingClientRect().top, health && !health.hidden ? health.getBoundingClientRect().top : Infinity);
    root.style.bottom = `${Math.max(0, events.innerHeight - top + 12)}px`;
  }
  // HUD height changes with vehicle/status text; measure only on those changes and chat events.
  const hud = doc.getElementById?.('hud');
  if (hud && globalThis.ResizeObserver) new ResizeObserver(place).observe(hud);
  events.addEventListener('resize', place);
  function refresh() {
    timers.clearTimeout(timer);
    root.hidden = !mp.inGame;
    place();
    let next = Infinity;
    for (const row of rows) {
      const remaining = row.at + 12000 - now();
      row.el.style.opacity = open || remaining > 0 ? '1' : '0';
      if (!open && remaining > 0) next = Math.min(next, remaining);
    }
    if (noticeUntil <= now()) status.textContent = '';
    else next = Math.min(next, noticeUntil - now());
    if (Number.isFinite(next)) timer = timers.setTimeout(refresh, next);
  }
  function close() {
    open = false; input.hidden = true; input.value = ''; input.blur(); clearKeys(); refresh();
  }
  function keydown(e) {
    if (open && (!mp.inGame || !canOpen())) close();
    if (open) {
      e.gameUI = true;
      // Keep native text editing, but stop every game shortcut listener.
      e.stopImmediatePropagation();
      if (e.isComposing) return;
      if (e.code === 'Escape') { e.preventDefault(); close(); }
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
        e.preventDefault(); if (e.repeat) return;
        const text = chatText(input.value);
        if (!text) return;
        if (now() - lastSent < 1000) { status.textContent = 'Slow down'; noticeUntil = now() + 1500; refresh(); return; }
        lastSent = now(); mp.send({ t: 'chat', text }); close();
      }
      return;
    }
    if (e.gameUI || e.repeat || e.isComposing || !mp.inGame || !canOpen() || editingInput(e.target) ||
        !['Enter', 'NumpadEnter'].includes(e.code)) return;
    e.preventDefault(); e.stopImmediatePropagation(); e.gameUI = true;
    clearKeys(); open = true; input.hidden = false; refresh(); input.focus({ preventScroll: true });
    list.scrollTop = list.scrollHeight;
  }
  events.addEventListener('keydown', keydown, true);
  input.addEventListener('blur', () => { if (open) close(); });
  mp.on('chat', msg => {
    const text = chatText(msg.text);
    if (!mp.inGame || !text || typeof msg.name !== 'string') return;
    const el = doc.createElement('div'), name = doc.createElement('span'), body = doc.createElement('span');
    name.className = 'mp-chat-name'; name.textContent = `${msg.name}: `; body.textContent = text;
    el.append(name, body); list.append(el); rows.push({ el, at: now() });
    if (rows.length > 8) rows.shift().el.remove();
    refresh();
    list.scrollTop = list.scrollHeight;
  });
  function reset() { close(); for (const row of rows) row.el.remove(); rows.length = 0; lastSent = -Infinity; noticeUntil = 0; refresh(); }
  mp.on('connected', reset); mp.on('disconnected', reset);
  return { root, input, close, get open() { return open; } };
}
