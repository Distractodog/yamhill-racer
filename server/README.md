# Multiplayer relay

The relay is separate from the static GitHub Pages game. It forwards JSON messages,
keeps the roster and latest host world settings, and runs no game physics.
`relay.mjs` is shared by both transports and has no socket or platform imports.

## Local stand-in

From the repository root (Node 18 or newer):

```sh
npm install
node server/local.mjs          # or: node server/local.mjs <port>
```

Connect to `ws://127.0.0.1:8787/room/ABCDE?id=<12-character-player-id>` (the port argument changes 8787).
Browser scripts read the relay from `YR_MP_RELAY` and the game from `YR_URL`.
The first client must send the contract's `hello` with `host:true` and `code:ABCDE`.
Guests send `join-request` with `host:false`, then wait for host approval. The server listens on loopback only. `ws` is now a direct
devDependency (it was previously only a transitive dependency).

The client defaults to this relay. An HTTPS game page needs a secure `wss://`
relay, so use the deployed Worker for the published game.

## Deploy on Cloudflare (director)

Create/sign in to a Cloudflare account with Workers enabled. From the repository
root, run:

```sh
npx wrangler login
npx wrangler deploy --config server/wrangler.toml
```

Wrangler creates the `ROOMS` Durable Object binding and the SQLite-backed
`RelayRoom` namespace using migration `v1`. Migration `v3` adds the `LOBBY` binding and shared SQLite-backed `Lobby` namespace. Keep that migration for subsequent
deploys. Migration `v2` adds the separate SQLite-backed `Stats` namespace and
`STATS` binding; keep all three migrations. Set the private stats key before deploying:

```sh
npx wrangler secret put STATS_KEY --config server/wrangler.toml
npx wrangler deploy --config server/wrangler.toml
```

Enter a long random secret at the prompt; never put it in source, shell arguments,
or a committed URL. The director runs these commands; no manual database provisioning
is needed. To inspect logs:

```sh
npx wrangler tail --config server/wrangler.toml
```

The relay is deployed at **`wss://yamhill-racer-relay.yamhill-racer.workers.dev`**.

Which relay the game uses (`defaultRelay()` in `game/src/mp/net.js`):
1. `window.YR_MP_RELAY`, if set **before the game's modules load** (browser test scripts do this);
2. else a `?relay=ws(s)://…` query on the page URL, for testing, e.g.
   `http://127.0.0.1:8173/?relay=wss://yamhill-racer-relay.yamhill-racer.workers.dev`;
3. else `ws://127.0.0.1:8787` (the local stand-in) when the page is served from `127.0.0.1` or `localhost`,
   and the deployed relay above everywhere else.

The client appends `/room/<hostCode>?id=<playerId>`. Each room code routes to its own
Durable Object. This worker does not serve or deploy `game/`.

SQLite-backed Durable Objects are supported on the Workers Free plan. Free usage
has quotas; active state traffic consumes requests and compute, so a busy relay
can exhaust the daily allowance. Check the current [Cloudflare pricing and free
allowances](https://developers.cloudflare.com/durable-objects/platform/pricing/)
before inviting many players. No paid plan is required by this configuration.

The adapter uses `acceptWebSocket`, `webSocketMessage`, `webSocketClose`, and
`webSocketError`, without timers or socket event listeners that prevent
hibernation. Session attachments retain player/skin and rate-limit timestamps;
Durable Object storage retains the latest world settings. The constructor restores
both when waking. Host departure clears membership and stored world settings.
See [Cloudflare's hibernation API guide](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

## Behavior and limits

- Up to 16 admitted players including the host; at most 64 total sockets per room.
- Hosts send `hello`; guests send `join-request`. A guest without a host receives
  `{t:'closed',reason:'no-host'}`. Pending guests receive no game traffic. The host
  receives `{t:'join-request',id,name,expires}` and sends `join-accept` or
  `join-decline` with that `id`. Approval sends the same roster/world/layout as an
  ordinary join. Requests auto-decline after 30 seconds through a DO alarm.
- `GET /lobby` returns `{games:[{id,name,players,max,created,anyone}]}` with CORS and
  no-cache headers. The menu polls every 5 seconds while open. Hosts register through
  their room and send `heartbeat` every 10 seconds; listings expire after 30 seconds
  without an update and are removed when the host leaves. Internal room IDs are never
  shown in the UI. `room.info` exposes `id` and admitted `players` for analytics.
- Only the host may send `join-policy` with boolean `anyone` (default false). Open
  joining still observes capacity and rate limits. The shared Lobby permits one
  pending request per player ID across all rooms, and 5 attempts per rolling minute;
  disconnect/decline/accept releases the pending lease, not the rate history.
  These limits use the browser's persistent random player ID, not authenticated accounts.
- Pending requests and host policy survive hibernation in socket attachments; the
  global list and admission budgets survive in Lobby storage. The local relay uses
  the same rules with an in-memory lobby and expiry timer.
- Joins notify existing members with `joined`; roster updates go to everyone on
  join, leave, and skin changes. A late joiner's stored `world` follows its roster.
- `state` and `skin` go to peers; race messages and host `world` go to everyone,
  including their sender. The relay replaces `from` and `srvT` on forwarded frames.
- State frames are accepted no more often than once per 25 ms per sender (40 Hz).
  Excess state frames are silently dropped; ping/control traffic is independent.
- Only the host can publish world settings or kick a guest. A kick sends `kicked`,
  closes the target, and updates the remaining roster. Kicks remove the current
  connection; they are not permanent bans. A host cannot kick itself.
- Host departure ends the room for every guest (`reason:'host-left'`). A new host
  may subsequently reuse that room code with no old world settings.
- JSON frames are capped at 16 KiB, names at 128 characters, and skin JSON at 1 KiB
  UTF-8 to fit Cloudflare's 2 KiB session attachment limit. Malformed/unknown frames
  are ignored. Names are passed through without a name filter.
- Internal room IDs are routing identifiers, not authentication. The first valid host hello
  claims an empty room. There are no accounts, passwords, origin restrictions,
  chat, persistent kick bans, or server-side race adjudication.

## Checks

```sh
node --test server/relay.test.mjs server/lobby.test.mjs server/local.test.mjs
node tools/mp_e2e_test.mjs
# local.test.mjs starts and stops its own relay on an ephemeral loopback port.
node --check server/relay.mjs
node --check server/local.mjs
node --check server/worker.js
```

Tests use fake clients and storage, never bind ports, and cover room protocol,
Worker routing, and hibernation restoration. Deployment, actual socket upgrades,
and a two-browser game session still need the director's integration check.

## Private visitor statistics

Open `https://yamhill-racer-relay.yamhill-racer.workers.dev/stats?key=<SECRET>`
with the secret entered privately. Missing, wrong, or unconfigured keys return 404.
The HTML has no external resources, is not cached, and suppresses referrers. Keep
this URL private (it contains the key, including in your browser history).

The page has Today / 7 days / 30 days summaries, a 30-day visits/play-time SVG
chart and daily counters, newest-first sessions, and multiplayer game details.
All displayed dates and times use **America/Los_Angeles (Pacific, including DST)**.
Summary visitors are distinct browser hashes across the window; sessions and
visitors use the session's start date. Play minutes are credited on the day played,
including sessions crossing midnight. Average session length is elapsed time;
active minutes count time with the tab visible (including menus and loading).
Peak concurrency counts distinct browser visitors' overlapping visible intervals,
not duplicate tabs. Missing end reports use the last heartbeat, without adding a
grace period. These measurements are estimates, not abuse-proof traffic auditing.

On page load the game sends `start` to POST `/hit`, followed by a heartbeat every
60 seconds while visible, and `end` on visibility hidden or pagehide. Returning to
the tab resumes the same session; a new page load creates a new random session ID.
The client uses text/plain sendBeacon with credential-free keepalive fetch fallback.
It skips localhost, 127.0.0.1, IPv6 loopback and `?nostats` (also with other query
parameters). Analytics errors never prevent startup or multiplayer. Only the
GitHub Pages origin `https://distractodog.github.io` is accepted for client reports.
The local Node relay remains multiplayer-only. Existing Cloudflare Web Analytics
is separate and remains enabled.

Collected session data is deliberately limited:

- Random browser visitor ID (`yr-visitor-1`) and a per-load session ID, both hashed
  before storage. Visitor hashes are keyed with STATS_KEY so distinct visitors can
  be counted across the retained window; rotating the secret changes these hashes.
  No raw visitor/session IDs or multiplayer player IDs are stored in Stats.
- Server-received start, last heartbeat and end timestamps, elapsed duration,
  visible active milliseconds, and up to 256 visible intervals for concurrency.
- Country code from `request.cf.country` (`XX` when unavailable), browser time-zone
  offset in minutes west of UTC, coarse screen width class (small <768, medium
  <1440, large), and browser family (Chrome/Edge/Firefox/Safari/Other). Exact screen
  dimensions and full user agents are discarded. There are no IP addresses,
  cookies, paths, driving coordinates, chat messages, or precise locations stored.
- Vehicle families and types, cumulative races started/finished and gold/silver/
  bronze medals, builder usage, current graphics mode, multiplayer game IDs/codes,
  chosen/display nickname and maximum game population observed while present.
  Sampling and hooks collect vehicle/builder changes without per-frame traffic.
- Relay-sourced multiplayer games: unique random ID for each host lifetime (even
  when a room code is reused), host nickname, start/end/last report, peak players,
  and up to 64 player nicknames. Membership changes report immediately; ongoing
  room traffic refreshes at most once a minute. Missing room end uses last report.
  A game is counted once on first reaching two accepted players. Repeated hellos,
  guest churn and relay hibernation do not create extra games. Nicknames are HTML
  escaped on the private page. There are no accounts or additional personal data.

A daily Durable Object alarm purges data outside the **60-day** retention window,
including when nobody plays. Detail storage is capped at **2,000 sessions and
2,000 multiplayer games** globally, evicting oldest starts first; the page displays
up to 500 newest records per table. Caps can shorten the available history. Each
session retains at most 40 vehicle types and 32 multiplayer games. Daily visitor
storage accepts at most 10,000 distinct hashes and 30 starts/hits per visitor/day.
Daily counters are independent of detail caps; summary/detail-derived totals can
therefore differ from daily counters after eviction. Legacy page-load counters
remain visible, but pre-upgrade session details cannot be reconstructed; old UTC
counter keys are not migrated. Cumulative report sequence numbers prevent duplicate
or out-of-order beacons from overwriting newer session data. Request bodies are
stream-bounded at 8 KiB and only whitelisted fields reach storage.

Deploy the relay before publishing the game. No additional Durable Object binding
or migration is required for session stats; the combined lobby requires `v3`. The director should verify a published start,
a 60-second heartbeat, tab hide/show, a completed race and a two-browser game on
the private page. Also check with uBlock enabled. This worker did not deploy.

```sh
node --test server/relay.test.mjs server/stats.test.mjs tools/visits_test.mjs
node --check game/src/visits.js
node --check server/stats.mjs
# Standalone populated dashboard screenshots, desktop and mobile (director):
node tools/stats_shots.mjs --out /tmp/yr-stats-shots
```
