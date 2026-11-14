// Cosmetic-only race rewards. Completion records never affect vehicle performance.
export const REWARDS_KEY = 'yr-rewards-1';
export const REWARD_CATALOG = Object.freeze([
  { id: 'campus', name: 'Campus Club', description: 'Finish the Long Walk climb.', races: ['long-walk'], color: '#d6b96d' },
  { id: 'trail', name: 'Trail Team', description: 'Finish all three dirt-bike races.', races: ['bike-south-loop', 'bike-north-scramble', 'bike-gravel-run'], color: '#b8c89b' },
  { id: 'jet', name: 'Valley Wings', description: 'Finish both jet races.', races: ['jet-hwy18-sortie', 'jet-valley-loop'], color: '#a4c8db' },
]);
const allowed = new Set(REWARD_CATALOG.flatMap(r => r.races));
const validTime = t => typeof t === 'number' && Number.isFinite(t) && t > 0 && t < 86400;
export function createRewards({ storage = null } = {}) {
  if (!storage) { try { storage = globalThis.localStorage; } catch {} }
  let completed = {}; const listeners = new Set();
  try {
    const saved = JSON.parse(storage?.getItem(REWARDS_KEY) || 'null');
    if (saved?.version === 1 && saved.completed && typeof saved.completed === 'object') {
      for (const [id, time] of Object.entries(saved.completed)) if (allowed.has(id) && validTime(time)) completed[id] = time;
    }
  } catch {}
  const has = id => { const reward = REWARD_CATALOG.find(r => r.id === id); return !!reward && reward.races.every(r => validTime(completed[r])); };
  const list = () => REWARD_CATALOG.map(r => ({ ...r, races: [...r.races], unlocked: has(r.id), completed: r.races.filter(id => validTime(completed[id])).length, total: r.races.length }));
  function persist() {
    try { storage?.setItem(REWARDS_KEY, JSON.stringify({ version: 1, completed })); } catch {}
  }
  function notify(newRewards) {
    const detail = { unlocked: newRewards.map(r => r.id), rewards: list() };
    for (const fn of listeners) fn(detail);
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') globalThis.dispatchEvent(new CustomEvent('yr-rewards-changed', { detail }));
  }
  function complete(challenge, time) {
    const id = typeof challenge === 'string' ? challenge : challenge?.id;
    if (!allowed.has(id) || !validTime(time)) return [];
    const before = new Set(REWARD_CATALOG.filter(r => has(r.id)).map(r => r.id));
    if (validTime(completed[id]) && completed[id] <= time) return [];
    completed[id] = time; persist();
    const unlocked = REWARD_CATALOG.filter(r => has(r.id) && !before.has(r.id));
    notify(unlocked); return unlocked;
  }
  function importBests(challenges, best) {
    if (!best || typeof best !== 'object') return;
    for (const challenge of challenges) { const record = best[challenge.id]; if (validTime(record?.time)) complete(challenge, record.time); }
  }
  return { has, list, complete, importBests, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
}
