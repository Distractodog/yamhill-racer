// The world controller is DOM-free so its lifecycle can be tested with a fake Net.
export function createWorldSettings({ mp, tuning, atmosphere, wind, refresh = () => {}, lock = () => {}, timers = globalThis }) {
  let mode = 'host', bump = true, snapshot = null, last = '', pending = null, sinceClock = 0;
  const CLOCK_SEND = 30000;
  const listeners = [];
  const on = (type, fn) => { mp.on(type, fn); listeners.push([type, fn]); };
  // atmosphere: what the host shares (a change sends at once); its day/night clock goes with every send and every
  // CLOCK_SEND ms, and guests ease into it (daycycle.js follow)
  const read = () => ({ bump, tuning: structuredClone(tuning), atmosphere: atmosphere.shared ? atmosphere.shared() : { preset: atmosphere.preset } });
  function apply(settings, restoring = false) {
    for (const kind of ['car', 'bike', 'jet']) {
      const source = settings?.tuning?.[kind];
      for (const key of Object.keys(tuning[kind])) {
        const value = source?.[key];
        if (typeof value === 'number' && Number.isFinite(value)) tuning[kind][key] = value;
      }
    }
    if (restoring && atmosphere.unfollow) atmosphere.unfollow();
    else if (atmosphere.follow) { if (settings?.atmosphere) atmosphere.follow(settings.atmosphere); }
    else if (typeof settings?.atmosphere?.preset === 'string') atmosphere.setPreset(settings.atmosphere.preset, false);
    refresh();
  }
  function restore() {
    if (snapshot) { apply(snapshot, true); snapshot = null; }
    lock(false);
  }
  function publish() {
    if (!mp.inGame || !mp.isHost) return;
    const settings = read(); last = JSON.stringify(settings); sinceClock = 0;
    if (atmosphere.clock) settings.atmosphere = { ...settings.atmosphere, ...atmosphere.clock() };
    if (wind) settings.wind = wind.clock();
    mp.send({ t: 'world', mode, settings });
  }
  on('connected', () => { mode = 'host'; bump = true; if (mp.isHost) publish(); });
  on('world', message => {
    if (!mp.inGame || mp.isHost || !['host', 'own'].includes(message.mode)) return;
    // Only the roster's host may supply world settings.
    if (message.from && !mp.players.get(message.from)?.host) return;
    wind?.follow(message.settings?.wind);
    mode = message.mode; bump = message.settings?.bump !== false;
    if (mode === 'host') { snapshot ||= read(); apply(message.settings); lock(true); }
    else restore();
  });
  for (const event of ['disconnected', 'kicked', 'closed']) on(event, () => { restore(); wind?.unfollow(); mode = 'host'; bump = true; timers.clearTimeout(pending); pending = null; });
  const interval = timers.setInterval(() => {
    if (!mp.inGame || !mp.isHost) return;
    const next = JSON.stringify(read());
    if (next === last) {
      if ((wind || (atmosphere.clock && mode === 'host')) && (sinceClock += 100) >= CLOCK_SEND) publish();
      return;
    }
    last = next; timers.clearTimeout(pending);
    pending = timers.setTimeout(() => { pending = null; publish(); }, 300);
  }, 100);
  return {
    get mode() { return mode; },
    get bump() { return bump; },
    setBump(next) { if (!mp.inGame || !mp.isHost) return; bump = !!next; publish(); },
    setMode(next) { if (!mp.inGame || !mp.isHost || !['host', 'own'].includes(next)) return; mode = next; publish(); },
    restore,
    dispose() { restore(); wind?.unfollow(); timers.clearInterval(interval); timers.clearTimeout(pending); for (const [type, fn] of listeners) mp.off(type, fn); },
  };
}

// One request per open generation; a closed/reopened menu never accepts an old response.
export function createGameListing({ load, render, available = () => true }) {
  let version = 0, opened = false, pending = null;
  return {
    open() { opened = true; version++; pending = null; render([], 'Looking for games…'); return this.refresh(); },
    close() { opened = false; version++; pending = null; },
    async refresh() {
      if (!opened || !available() || pending === version) return;
      const request = version; pending = request;
      try {
        const games = await load();
        if (opened && request === version && available()) render(games, games.length ? '' : 'No one is hosting right now — host a game');
      } catch {
        if (opened && request === version && available()) render([], 'Could not refresh open games. Trying again…');
      } finally { if (pending === request) pending = null; }
    },
  };
}

export function createMPMenu({ mp, settings, tuning, atmosphere, wind, gui, beforeOpen = () => {} }) {
  const button = document.getElementById('mp-button');
  const panel = document.createElement('section');
  panel.id = 'mp-panel'; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-labelledby', 'mp-title');
  panel.innerHTML = `<header class="panel-heading"><h2 id="mp-title">Play multiplayer</h2><button id="mp-close" aria-label="Close multiplayer">×</button></header>
    <label>Your name <input id="mp-name" maxlength="16" placeholder="Choose a name" autocomplete="nickname"></label>
    <p id="mp-name-hint" role="status">Choose a name first</p>
    <div id="mp-connect"><button id="mp-host" class="menu-button">Host a game</button>
      <h3>Open games</h3><p id="mp-empty" role="status">Looking for games…</p><ul id="mp-games"></ul>
      <button id="mp-cancel" class="menu-button" hidden>Cancel request</button></div>
    <div id="mp-game" hidden><label id="mp-policy"><input id="mp-anyone" type="checkbox"> Let anyone join without asking</label><h3>Players</h3><ul id="mp-players"></ul>
      <fieldset id="mp-world"><legend>World settings</legend><label><input type="radio" name="mp-mode" value="host">Everyone uses the host's settings</label><label><input type="radio" name="mp-mode" value="own">Everyone uses their own settings</label><label>Bumping: <select id="mp-bump"><option value="on">on</option><option value="off">off</option></select></label></fieldset>
      <p id="mp-host-note">Only the host can change world settings.</p><button id="mp-leave" class="menu-button">Leave game</button></div><p id="mp-status" role="status"></p>`;
  document.body.append(panel);
  const $ = id => panel.querySelector('#mp-' + id);
  const toast = document.createElement('div'); toast.id = 'mp-toasts'; toast.setAttribute('role', 'status'); toast.setAttribute('aria-live', 'polite'); document.body.append(toast);
  let toastTimer, busy = false, pollTimer = null;
  let games = [], listSignature = '', declineMessage = '';
  const requests = document.createElement('section'); requests.id = 'mp-requests'; requests.hidden = true;
  requests.setAttribute('aria-label', 'Join requests'); requests.setAttribute('aria-live', 'polite'); document.body.append(requests);
  const pending = new Map();
  function showRequests() {
    // Keep decisions inside the menu's keyboard focus trap while it is open.
    (panel.hidden ? document.body : panel).append(requests);
    requests.replaceChildren(); requests.hidden = !pending.size || !mp.isHost;
    for (const request of pending.values()) {
      const row = document.createElement('div'), label = document.createElement('p');
      row.dataset.request = request.id; label.textContent = `${request.name} wants to join`; row.append(label);
      for (const [action, text] of [['accept', 'Accept'], ['decline', 'Decline']]) {
        const choice = document.createElement('button'); choice.className = 'menu-button'; choice.textContent = text;
        choice.dataset.action = action;
        choice.addEventListener('click', () => mp.send({ t: `join-${action}`, id: request.id })); row.append(choice);
      }
      requests.append(row);
    }
  }
  function drawGames() {
    const signature = JSON.stringify([games, busy, validName($('name').value)]); if (signature === listSignature) return; listSignature = signature;
    $('games').replaceChildren();
    for (const game of games) {
      const row = document.createElement('li'), label = document.createElement('span'), ask = document.createElement('button');
      label.textContent = `${game.name} · ${game.players} / ${game.max}`;
      ask.className = 'menu-button'; ask.textContent = 'Ask to join'; ask.dataset.game = game.id;
      ask.disabled = busy || !validName($('name').value) || game.players >= game.max;
      ask.addEventListener('click', () => connect(game)); row.append(label, ask); $('games').append(row);
    }
  }
  const listing = createGameListing({ load: () => mp.listGames(), available: () => !panel.hidden && !mp.inGame,
    render(next, message) { games = next; $('empty').textContent = message; drawGames(); } });
  const refreshGames = () => listing.refresh();
  function startPolling() { clearInterval(pollTimer); listing.open(); pollTimer = setInterval(refreshGames, 5000); }
  function validName(value) { const name = value.trim(); return name.length >= 2 && name.length <= 16 && /^[A-Za-z0-9 _.-]+$/.test(name); }
  function updateName() {
    const valid = validName($('name').value); $('name-hint').hidden = valid; $('host').disabled = !valid || busy;
    $('name').setAttribute('aria-invalid', String(!valid)); drawGames();
  }

  function say(text) { toast.textContent = text; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.textContent = ''; }, 4500); }
  const note = document.createElement('p'); note.id = 'mp-settings-note'; note.hidden = true; note.textContent = 'The host controls tuning, time of day and weather while everyone uses the host’s settings.';
  document.getElementById('settings-title').parentElement.after(note);
  function lock(locked) {
    note.hidden = !locked;
    for (const id of ['tuning-controls', 'atmosphere-controls']) { const el = document.getElementById(id); el.inert = locked; el.setAttribute('aria-disabled', String(locked)); }
    for (const controller of gui.controllersRecursive()) controller.disable(locked);
  }
  const world = createWorldSettings({ mp, tuning, atmosphere, wind, lock, refresh: () => {
    gui.controllersRecursive().forEach(c => c.updateDisplay());
    settings.refreshAtmosphere?.();
  } });
  let names = new Map(mp.players);
  function render() {
    button.textContent = mp.inGame ? 'Multiplayer' : 'Play multiplayer';
    const menuButton = document.getElementById('menu-button');
    if (menuButton) menuButton.querySelector('.menu-label').textContent = mp.inGame ? 'Menu · MP' : 'Menu';
    $('title').textContent = button.textContent; $('connect').hidden = mp.inGame; $('game').hidden = !mp.inGame;
    $('policy').hidden = !mp.isHost;
    if (!mp.inGame) { pending.clear(); showRequests(); }
    drawGames();
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
  function close() { clearInterval(pollTimer); pollTimer = null; listing.close(); panel.hidden = true; document.body.append(requests); button.setAttribute('aria-expanded', 'false'); (document.getElementById('menu-button') || button).focus({ preventScroll: true }); }
  button.disabled = false;
  button.addEventListener('click', () => {
    if (!panel.hidden) { settings.close(); return; }
    beforeOpen(); settings.openExternal(panel, close); render(); panel.hidden = false; button.setAttribute('aria-expanded', 'true'); $('name').value = mp.me.name; $('close').focus(); showRequests(); startPolling();
  });
  $('close').addEventListener('click', () => settings.close());
  $('name').value = mp.me.name;
  $('name').addEventListener('input', updateName);
  $('name').addEventListener('change', () => { if (validName($('name').value)) mp.setName($('name').value); $('name').value = mp.me.name; updateName(); });
  async function connect(game) {
    if (busy || !validName($('name').value)) { updateName(); return; }
    busy = true; declineMessage = ''; $('host').disabled = true; $('cancel').hidden = !game;
    $('status').textContent = game ? `Asking ${game.name} to join…` : 'Connecting…'; drawGames();
    try { mp.setName($('name').value); await (game ? mp.requestJoin(game.id) : mp.host()); $('status').textContent = ''; }
    catch (error) {
      const messages = { 'request-pending': 'You already have a pending request.', 'rate-limit': 'Too many requests — try again in a minute.',
        'full': 'This game is full.', 'no-host': 'This game is no longer available.', 'host-left': 'The host left.',
        'left': 'Request cancelled.', 'timeout': 'The request timed out. Try again.', 'lobby-unavailable': 'Open games are unavailable. Try again.' };
      $('status').textContent = declineMessage || messages[error?.reason] || `Could not connect: ${error?.message || error}`;
    }
    finally { busy = false; $('cancel').hidden = true; render(); updateName(); refreshGames(); }
  }
  $('host').addEventListener('click', () => connect());
  updateName();
  $('cancel').addEventListener('click', () => mp.leave());
  $('anyone').addEventListener('change', () => mp.send({ t: 'join-policy', anyone: $('anyone').checked }));
  mp.on('join-policy', ({ anyone }) => { $('anyone').checked = anyone; });
  mp.on('join-pending', ({ name }) => { $('status').textContent = `Waiting for ${name} to accept…`; });
  mp.on('join-declined', ({ name }) => { declineMessage = `${name} declined`; $('status').textContent = declineMessage; say(declineMessage); });
  mp.on('join-request', request => { if (mp.isHost) { pending.set(request.id, request); showRequests(); } });
  mp.on('join-resolved', ({ id }) => { pending.delete(id); showRequests(); });
  mp.on('connected', () => { listing.close(); if (mp.isHost) $('anyone').checked = false; });
  $('world').addEventListener('change', e => { if (e.target.id === 'mp-bump') world.setBump(e.target.value === 'on'); else world.setMode(e.target.value); render(); });
  $('leave').addEventListener('click', () => { world.restore(); mp.leave(); render(); });
  mp.on('joined', ({ player }) => { if (player.id !== mp.me.id) say(`${player.name} joined`); render(); });
  mp.on('left', ({ id }) => { say(`${names.get(id)?.name || 'A player'} left`); render(); });
  mp.on('kicked', () => { say('You were removed'); render(); });
  mp.on('closed', ({ reason }) => { say(reason === 'full' ? 'This game is full' : reason === 'no-host' ? 'This game is no longer available' : reason === 'host-left' ? 'The host left — game over' : 'Could not join this game'); render(); });
  mp.on('disconnected', () => { if (!panel.hidden) listing.open(); });
  for (const event of ['connected', 'disconnected', 'roster', 'world']) mp.on(event, render);
  render();
  return { world, open: () => button.click() };
}
