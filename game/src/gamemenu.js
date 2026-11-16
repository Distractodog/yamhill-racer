// Disclosure navigation: retain native buttons/links and their existing handlers.
export function createGameMenu({ onOpen = () => {}, onChange = () => {} } = {}) {
  const bar = document.getElementById('menu-bar');
  const button = document.getElementById('menu-button');
  const panel = document.getElementById('menu-panel');
  function close(focus = false) {
    if (panel.hidden) return;
    panel.hidden = true; button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus({ preventScroll: true });
    onChange();
  }
  button.addEventListener('click', () => {
    if (!panel.hidden) { close(true); return; }
    onOpen(); panel.hidden = false; button.setAttribute('aria-expanded', 'true'); onChange();
    panel.querySelector('button:not(:disabled), a[href]')?.focus({ preventScroll: true });
  });
  // Capture before the item's handler so its dialog receives focus after we close.
  panel.addEventListener('click', e => {
    if (e.target.closest('button:not(:disabled), a[href]')) close(true);
  }, true);
  document.addEventListener('pointerdown', e => { if (!bar.contains(e.target)) close(); }, true);
  document.addEventListener('focusin', e => { if (!bar.contains(e.target)) close(); });
  addEventListener('keydown', e => {
    if (panel.hidden) {
      // Keep native keyboard activation; Space must not become the handbrake.
      if (e.target === button && /^(Enter|NumpadEnter|Space)$/.test(e.code)) e.gameUI = true;
      return;
    }
    // Dismiss for game actions and let the existing settings/game handlers use the key.
    if (/^(Key[VJMTPRFHCGLU]|F8|Backspace)$/.test(e.code)) { close(true); return; }
    e.gameUI = true;
    if (e.code === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation(); close(true); return;
    }
    if (e.code === 'Tab') {
      const items = [button, ...panel.querySelectorAll('button:not(:disabled), a[href]')].filter(el => el.getClientRects().length);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, true);
  return { get open() { return !panel.hidden; }, close, ready() { button.disabled = false; } };
}
