export function createCombatUI(parent = document.body) {
  const style = document.createElement('style');
  style.textContent = `#combat-health{position:fixed;bottom:92px;left:16px;width:154px;z-index:5;color:#fff;font:12px system-ui;text-shadow:0 1px 3px #000;pointer-events:none}
#hud>#combat-health{position:absolute;bottom:calc(100% + 10px);left:0}
#combat-health meter{display:block;width:154px;height:12px;margin-top:4px;accent-color:#75dc88}#combat-feed{position:fixed;right:14px;top:234px;max-width:320px;padding:7px 10px;border-radius:7px;background:#14221cce;color:#fff;font:12px system-ui;z-index:5;pointer-events:none;transition:opacity 1s}
#combat-flash{position:fixed;inset:0;box-shadow:inset 0 0 90px 22px #f2292955;pointer-events:none;z-index:6}
#combat-health[hidden],#combat-feed[hidden],#combat-flash[hidden]{display:none}@media(max-width:600px){#combat-feed{top:164px;max-width:230px}}`;
  const health = document.createElement('div'); health.id = 'combat-health'; health.hidden = true;
  const label = document.createElement('span'), bar = document.createElement('meter'); bar.min = 0; bar.max = 100; bar.value = 100;
  bar.setAttribute('aria-label', 'Vehicle health'); health.append(label, bar);
  const feed = document.createElement('div'); feed.id = 'combat-feed'; feed.hidden = true; feed.setAttribute('role', 'status');
  const flash = document.createElement('div'); flash.id = 'combat-flash'; flash.hidden = true;
  document.head.append(style); (document.getElementById?.('hud') || parent).append(health); parent.append(feed, flash);
  let feedTime = 0, flashTime = 0, lastHealth = -1, lastLabel = '';
  return {
    feed(text) { feed.textContent = text; feedTime = 5; feed.hidden = false; feed.style.opacity = '1'; },
    hit() { flashTime = .3; flash.hidden = false; },
    update(dt, inGame, state) {
      health.hidden = !inGame;
      const value = Math.ceil(state.health), text = state.wrecked ? 'Wrecked' : state.protected ? 'Protected' : 'Health';
      if (value !== lastHealth) { lastHealth = value; bar.value = value; }
      if (text !== lastLabel) { lastLabel = text; label.textContent = text; }
      if (flashTime > 0) { flashTime -= dt; if (flashTime <= 0) flash.hidden = true; }
      if (feedTime > 0) { const prev = feedTime; feedTime -= dt; if (prev > 1 && feedTime <= 1) feed.style.opacity = '0'; if (feedTime <= 0) feed.hidden = true; }
      if (!inGame) { flash.hidden = feed.hidden = true; flashTime = feedTime = 0; }
    },
    dispose() { health.remove(); feed.remove(); flash.remove(); style.remove(); },
  };
}
