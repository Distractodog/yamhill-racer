import { getSwitchPlacement, setSwitchPlacement } from './switchplacement.js';
import { createGameMenu } from './gamemenu.js';
import { getUnits, setUnits, onUnits } from './units.js';

// Small, keyboard-accessible panels. Register before game input so UI keys never drive the vehicle.
export function createSettings() {
  const panel = document.getElementById('settings-panel');
  const settingsButton = document.getElementById('settings-button');
  const helpButton = document.getElementById('help-button');
  const title = document.getElementById('settings-title');
  const tuning = document.getElementById('tuning-content');
  const help = document.getElementById('help-content');
  const closeButton = document.getElementById('settings-close');
  const unitsSelect = document.getElementById('units-select');
  let current = null, ready = false, changed = () => {}, beforeOpen = () => {}, returnFocus = null;
  let external = null, refreshAtmosphere = () => {}, closeTuning = () => {};
  if (unitsSelect) {
    unitsSelect.value = getUnits();
    unitsSelect.addEventListener('change', () => setUnits(unitsSelect.value));
    onUnits(units => { unitsSelect.value = units; });
  }
  const placement = document.getElementById('switch-placement');
  if (placement) {
    placement.value = getSwitchPlacement();
    placement.addEventListener('change', () => setSwitchPlacement(placement.value));
  }
  const menu = createGameMenu({
    onOpen: () => { close(); closeExternal(); closeWelcome(); beforeOpen(); },
    onChange: () => changed(),
  });
  function closeExternal() { if (external) { const previous = external; external = null; previous.close(); changed(); } }
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
    settingsButton.setAttribute('aria-expanded', 'false'); helpButton.setAttribute('aria-expanded', 'false');
    changed(); returnFocus?.focus({ preventScroll: true });
  }
  function show(view, trigger = view === 'tuning' ? settingsButton : helpButton) {
    if (!ready) return;
    closeExternal();
    if (current === view) { close(); return; }
    if (view === 'tuning') closeTuning();
    menu.close(); beforeOpen(); returnFocus = trigger?.closest('#menu-panel') ? document.getElementById('menu-button') : trigger; current = view;
    title.textContent = view === 'tuning' ? 'Settings' : 'How to play';
    tuning.hidden = view !== 'tuning'; help.hidden = view !== 'help'; panel.hidden = false;
    settingsButton.setAttribute('aria-expanded', String(view === 'tuning'));
    helpButton.setAttribute('aria-expanded', String(view === 'help'));
    refreshAtmosphere();
    changed(); closeButton.focus({ preventScroll: true });
  }
  settingsButton.addEventListener('click', () => show('tuning'));
  helpButton.addEventListener('click', () => show('help'));
  document.getElementById('settings-help').addEventListener('click', () => show('help'));
  closeButton.addEventListener('click', close);
  addEventListener('keydown', e => {
    if (e.gameUI || !ready) return;
    if (external) {
      e.gameUI = true;
      if (e.code === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeExternal(); return; }
      if (e.code === 'Tab') {
        const items = [...external.panel.querySelectorAll('button, input, select, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || !external.panel.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !external.panel.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
      }
      return;
    }
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
    get open() { return current !== null || welcomeOpen || external !== null || menu.open; }, close() { menu.close(); close(); closeExternal(); }, showWelcome, closeWelcome,
    openExternal(panel, onClose) { menu.close(); closeExternal(); closeWelcome(); close(); beforeOpen(); external = { panel, close: onClose }; changed(); },
    get welcomeOpen() { return welcomeOpen; },
    bindBuilder(builder) {
      const section = document.createElement('section');
      section.innerHTML = '<h3>Builder</h3><label><input type="checkbox" id="builder-enabled"> Builder mode</label><p>Place your own ramps, roads and scenery. Press B to build or drive.</p><button type="button">Open builder</button><p class="builder-host-note" hidden>The host controls the shared layout.</p>';
      tuning.append(section);
      const toggle = section.querySelector('input'), open = section.querySelector('button'), note = section.querySelector('p.builder-host-note');
      toggle.addEventListener('change', () => builder.setEnabled(toggle.checked));
      open.addEventListener('click', () => { close(); builder.show(); });
      builder.subscribe(() => { toggle.checked = builder.enabled; toggle.disabled = builder.readOnly; open.disabled = !builder.enabled || builder.readOnly; note.hidden = !builder.readOnly; });
    },
    bindTuning(gui) {
      closeTuning = () => gui.foldersRecursive().forEach(folder => folder.close());
      closeTuning();
    },
    // Settings → Time of day & weather (atmosphere.js): cycle on/off, jump the clock, weather, or one fixed look
    bindAtmosphere(atmosphere, presets = atmosphere.presets) {
      const cycle = document.getElementById('atmo-cycle'), options = document.getElementById('atmo-cycle-options');
      const fixed = document.getElementById('atmo-fixed'), now = document.getElementById('atmo-now');
      const host = document.getElementById('atmosphere-presets');
      const option = (parent, data, value, text) => {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'atmo-option'; button.dataset[data] = value; button.textContent = text;
        parent.append(button); return button;
      };
      const times = atmosphere.phases.map(p => option(document.getElementById('atmo-time'), 'time', p.id, p.name));
      const weathers = [['random', 'Random'], ['clear', 'Always clear'], ['rain', 'Always rain']].map(([id, name]) => option(document.getElementById('atmo-weather'), 'weather', id, name));
      host.replaceChildren();
      const looks = [];
      for (const preset of presets) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'atmosphere-option'; button.dataset.preset = preset.id;
        const swatch = document.createElement('span'); swatch.className = 'atmosphere-swatch'; swatch.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span'); label.textContent = preset.name || preset.label || preset.id;
        button.append(swatch, label); button.addEventListener('click', () => atmosphere.setPreset(preset.id));
        looks.push(button); host.append(button);
      }
      cycle.addEventListener('change', () => atmosphere.set({ cycle: cycle.checked }));
      times.forEach(b => b.addEventListener('click', () => atmosphere.jump(b.dataset.time)));
      weathers.forEach(b => b.addEventListener('click', () => atmosphere.set({ weather: b.dataset.weather })));
      const phaseName = id => atmosphere.phases.find(p => p.id === id)?.name || '';
      refreshAtmosphere = () => {
        const s = atmosphere.settings;
        cycle.checked = s.cycle; options.hidden = !s.cycle; fixed.hidden = s.cycle;
        now.textContent = s.cycle ? `· ${phaseName(atmosphere.phase)}${atmosphere.rain > .5 ? ', raining' : ''}` : '';
        times.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.time === atmosphere.phase)));
        weathers.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.weather === s.weather)));
        looks.forEach(b => b.setAttribute('aria-pressed', String(!s.cycle && b.dataset.preset === s.look)));
      };
      atmosphere.onChange?.(refreshAtmosphere);
      // the phase and rain move on by themselves: keep the open panel current
      setInterval(() => { if (current === 'tuning') refreshAtmosphere(); }, 1000);
      refreshAtmosphere();
    },
    refreshAtmosphere: () => refreshAtmosphere(),
    // Settings → Sound: master / engines / effects sliders (audio.js setVolumes saves them); moving one starts the sound
    bindSound(audio) {
      for (const input of document.querySelectorAll('#sound-content input[data-channel]')) {
        const channel = input.dataset.channel, out = input.nextElementSibling;
        const show = () => { out.textContent = `${input.value}%`; };
        input.value = String(Math.round(audio.volumes[channel] * 100)); show();
        input.addEventListener('input', () => { show(); audio.start(); audio.setVolumes({ [channel]: input.value / 100 }); });
      }
    },
    ready(onChange, onOpen) { changed = onChange; beforeOpen = onOpen; ready = true; menu.ready(); settingsButton.disabled = false; helpButton.disabled = false; showWelcome(); },
  };
}
