// The world controller is DOM-free so its lifecycle can be tested with a fake Net.
export function createWorldSettings({ mp, tuning, atmosphere, refresh = () => {}, lock = () => {}, timers = globalThis }) {
  let mode = 'host', bump = true, snapshot = null, last = '', pending = null;
  const listeners = [];
  const on = (type, fn) => { mp.on(type, fn); listeners.push([type, fn]); };
  const read = () => ({ bump, tuning: structuredClone(tuning), atmosphere: { preset: atmosphere.preset } });
  function apply(settings) {
    for (const kind of ['car', 'bike', 'jet']) {
      const source = settings?.tuning?.[kind];
      for (const key of Object.keys(tuning[kind])) {
        const value = source?.[key];
        if (typeof value === 'number' && Number.isFinite(value)) tuning[kind][key] = value;
      }
    }
    if (typeof settings?.atmosphere?.preset === 'string') atmosphere.setPreset(settings.atmosphere.preset, false);
    refresh();
  }
  function restore() {
    if (snapshot) { apply(snapshot); snapshot = null; }
    lock(false);
  }
  function publish() {
    if (mp.inGame && mp.isHost) { const settings = read(); last = JSON.stringify(settings); mp.send({ t: 'world', mode, settings }); }
  }
  on('connected', () => { mode = 'host'; bump = true; if (mp.isHost) publish(); });
  on('world', message => {
    if (!mp.inGame || mp.isHost || !['host', 'own'].includes(message.mode)) return;
    // Only the roster's host may supply world settings.
    if (message.from && !mp.players.get(message.from)?.host) return;
    mode = message.mode; bump = message.settings?.bump !== false;
    if (mode === 'host') { snapshot ||= read(); apply(message.settings); lock(true); }
    else restore();
  });
  for (const event of ['disconnected', 'kicked', 'closed']) on(event, () => { restore(); mode = 'host'; bump = true; timers.clearTimeout(pending); pending = null; });
  const interval = timers.setInterval(() => {
    if (!mp.inGame || !mp.isHost) return;
    const next = JSON.stringify(read());
    if (next === last) return;
    last = next; timers.clearTimeout(pending);
    pending = timers.setTimeout(() => { pending = null; publish(); }, 300);
  }, 100);
  return {
    get mode() { return mode; },
    get bump() { return bump; },
    setBump(next) { if (!mp.inGame || !mp.isHost) return; bump = !!next; publish(); },
    setMode(next) { if (!mp.inGame || !mp.isHost || !['host', 'own'].includes(next)) return; mode = next; publish(); },
    restore,
    dispose() { restore(); timers.clearInterval(interval); timers.clearTimeout(pending); for (const [type, fn] of listeners) mp.off(type, fn); },
  };
}

export function createMPMenu({ mp, settings, tuning, atmosphere, gui, beforeOpen = () => {} }) {
  const button = document.getElementById('mp-button');
  const panel = document.createElement('section');
  panel.id = 'mp-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'mp-title');
  panel.innerHTML = `<header class="panel-heading"><h2 id="mp-title">Play multiplayer</h2><button id="mp-close" aria-label="Close multiplayer">×</button></header>
    <label>Your name <input id="mp-name" maxlength="80" autocomplete="nickname"></label>
    <p>Your code: <strong id="mp-code"></strong> <button id="mp-copy" class="menu-button">Copy</button></p>
    <div id="mp-connect"><button id="mp-host" class="menu-button">Host my game</button>
      <form id="mp-join-form"><label>Friend’s code <input id="mp-join-code" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" required pattern="[A-HJ-KM-NP-Z2-9a-hj-km-np-z]{5}"></label><button id="mp-join" class="menu-button">Join</button></form></div>
    <div id="mp-game" hidden><p>Game code: <strong id="mp-room"></strong></p><h3>Players</h3><ul id="mp-players"></ul>
      <fieldset id="mp-world"><legend>World settings</legend><label><input type="radio" name="mp-mode" value="host">Everyone uses the host's settings</label><label><input type="radio" name="mp-mode" value="own">Everyone uses their own settings</label><label>Bumping: <select id="mp-bump"><option value="on">on</option><option value="off">off</option></select></label></fieldset>
      <p id="mp-host-note">Only the host can change world settings.</p><button id="mp-leave" class="menu-button">Leave game</button></div><p id="mp-status" role="status"></p>`;
  document.body.append(panel);
  const $ = id => panel.querySelector('#mp-' + id);
  const toast = document.createElement('div'); toast.id = 'mp-toasts'; toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite'); document.body.append(toast);
  let toastTimer, busy = false;
  function say(text) { toast.textContent = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.textContent = ''; }, 4500); }
  const note = document.createElement('p'); note.id = 'mp-settings-note'; note.hidden = true; note.textContent = 'The host controls tuning and atmosphere while everyone uses the host’s settings.';
  document.getElementById('settings-title').parentElement.after(note);
  function lock(locked) {
    note.hidden = !locked;
    for (const id of ['tuning-controls', 'atmosphere-presets']) { const el = document.getElementById(id); el.inert = locked; el.setAttribute('aria-disabled', String(locked)); }
    for (const controller of gui.controllersRecursive()) controller.disable(locked);
  }
  const world = createWorldSettings({ mp, tuning, atmosphere, lock, refresh: () => {
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    document.querySelectorAll('[data-preset]').forEach(el => el.setAttribute('aria-pressed', String(el.dataset.preset === atmosphere.preset)));
  } });
  let names = new Map(mp.players);
  function render() {
    button.textContent = mp.inGame ? 'Multiplayer' : 'Play multiplayer';
    const menuButton = document.getElementById('menu-button');
    if (menuButton) menuButton.textContent = mp.inGame ? '☰ Menu · MP' : '☰ Menu';
    $('title').textContent = button.textContent; $('connect').hidden = mp.inGame; $('game').hidden = !mp.inGame;
    $('code').textContent = mp.me.code; $('room').textContent = mp.roomCode || '';
    // guests see the host's choice checked but can't change it (inert, not disabled: a disabled radio's dot is near invisible)
    $('world').inert = !mp.isHost; $('world').setAttribute('aria-disabled', String(!mp.isHost)); $('host-note').hidden = mp.isHost;
    panel.querySelectorAll('[name="mp-mode"]').forEach(el => { el.checked = el.value === world.mode; });
    $('bump').value = world.bump ? 'on' : 'off';
    $('players').replaceChildren();
    for (const player of mp.players.values()) {
      const row = document.createElement('li'), label = document.createElement('span');
      label.textContent = `${player.name}${player.host ? ' · Host' : ''}${player.id === mp.me.id ? ' · You' : ''}`; row.append(label);
      if (mp.isHost && player.id !== mp.me.id) { const remove = document.createElement('button'); remove.className = 'menu-button'; remove.textContent = 'Remove'; remove.dataset.player = player.id; remove.addEventListener('click', () => mp.send({ t: 'kick', id: player.id })); row.append(remove); }
      $('players').append(row);
    }
    names = new Map([...names, ...mp.players]);
  }
  function close() { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); (document.getElementById('menu-button') || button).focus({ preventScroll: true }); }
  button.disabled = false;
  button.addEventListener('click', () => {
    if (!panel.hidden) { settings.close(); return; }
    beforeOpen(); settings.openExternal(panel, close); render(); panel.hidden = false; button.setAttribute('aria-expanded', 'true'); $('name').value = mp.me.name; $('close').focus();
  });
  $('close').addEventListener('click', () => settings.close());
  $('name').value = mp.me.name;
  $('name').addEventListener('change', () => { mp.setName($('name').value); $('name').value = mp.me.name; });
  $('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(mp.me.code); $('status').textContent = 'Code copied'; } catch { $('status').textContent = `Your code is ${mp.me.code}`; } });
  async function connect(join) {
    if (busy) return;
    busy = true; $('host').disabled = $('join').disabled = true; $('status').textContent = 'Connecting…';
    try { mp.setName($('name').value); await (join ? mp.join($('join-code').value.trim().toUpperCase()) : mp.host()); $('status').textContent = ''; }
    catch (error) { $('status').textContent = `Could not connect: ${error?.message || error}`; }
    finally { busy = false; $('host').disabled = $('join').disabled = false; render(); }
  }
  $('host').addEventListener('click', () => connect(false));
  $('join-form').addEventListener('submit', e => { e.preventDefault(); connect(true); });
  $('world').addEventListener('change', e => { if (e.target.id === 'mp-bump') world.setBump(e.target.value === 'on'); else world.setMode(e.target.value); render(); });
  $('leave').addEventListener('click', () => { world.restore(); mp.leave(); render(); });
  mp.on('joined', ({ player }) => { if (player.id !== mp.me.id) say(`${player.name} joined`); render(); });
  mp.on('left', ({ id }) => { say(`${names.get(id)?.name || 'A player'} left`); render(); });
  mp.on('kicked', () => { say('You were removed'); render(); });
  mp.on('closed', ({ reason }) => { say(reason === 'full' ? 'This game is full' : reason === 'no-host' ? 'No host found for that code' : 'The host left — game over'); render(); });
  for (const event of ['connected', 'disconnected', 'roster', 'world']) mp.on(event, render);
  render();
  return { world, open: () => button.click() };
}
