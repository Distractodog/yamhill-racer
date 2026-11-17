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
Guests send `host:false`. The server listens on loopback only. `ws` is now a direct
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
`RelayRoom` namespace using migration `v1`. Keep that migration for subsequent
deploys. Migration `v2` adds the separate SQLite-backed `Stats` namespace and
`STATS` binding; keep both migrations. Set the private stats key before deploying:

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

- Up to 16 connections, including the host and pending hello handshakes.
- Every client sends `hello` first. A guest without a host receives
  `{t:'closed',reason:'no-host'}`. Join acceptance is the first roster.
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
- Codes are discovery identifiers, not authentication. The first valid host hello
  claims an empty room. There are no accounts, passwords, origin restrictions,
  chat, persistent kick bans, or server-side race adjudication.

## Checks

```sh
node --test server/relay.test.mjs
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

The page shows 30 UTC days, totals for that window, and country counts by visits.
The unique total is **visitor-days**, not a distinct count across the whole month.
An MP game means an accepted host hello opening a room, including a room with no
guests; reconnecting as a new host counts again. Repeated hello, guest joins and
hibernation restoration do not increment it. Stats failures never reject MP messages.
The local Node relay intentionally remains a multiplayer-only stand-in.

The game sends one nonblocking POST `/hit` per page load with its own random
`yr-visitor-1` localStorage ID and pathname. It skips localhost, 127.0.0.1, IPv6
loopback, and any URL containing `?nostats` (also works alongside other parameters).
It uses a text/plain sendBeacon, falling back to credential-free keepalive fetch
if unavailable/refused. Storage and network failures are ignored. Existing Cloudflare
Web Analytics stays enabled.

Only the GitHub Pages origin `https://distractodog.github.io` is accepted for hits.
There are no cookies and no IP addresses stored by this implementation. The path
is validated then discarded. Visitor IDs are SHA-256 hashed with the UTC date
before storage; only daily hashes and hit counts persist. Cloudflare country codes
are aggregated; unavailable country is `XX`. At most 30 hits per visitor/day count.
To bound storage, each day accepts at most 10,000 distinct visitor hashes; further
new visitors that day are dropped, while already tracked visitors retain their
30-hit allowance. A daily Durable Object alarm deletes counters and hashes older
than the 35-day window even if no hits arrive. These are anonymous approximate
analytics, not abuse-proof traffic auditing: clearing storage creates a new ID.

Deploy the relay with migration `v2` before publishing the updated game. Then load
the published game once, check the private table increments, reload and check the
unique count stays fixed, and open a host room to check MP games increments. Test
with uBlock enabled. Workers Free request/storage quotas still apply; this uses
one shared Stats object and does no per-frame work. No live deploy was performed
by the worker implementing this feature.

```sh
node --test server/relay.test.mjs server/stats.test.mjs
node --check game/src/visits.js
node --check server/stats.mjs
```
