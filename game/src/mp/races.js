// Multiplayer races: wires racecore.js to the real relay client (net.js), the J race menu and pop-up panels.
import { mp } from './net.js';
import { createRaceCore, esc } from './racecore.js';

const CSS = `
.mp-panel { position: fixed; z-index: 30; background: #142016f2; color: #fff; border-radius: 14px; box-shadow: 0 10px 40px #0008;
  padding: 16px 18px; font: 14px system-ui, sans-serif; display: none; width: min(340px, 90vw); }
#mp-invite-in { top: 240px; right: 14px; } #mp-invite-out { top: 50%; left: 50%; transform: translate(-50%, -50%); }
@media (max-width: 600px) { #mp-invite-in { top: 170px; } }   /* below the corner map (14 + 210 px, 140 px on small screens) */
.mp-panel h3 { margin: 0 0 10px; font-size: 17px; } .mp-panel label, .mp-panel .mp-row { display: flex; gap: 8px; padding: 4px 0; align-items: center; }
.mp-panel .mp-row em { margin-left: auto; opacity: .8; font-style: normal; }
.mp-panel button, .ch-panel .mp-invite-btn { font: inherit; font-weight: 700; border: 0; border-radius: 8px; padding: 8px 14px; margin: 10px 8px 0 0; cursor: pointer; background: #ffd23f; color: #222; }
.mp-panel button.alt, .ch-panel .mp-invite-btn { background: #ffffff26; color: #fff; }
.mp-panel button:disabled { opacity: .45; cursor: default; }
.ch-panel .mp-invite-btn { display: block; width: 100%; margin: 12px 0 0; }
.mp-places { margin-top: 4px; font-size: 13px; line-height: 1.35; } .mp-places .me, .mp-results .me { color: #ffd23f; font-weight: 800; }
.mp-results { margin: 10px 0; text-align: left; } .mp-results div { display: flex; gap: 8px; padding: 2px 0; }
.mp-results span { width: 34px; opacity: .8; } .mp-results em { margin-left: auto; font-style: normal; font-variant-numeric: tabular-nums; }
`;

export function createRaces({ challenges, car }) {
  const style = document.createElement('style'); style.textContent = CSS; document.head.append(style);
  const mk = id => { const e = document.createElement('div'); e.id = id; e.className = 'mp-panel'; document.body.append(e); return e; };
  const inEl = mk('mp-invite-in'), outEl = mk('mp-invite-out');
  let inTimer = null, core;

  const ui = {
    incoming(inv) {
      clearInterval(inTimer);
      if (!inv) { inEl.style.display = 'none'; return; }
      let left = Math.round(inv.ttl / 1000);
      const draw = () => { inEl.innerHTML = `<h3>${esc(inv.fromName)} invites you to ${esc(inv.raceName)}</h3>
        <button data-a="yes">Accept</button><button data-a="no" class="alt">Decline (${left})</button>`; };
      draw(); inEl.style.display = 'block';
      inTimer = setInterval(() => { left = Math.max(0, left - 1); draw(); }, 1000);
    },
    notice(text) {                                      // brief message in the invite corner
      clearInterval(inTimer); inEl.innerHTML = `<h3>${esc(text)}</h3>`; inEl.style.display = 'block';
      inTimer = setTimeout(() => { inEl.style.display = 'none'; }, 3000);
    },
    lobby(d) {
      if (!d) { outEl.style.display = 'none'; return; }
      const label = { wait: 'waiting…', accept: '✓ accepted', decline: '✗ declined' };
      outEl.innerHTML = `<h3>${esc(d.raceName)}</h3>${d.rows.map(r => `<div class="mp-row">${esc(r.name)}<em>${label[r.status]}</em></div>`).join('')}
        <button data-a="start"${d.canStart ? '' : ' disabled'}>Start</button><button data-a="cancel" class="alt">Cancel</button>`;
      outEl.style.display = 'block';
    },
    results() { const e = document.getElementById('ch-mp-results'); if (e) e.innerHTML = core.resultsHtml(); },
    pick(race, i) { challenges.closeMenu(); picker(race, i); },
  };
  function picker(race, i) {
    const others = [...mp.players.values()].filter(p => p.id !== mp.me.id);
    outEl.innerHTML = `<h3>Invite to ${esc(race.name)}</h3>${others.length ? others.map(p => `<label><input type="checkbox" value="${esc(p.id)}" checked> ${esc(p.name)}</label>`).join('') : '<div>No other players yet.</div>'}
      <button data-a="invite"${others.length ? '' : ' disabled'}>Invite</button><button data-a="solo" class="alt">Race solo</button><button data-a="cancel" class="alt">Cancel</button>`;
    outEl.style.display = 'block'; outEl.dataset.race = race.id; outEl.dataset.i = i;
  }
  inEl.addEventListener('click', e => { const a = e.target.dataset?.a; if (a === 'yes') core.accept(); else if (a === 'no') core.decline(); });
  outEl.addEventListener('click', e => {
    const a = e.target.dataset?.a;
    if (a === 'invite') {
      const ids = [...outEl.querySelectorAll('input:checked')].map(i => i.value);
      if (!core.invite(outEl.dataset.race, ids)) outEl.style.display = 'none';
    } else if (a === 'solo') { outEl.style.display = 'none'; challenges.start(+outEl.dataset.i); }
    else if (a === 'start') core.start();
    else if (a === 'cancel') { if (core.outgoing) core.cancelInvite(); else outEl.style.display = 'none'; }
  });

  core = createRaceCore({ mp, challenges, ui, pos: () => ({ x: car.pos.x, z: car.pos.z }) });
  // canInvite: the race menu shows "Invite players" (→ hook.pick → the invite step above) in a game with other players
  challenges.mpHook = { ...core.hook, canInvite: () => mp.inGame && [...mp.players.keys()].some(id => id !== mp.me.id) };
  return core;
}
