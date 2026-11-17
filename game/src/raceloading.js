// Race preparation. Pure sampling/readiness functions also run in Node; the view shares the J menu's route picture.
import { drawRoutePreview, mapPicture, raceFacts } from './racemenu.js';
import { MEDALS, MEDAL_ICON, MEDAL_NAME } from './medals.js';

export function raceLoadPoints(race, start = race.start) {
  const points = [[start.x, start.z]];
  // Include the camera's ground and the neighbouring tiles even at a tile corner.
  for (const dx of [-250, 0, 250]) for (const dz of [-250, 0, 250]) points.push([start.x + dx, start.z + dz]);
  const route = race.route?.length > 1 ? race.route : race.gates.map(g => [g.x, g.z]);
  let left = 1000;
  for (let i = 1; i < route.length && left > 0; i++) {
    const [x, z] = route[i - 1], dx = route[i][0] - x, dz = route[i][1] - z, length = Math.hypot(dx, dz);
    const take = Math.min(left, length), steps = Math.max(1, Math.ceil(take / 100));
    for (let j = 0; j <= steps; j++) {
      const t = length ? take * j / steps / length : 0;
      for (const side of [-80, 0, 80]) points.push([x + dx * t + (length ? dz / length * side : 0), z + dz * t - (length ? dx / length * side : 0)]);
    }
    left -= take;
  }
  return points;
}

export function raceGroundProgress(world, points) {
  const needed = points.filter(([x, z], i) => i === 0 || !world.mapContains || world.mapContains(x, z, 0));
  return needed.filter(([x, z]) => world.loadedAt(x, z)).length / needed.length;
}

// now is monotonic milliseconds; sync uses the independent relay clock. Readiness is never inferred from elapsed time.
export function createRaceLoadState({ now = () => performance.now(), minimum = 800, timeout = 30000, fade = 250, sync = null } = {}) {
  const began = now();
  let fadeAt = null, cancelled = false, timedOut = false;
  return {
    cancel() { cancelled = true; },
    update({ ground = 0, furniture = false, compiled = false } = {}) {
      if (cancelled) return { phase: 'cancelled', progress: 0, timedOut };
      const at = now(), ready = ground === 1 && furniture && compiled;
      timedOut ||= at - began >= timeout && !ready;
      const progress = Math.min(1, ground * .8 + Number(furniture) * .1 + Number(compiled) * .1);
      if ((ready || timedOut) && at - began >= minimum) {
        if (sync && sync.at - sync.now() > 3000) return { phase: 'waiting', progress: 1, timedOut };
        fadeAt ??= at;
      }
      return { phase: fadeAt === null ? 'loading' : at - fadeAt >= fade ? 'done' : 'fading', progress, timedOut };
    },
  };
}

export function createRaceLoadingView({ fmtTime, base }) {
  // The race manager also runs in Node physics tests without a browser DOM.
  if (typeof window === 'undefined') return { show() {}, update() {}, hide() {} };
  const style = document.createElement('style');
  style.textContent = `
#race-loading[hidden]{display:none!important}
#race-loading{position:fixed;inset:0;z-index:90;display:grid;place-items:center;background:#06100df2;color:#edf7ef;padding:20px;box-sizing:border-box;font:14px/1.4 system-ui,sans-serif;opacity:1;transition:opacity .25s}
#race-loading.fading{opacity:0}
#race-loading .rl-panel{width:min(520px,100%);max-height:90dvh;overflow:auto;background:#12251ff7;border:1px solid #eac17c55;border-radius:20px;box-shadow:0 24px 80px #0009;padding:22px;box-sizing:border-box}
#race-loading h2{font-size:24px;margin:4px 0 16px}
#race-loading canvas{width:100%;height:auto;border-radius:10px;background:#21402f;display:block}
#race-loading .rl-facts{color:#e7c68a;margin:12px 0}
#race-loading .rl-targets{display:flex;flex-wrap:wrap;gap:12px;font-variant-numeric:tabular-nums}
#race-loading progress{width:100%;height:12px;accent-color:#ffd23f;margin-top:20px}
#race-loading .rl-status{color:#c3d5c8;margin:8px 0 0;min-height:20px}
`;
  document.head.append(style);
  const root = document.createElement('section'); root.id = 'race-loading'; root.hidden = true;
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-labelledby', 'rl-title');
  root.innerHTML = `<div class="rl-panel"><h2 id="rl-title"></h2><canvas width="704" height="396" aria-label="Race route"></canvas><p class="rl-facts"></p><div class="rl-targets"></div><progress max="1" value="0" aria-label="Race loading progress"></progress><p class="rl-status" role="status" aria-live="polite"></p></div>`;
  document.body.append(root);
  let revision = 0;
  return {
    show(race) {
      const token = ++revision, facts = raceFacts(race);
      root.hidden = false; root.className = '';
      root.querySelector('h2').textContent = race.name;
      root.querySelector('.rl-facts').textContent = `${facts.icon} ${facts.vehicle} · ${facts.dist}`;
      root.querySelector('.rl-targets').textContent = race.medals ? MEDALS.map(m => `${MEDAL_ICON[m]} ${MEDAL_NAME[m]} ${fmtTime(race.medals[m])}`).join('   ') : '';
      const canvas = root.querySelector('canvas');
      try { drawRoutePreview(canvas, race, null); } catch {} // Minimal DOM in headless physics tests.
      mapPicture(base).then(pic => { if (revision === token && !root.hidden) { try { drawRoutePreview(canvas, race, pic); } catch {} } });
      this.update({ phase: 'loading', progress: 0 });
    },
    update(s) {
      root.className = s.phase === 'fading' ? 'fading' : '';
      root.querySelector('progress').value = s.progress;
      root.querySelector('.rl-status').textContent = s.timedOut ? 'Taking longer than expected — starting with the available scenery.' : s.phase === 'waiting' ? 'Waiting for others…' : s.progress === 1 ? 'Ready to race' : `Loading course… ${Math.floor(s.progress * 100)}%`;
    },
    hide() { revision++; root.hidden = true; },
  };
}
