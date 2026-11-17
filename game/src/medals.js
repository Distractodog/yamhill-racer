// Race medals (no DOM, no three.js): each race in challenges.json has gold / silver / bronze target times in seconds
// (`medals`, made by tools/challenge_routes.py from the race bot's time). A run at or under a target earns that medal;
// the best medal per race is saved per browser (localStorage yr-medals-1: { raceId: 'gold' | 'silver' | 'bronze' }).
// Used by challenges.js (finish screen) and racemenu.js (cards); tested by tools/medals_test.mjs.
export const MEDAL_KEY = 'yr-medals-1';
export const MEDALS = ['gold', 'silver', 'bronze'];                // best first
export const MEDAL_ICON = { gold: '🥇', silver: '🥈', bronze: '🥉' };
export const MEDAL_NAME = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };

// 0 gold, 1 silver, 2 bronze, 3 none: lower is better
const rank = m => { const i = MEDALS.indexOf(m); return i < 0 ? MEDALS.length : i; };
export const isBetterMedal = (a, b) => rank(a) < rank(b);

// the medal a time earns on a race's targets (null: none, or the race has no targets)
export function medalFor(time, targets) {
  if (!targets || typeof time !== 'number' || !isFinite(time) || time < 0) return null;
  for (const m of MEDALS) if (typeof targets[m] === 'number' && isFinite(targets[m]) && time <= targets[m]) return m;
  return null;
}

// the next medal up from a time: { medal, target, gap } (gap = seconds to find, > 0), or null (gold already, or no
// targets / no time)
export function nextMedal(time, targets) {
  if (!targets || typeof time !== 'number' || !isFinite(time)) return null;
  const up = MEDALS[rank(medalFor(time, targets)) - 1], target = targets[up];
  return up && typeof target === 'number' && isFinite(target) ? { medal: up, target, gap: time - target } : null;
}

// storage: anything with getItem / setItem (localStorage, or a fake in tests); a broken or missing store just
// doesn't remember
export function createMedals(storage = globalThis.localStorage) {
  const won = {};
  try {
    const saved = JSON.parse(storage?.getItem(MEDAL_KEY) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, m] of Object.entries(saved)) if (MEDALS.includes(m)) won[id] = m;
    }
  } catch {}
  const save = () => { try { storage?.setItem(MEDAL_KEY, JSON.stringify(won)); } catch {} };
  return {
    get: id => won[id] || null,
    all: () => ({ ...won }),
    // a finished run: the medal it earned, the race's medal before, and whether it is a better one (then saved)
    record(race, time) {
      const medal = medalFor(time, race?.medals), prev = won[race?.id] || null;
      const improved = !!medal && isBetterMedal(medal, prev);
      if (improved) { won[race.id] = medal; save(); }
      return { medal, prev, improved };
    },
    // best times saved before medals existed (yr-best-1) earn their medals once, at load
    importBests(list, best) {
      let changed = false;
      for (const c of list || []) {
        const m = medalFor(best?.[c.id]?.time, c.medals);
        if (m && isBetterMedal(m, won[c.id])) { won[c.id] = m; changed = true; }
      }
      if (changed) save();
    },
    tally() {
      const t = { gold: 0, silver: 0, bronze: 0 };
      for (const m of Object.values(won)) t[m]++;
      return t;
    },
  };
}
