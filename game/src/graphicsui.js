// Settings → Graphics: Auto / Low / Medium / High buttons, a status line and "Measure again" (graphicsapply.js).
import { LEVEL_NAMES, MODES } from './graphics.js';

const ABOUT = {
  low: 'Low: shorter view, no shadows, fewer far trees and props, still water. For slow computers.',
  medium: 'Medium: a little shorter view and smaller shadows.',
  high: 'High: full view distance, shadows and detail.',
};

export function bindGraphicsSettings(graphics, doc = globalThis.document) {
  const host = doc?.getElementById('graphics-modes'), status = doc?.getElementById('graphics-status'), again = doc?.getElementById('graphics-measure');
  if (!host) return null;
  host.replaceChildren();
  const buttons = MODES.map(mode => {
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'atmo-option'; button.dataset.graphics = mode; button.textContent = LEVEL_NAMES[mode];
    button.addEventListener('click', () => graphics.set(mode));
    host.append(button); return button;
  });
  again?.addEventListener('click', () => graphics.remeasure());
  const refresh = () => {
    buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.graphics === graphics.mode)));
    const name = LEVEL_NAMES[graphics.level];
    let text = ABOUT[graphics.level];
    if (graphics.mode === 'auto') text = graphics.measuring
      ? `Auto: ${name} for now. Measuring while you drive (${Math.min(5, graphics.measured).toFixed(0)} of 5 s)…`
      : `Auto picked ${name}${graphics.auto?.fps ? ` (${graphics.auto.fps} fps measured)` : ''}. ${ABOUT[graphics.level]}`;
    if (status) status.textContent = text;
    if (again) again.hidden = graphics.mode === 'auto' && graphics.measuring;
  };
  graphics.onChange(refresh);
  // the measurement moves on by itself: keep the line current while it runs
  setInterval(() => { if (graphics.measuring) refresh(); }, 1000).unref?.();
  refresh();
  return { refresh };
}
