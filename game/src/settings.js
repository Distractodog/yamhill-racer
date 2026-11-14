// Small, keyboard-accessible panels. Register before game input so UI keys never drive the vehicle.
export function createSettings() {
  const panel = document.getElementById('settings-panel');
  const settingsButton = document.getElementById('settings-button');
  const helpButton = document.getElementById('help-button');
  const atmosphereButton = document.getElementById('atmosphere-button');
  const atmosphereContent = document.getElementById('atmosphere-content');
  const title = document.getElementById('settings-title');
  const tuning = document.getElementById('tuning-content');
  const help = document.getElementById('help-content');
  const closeButton = document.getElementById('settings-close');
  let current = null, ready = false, changed = () => {}, beforeOpen = () => {}, returnFocus = null;
  // welcome card: shown once the map has loaded, unless "Don't show this again" was ticked (saved per browser)
  const WELCOME_KEY = 'yr-welcome-hidden-1';
  const welcome = document.getElementById('welcome'), welcomeHide = document.getElementById('welcome-hide');
  let welcomeOpen = false;
  function closeWelcome() {
    if (!welcomeOpen) return;
    welcomeOpen = false; welcome.hidden = true;
    try { if (welcomeHide.checked) localStorage.setItem(WELCOME_KEY, '1'); else localStorage.removeItem(WELCOME_KEY); } catch {}
    changed();
  }
  function showWelcome() {
    let hidden = false; try { hidden = localStorage.getItem(WELCOME_KEY) === '1'; } catch {}
    if (hidden || !welcome) return;
    welcomeOpen = true; welcome.hidden = false; welcomeHide.checked = false;
    document.getElementById('welcome-start').focus({ preventScroll: true });
  }
  document.getElementById('welcome-start')?.addEventListener('click', closeWelcome);
  document.getElementById('welcome-help')?.addEventListener('click', () => { closeWelcome(); show('help'); });
  function close() {
    if (!current) return;
    current = null; panel.hidden = true;
    settingsButton.setAttribute('aria-expanded', 'false'); helpButton.setAttribute('aria-expanded', 'false'); atmosphereButton.setAttribute('aria-expanded', 'false');
    changed(); returnFocus?.focus({ preventScroll: true });
  }
  function show(view, trigger = view === 'tuning' ? settingsButton : view === 'atmosphere' ? atmosphereButton : helpButton) {
    if (!ready) return;
    if (current === view) { close(); return; }
    beforeOpen(); returnFocus = trigger; current = view;
    title.textContent = view === 'tuning' ? 'Vehicle tuning' : view === 'atmosphere' ? 'Chase the light' : 'How to play';
    tuning.hidden = view !== 'tuning'; help.hidden = view !== 'help'; atmosphereContent.hidden = view !== 'atmosphere'; panel.hidden = false;
    settingsButton.setAttribute('aria-expanded', String(view === 'tuning'));
    helpButton.setAttribute('aria-expanded', String(view === 'help'));
    atmosphereButton.setAttribute('aria-expanded', String(view === 'atmosphere'));
    changed(); closeButton.focus({ preventScroll: true });
  }
  settingsButton.addEventListener('click', () => show('tuning'));
  helpButton.addEventListener('click', () => show('help'));
  atmosphereButton.addEventListener('click', () => show('atmosphere'));
  document.getElementById('settings-help').addEventListener('click', () => show('help'));
  closeButton.addEventListener('click', close);
  addEventListener('keydown', e => {
    if (e.gameUI || !ready) return;
    if (welcomeOpen) {
      // Enter / Esc / Space close the card (and do nothing else); game shortcuts close it and still work;
      // every other key is kept from the game so nothing drives while it's up
      if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Escape' || e.code === 'Space') {
        if (e.code === 'Space' && document.activeElement === welcomeHide) { e.gameUI = true; return; }   // toggles the box
        e.preventDefault(); e.stopImmediatePropagation(); closeWelcome(); return;
      }
      if (/^(KeyV|KeyJ|KeyM|KeyT)$/.test(e.code)) { closeWelcome(); if (e.code !== 'KeyT') return; }
      else { e.gameUI = true; if (e.code !== 'Tab') e.stopImmediatePropagation(); return; }
    }
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
    get open() { return current !== null || welcomeOpen; }, close, showWelcome, closeWelcome,
    get welcomeOpen() { return welcomeOpen; },
    bindAtmosphere(atmosphere, presets = atmosphere.presets) {
      const host = document.getElementById('atmosphere-presets');
      host.replaceChildren();
      const buttons = [];
      const refresh = () => buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.preset === atmosphere.preset)));
      for (const preset of presets) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'atmosphere-option'; button.dataset.preset = preset.id;
        const swatch = document.createElement('span'); swatch.className = 'atmosphere-swatch'; swatch.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span'); label.textContent = preset.name || preset.label || preset.id;
        button.append(swatch, label); button.addEventListener('click', () => { atmosphere.setPreset(preset.id); refresh(); });
        buttons.push(button); host.append(button);
      }
      refresh(); atmosphereButton.disabled = false;
    },
    ready(onChange, onOpen) { changed = onChange; beforeOpen = onOpen; ready = true; settingsButton.disabled = false; helpButton.disabled = false; showWelcome(); },
  };
}
