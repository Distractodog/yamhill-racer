// Small, keyboard-accessible panels. Register before game input so UI keys never drive the vehicle.
export function createSettings() {
  const panel = document.getElementById('settings-panel');
  const settingsButton = document.getElementById('settings-button');
  const helpButton = document.getElementById('help-button');
  const title = document.getElementById('settings-title');
  const tuning = document.getElementById('tuning-content');
  const help = document.getElementById('help-content');
  const closeButton = document.getElementById('settings-close');
  let current = null, ready = false, changed = () => {}, beforeOpen = () => {}, returnFocus = null;
  function close() {
    if (!current) return;
    current = null; panel.hidden = true;
    settingsButton.setAttribute('aria-expanded', 'false'); helpButton.setAttribute('aria-expanded', 'false');
    changed(); returnFocus?.focus({ preventScroll: true });
  }
  function show(view, trigger = view === 'tuning' ? settingsButton : helpButton) {
    if (!ready) return;
    if (current === view) { close(); return; }
    beforeOpen(); returnFocus = trigger; current = view;
    title.textContent = view === 'tuning' ? 'Settings' : 'How to play';
    tuning.hidden = view !== 'tuning'; help.hidden = view !== 'help'; panel.hidden = false;
    settingsButton.setAttribute('aria-expanded', String(view === 'tuning'));
    helpButton.setAttribute('aria-expanded', String(view === 'help'));
    changed(); closeButton.focus({ preventScroll: true });
  }
  settingsButton.addEventListener('click', () => show('tuning'));
  helpButton.addEventListener('click', () => show('help'));
  document.getElementById('settings-help').addEventListener('click', () => show('help'));
  closeButton.addEventListener('click', close);
  addEventListener('keydown', e => {
    if (!ready) return;
    const editing = e.target instanceof Element && e.target.matches('input, textarea, select, [contenteditable="true"]');
    if (e.code === 'KeyT' && !editing) {
      e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) show('tuning'); return;
    }
    if (!current) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    // Existing game shortcuts still work: dismiss the panel and hand the key to the game.
    if (!editing && /^(KeyV|KeyJ|KeyM|KeyP|KeyR|KeyF|KeyH|KeyC|KeyG)$/.test(e.code)) { close(); return; }
    e.gameUI = true; // Let controls receive the event; game listeners ignore it.
    if (e.code === 'Tab') {
      const items = [...panel.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(el => el.getClientRects().length && !el.disabled);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
    }
  }, true);
  return {
    get open() { return current !== null; }, close,
    ready(onChange, onOpen) { changed = onChange; beforeOpen = onOpen; ready = true; settingsButton.disabled = false; helpButton.disabled = false; },
  };
}
