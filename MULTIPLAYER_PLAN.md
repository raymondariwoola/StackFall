# StackFall Two-Player Multiplayer Plan

Status: implementation in progress · Prepared: 2026-07-25 · Phases 0–2
completed: 2026-07-25

## Decision

Build a **live two-player Duel mode** on the infrastructure StackFall already
uses:

- Keep the static game on GitHub Pages.
- Extend the existing Cloudflare Worker.
- Add one SQLite-backed Durable Object per match.
- Use hibernating WebSockets for room events.
- Keep each player's actual tower simulation local.
- Synchronize only lobby state, the start time, progress after each landing,
  disconnects, and results.

This is the smallest, cheapest design that still feels live. It needs no
accounts, database server, always-running process, paid game service, or
infrastructure migration.

The expected hosting cost is **$0 for family-and-friends usage**, provided the
Cloudflare free-plan limits are not exceeded. Free-plan Durable Object
operations fail after their limits rather than turning into an unexpected bill.

## What Is in the Repository Today

StackFall is a small, no-build web game with a clean separation of concerns:

| Area | Current implementation | Multiplayer consequence |
|---|---|---|
| Hosting | Static files; repository configuration points to GitHub Pages | Keep it. Multiplayer does not require moving the website. |
| Game loop | `js/main.js` owns mode, input, start/end flow, and the RAF loop | Add Duel as an explicit run context, not another overloaded leaderboard mode. |
| Rules | `js/game.js` is render-free and already accepts a seed | Reuse it for two local simulations using one server-issued seed. |
| Randomness | `js/rng.js` provides seeded RNG; Hardcore events use it | Both players can receive the same direction, gust, spike, quake, and blackout sequence. |
| Rendering | `js/renderer.js` paints one local tower | Do not render or stream the opponent's full tower; show a compact progress HUD. |
| UI | `js/ui.js` owns the title/game-over DOM | Add a focused Duel lobby/result overlay rather than continuing to enlarge the existing panel. |
| Local identity | A display name is stored in `localStorage` | Reuse the name, but treat it as a label rather than an authenticated identity. |
| Backend | One Cloudflare Worker with KV rate limiting and a SQLite-backed leaderboard Durable Object | Add a separate `MatchRoom` Durable Object class to the same Worker. |
| Sharing | Native Web Share, clipboard, and generated score cards already exist | Reuse the Web Share path for WhatsApp and add Copy Link / Copy Code actions. |

Important existing constraints:

- This review covers the committed repository. Before implementation, verify
  the live GitHub Pages source, deployed Worker version, bindings, secrets, and
  usage dashboard rather than assuming they exactly match the checked-in files.
- The game has Normal, Hardcore, Daily, Endless, and Practice behavior.
- A run's seed and difficulty are captured at start, which is a good multiplayer
  seam.
- The current simulation is deterministic in its seeded event schedule, but not
  a byte-for-byte replay: animation advances from each device's frame timing and
  viewport width. That is acceptable for a friendly live race because each
  player controls their own tower. It must be described as a **shared challenge
  seed**, not identical physics playback.
- Rotation/resizing during a run does not rescale the existing tower. This
  should be fixed before Duel is called complete.
- Pause, settings, tab backgrounding, and the hidden cheat menu need Duel-specific
  rules.
- There is no committed automated test suite or CI workflow.
- Documentation has some drift: the README describes Cloudflare Pages while
  the CORS/audit configuration points at GitHub Pages; the audit says cheated
  scores are blocked while `wrangler.toml` currently sets `BLOCK_CHEATED = "0"`.
  Duel must enforce its own cheat rule rather than relying on leaderboard
  configuration.

## Player Experience

### Create and share

1. On the title screen, the host taps **Challenge a Friend**.
2. The host chooses Normal or Hardcore and creates a room.
3. StackFall displays:
   - a shareable link such as
     `https://raymondariwoola.github.io/StackFall/?duel=7KMX-R4QP`;
   - the short code `7KMX-R4QP`;
   - **Share**, **Copy Link**, and **Copy Code** buttons.
4. **Share** uses the existing native share sheet. On a phone, the host can
   select WhatsApp without StackFall needing WhatsApp access or contact data.

### Join

The guest can either:

- open the challenge link and arrive directly in the room; or
- open StackFall, tap **Join Duel**, and type the code.

The existing saved display name is prefilled. A first-time guest enters only a
temporary display name—there is no account or profile creation.

### Play

1. The lobby shows both names, connection state, difficulty, and room expiry.
2. Each player taps **Ready**.
3. The server sends one seed and an absolute start timestamp.
4. Both clients show a `3…2…1…STACK!` countdown and start locally.
5. During play, a small opponent strip shows:
   - name and connection state;
   - score and floors;
   - alive / finished status;
   - a simple height bar.
6. Progress is sent only after a resolved landing, not on every frame.
7. If one player falls, the other continues until they fall or beat the finished
   player's result.
8. The result overlay shows winner/draw, both results, **Rematch**, and
   **Challenge Someone Else**.

Winner comparison should be:

1. higher score;
2. then more floors;
3. then more perfect drops;
4. then higher maximum combo;
5. otherwise a draw.

Do not use completion time as a tiebreaker. Patient timing is part of StackFall,
and network/device speed should not decide a duel.

## Recommended Architecture

```text
Host browser ──┐
               ├── HTTPS / WebSocket ── existing Cloudflare Worker
Guest browser ─┘                              │
                                             ├── Leaderboard DO (existing)
                                             └── MatchRoom DO (one per code)

Both browsers run Game locally with:
same seed + same difficulty + independent taps
```

### Why not stream the game state?

Sending block positions every animation frame would cost more, introduce visible
jitter, make mobile backgrounding harder, and allow network latency to affect
gameplay. StackFall only needs the opponent's milestones to feel competitive.
One message per landing keeps the protocol cheap and robust.

### Room code and capabilities

- Use eight characters of Crockford Base32, grouped `XXXX-XXXX`. It avoids
  ambiguous characters and provides enough space for this private use.
- Derive the Durable Object instance from the normalized code with
  `idFromName(code)`.
- Atomically initialize the room; if the generated code already has a live
  room, generate another.
- The code is the guest invitation capability. The first accepted guest gets
  the second seat; further joiners are rejected as `room_full`.
- Return a separate random host token and guest player token. Store only token
  hashes in Durable Object storage.
- Keep tokens in `sessionStorage`, keyed by room code, so refresh/reconnect works
  without creating a persistent account.
- Do not put player tokens in the challenge link. For WebSocket authentication,
  exchange the player token for a short-lived, one-use socket ticket; put only
  that ticket in the WebSocket URL.

### HTTP surface

Suggested routes:

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/matches` | Create room; return code, host token, and expiry |
| `POST` | `/matches/:code/join` | Claim guest seat; return player token |
| `GET` | `/matches/:code` | Read safe lobby state; never return tokens |
| `POST` | `/matches/:code/socket-ticket` | Exchange player token for a short-lived one-use ticket |
| `GET` | `/matches/:code/socket?ticket=…` | Upgrade to the room's WebSocket |

The website should construct the share URL from its own `location` plus the room
code. The Worker should not guess the site's public URL.

### Room state machine

```text
WAITING ── both ready ──> COUNTDOWN ── startAt ──> PLAYING
   │                                                 │
   ├── expiry ──> EXPIRED                            ├── both finish ──> FINISHED
   └── host cancel ──> CANCELLED                     └── grace expires ──> FORFEIT

FINISHED ── both request rematch ──> COUNTDOWN with a new seed
```

Persist only compact match state:

- protocol version, room code, state, round, difficulty;
- timestamps and expiry;
- seed and scheduled start time;
- two seat records: display name, token hash, ready/connected state;
- latest validated sequence number, score, floors, perfects, max combo, and
  finish/forfeit state;
- final winner and reason.

Every client message carries a monotonically increasing `seq`. Ignore duplicates
and reject impossible regressions such as lower floors or a second finish.

### WebSocket messages

Client to server:

- `ready`
- `progress` after a landing
- `finish`
- `heartbeat`
- `rematch_vote`
- `leave`

Server to clients:

- `snapshot` on connect/reconnect
- `player_joined`
- `presence`
- `countdown`
- `opponent_progress`
- `opponent_finished`
- `result`
- `expired`
- `error`

Version the envelope from day one, for example
`{ "v": 1, "type": "progress", "seq": 12, "payload": { ... } }`.

### Durable Object implementation

Add a second binding and migration in `worker/wrangler.toml`:

- existing class: `Leaderboard`;
- new SQLite-backed class: `MatchRoom`;
- new migration tag: `v2`.

Use Cloudflare's WebSocket Hibernation API:

- `acceptWebSocket()` rather than the standard `accept()`;
- serialize only the seat/session identity as the socket attachment;
- restore authoritative room state from storage after hibernation;
- never keep `setInterval` or a long `setTimeout` inside the room.

Use one Durable Object alarm for the nearest deadline: waiting-room expiry,
countdown boundary if needed, disconnect grace, active-match timeout, or
finished-room cleanup. On final expiry, close sockets, call `deleteAlarm()`, and
then `deleteAll()`. The current compatibility date predates newer cleanup
behavior, so cleanup should be explicit unless a compatibility-date upgrade is
tested separately.

Recommended lifetime:

- waiting room: 2 hours;
- active duel: 20 minutes maximum;
- disconnected player grace: 30 seconds;
- finished room/rematch window: 15 minutes;
- then permanent deletion.

## Fairness, Trust, and Abuse Boundaries

This is anonymous friendly multiplayer, not an esports authority.

For the first release:

- the server owns room membership, difficulty, seed, countdown, lifecycle, and
  final comparison;
- clients report their own progress and results;
- Duel clears all cheat state before start, disables opening the cheat menu,
  and rejects/forfeits any result marked `cheated`;
- disable manual Pause and Settings during active Duel play;
- backgrounding or connection loss starts a 30-second grace period, then becomes
  a forfeit;
- validate message type, size, field ranges, state transition, sequence, and
  per-socket rate;
- reuse KV only for coarse per-IP create/join rate limits, never for live match
  progress;
- validate the WebSocket `Origin` against the same explicit site allowlist;
- log lifecycle/error codes, not names, tokens, or complete payloads.

This prevents accidents and casual tampering, but a determined person can still
modify the browser code and forge a plausible result. That tradeoff is suitable
for family and friends.

If stronger trust is later wanted, record a compact landing replay
(`floor`, normalized drop position, event sequence) and validate it against a
fixed-step, normalized rules engine in the Worker. Do not make that complexity
an MVP dependency.

## Cost and Infrastructure

### Recommended: stay on Cloudflare

As checked on 2026-07-25, the relevant Workers Free allowances include:

- 100,000 Worker requests per day;
- 100,000 Durable Object requests per day;
- 13,000 GB-seconds of Durable Object duration per day;
- 5 million SQLite rows read and 100,000 rows written per day;
- 5 GB total SQLite-backed Durable Object storage.

For Durable Objects, incoming WebSocket messages receive a 20:1 billing ratio,
outgoing messages are not request-billed, and hibernating sockets do not accrue
idle duration. See the official
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
and [WebSocket hibernation guide](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

A typical two-player match should use only a handful of HTTP/connection
requests, compact state writes at transitions/landings, and tens of inbound
WebSocket messages. This is negligible at the intended scale. Add a simple
dashboard check and an emergency `MULTIPLAYER_ENABLED = "0"` Worker variable so
rooms can be disabled without taking the leaderboard down.

### Alternatives if Cloudflare ever becomes unsuitable

| Option | Free capacity | Tradeoff | Verdict |
|---|---|---|---|
| [Supabase Realtime](https://supabase.com/docs/guides/platform/billing-on-supabase) | 2 million messages/month and 200 peak connections on Free | New SDK, project, database policies, and free projects pause after inactivity | Good fallback, unnecessary now |
| [Firebase Realtime Database](https://firebase.google.com/pricing) | Spark includes 100 simultaneous connections, 1 GB stored, and 10 GB/month downloaded | New vendor/data model and client security rules | Viable fallback, unnecessary now |
| Direct WebRTC | Media/data can be peer-to-peer | Still needs signaling; NAT/reconnect behavior adds complexity; TURN can cost money | Poor fit for a two-player score race |
| Self-hosted Node/WebSocket server | Full control | Requires an always-on host, maintenance, monitoring, and likely payment | Reject for this side project |

Do not move the static site to Cloudflare Pages solely for multiplayer. It
would not reduce the required Worker/Durable Object work.

## Phased Implementation

### Phase 0 — Contracts and Test Foundation — ✅ Complete (2026-07-25)

Goal: make the current single-player behavior safe to extend.

Work:

- reconcile README/deployment/config drift;
- write the versioned room and message schemas as code-level constants;
- introduce a `RunContext` for `single`, `daily`, `practice`, and `duel` rather
  than adding more loosely related globals in `main.js`;
- add a dedicated `onProgress` callback from `Game`;
- make active-run resize scale normalized horizontal geometry or pause/reflow
  cleanly;
- add a minimal automated harness for rules, room state transitions, and Worker
  request validation;
- add syntax/test CI.

Acceptance gate:

- existing modes behave unchanged;
- seeded Hardcore schedules remain stable;
- resizing no longer corrupts an active tower;
- all tests run from one documented command.

Result:

- added an immutable `RunContext` seam with explicit future Duel support;
- added the shared version-1 room/message/request contract and room lifecycle;
- added one neutral `Game.onProgress` event per resolved landing;
- added proportional horizontal reflow for active-run viewport changes;
- extracted testable Worker validation helpers without changing its API;
- added `npm test` and GitHub Actions validation;
- added 15 passing behavior tests, including seeded Hardcore stability and
  active-run resize geometry;
- completed a local browser smoke test of tutorial, name gate, mode cycling,
  Practice start, active gameplay UI, and remote-board loading with no
  application console errors;
- reconciled the README with GitHub Pages, Durable Object storage, current test
  instructions, and the intended `BLOCK_CHEATED = "1"` source configuration.

No Cloudflare or GitHub dashboard action was required for this phase. The
`BLOCK_CHEATED` source correction takes effect only on a later Worker deploy.

### Phase 1 — Room Backend — ✅ Complete (2026-07-25)

Goal: create, join, reconnect to, and expire a two-seat room without touching
gameplay UI.

Work:

- add `MatchRoom`, Wrangler binding, and `v2` migration;
- implement room code generation, host/guest capabilities, safe public state,
  ticketed socket upgrades, state transitions, and alarms;
- implement hibernatable WebSockets and snapshot replay after wake/reconnect;
- add create/join/message rate limits and Origin validation;
- add automated tests for collision, room full, invalid/expired code, duplicate
  messages, unauthorized actions, disconnect grace, rematch, and cleanup.

Acceptance gate:

- two browser/CLI clients exchange ordered events through one room;
- a refreshed client reclaims its seat;
- a third client cannot join;
- expired room storage is deleted;
- leaderboard endpoints remain unchanged.

Result:

- added a dedicated SQLite-backed `MatchRoom` Durable Object, `MATCH_ROOM`
  binding, and declarative `v2` Wrangler migration without changing the
  existing `Leaderboard` binding;
- implemented anonymous create/read/join routes, hashed host/guest capability
  tokens, short-lived one-use socket tickets, and safe public snapshots;
- implemented the version-1 room lifecycle across waiting, countdown, playing,
  finished, forfeit, cancelled, rematch, disconnect grace, and expiry;
- used hibernatable WebSockets with serialized seat/rate metadata, reconnect
  replacement, ordered sequence validation, progress bounds, and alarms for
  the nearest lifecycle deadline;
- added explicit origin validation, KV-backed per-IP create/join limits, a
  per-socket message limit, the `MULTIPLAYER_ENABLED` kill switch, and explicit
  alarm/storage cleanup for the current compatibility date;
- expanded the root suite to 29 passing tests covering code validation,
  collisions, room capacity, authorization, ticket hashing, duplicate and
  regressing messages, message bursts, results, cheating, disconnect grace,
  rematches, reconciliation, and permanent cleanup;
- passed a Wrangler bundle dry run and a real local integration test using two
  WebSocket clients through create, join, ticket exchange, reconnect/seat
  replacement, countdown, progress, finish, and result; the same test verified
  that a one-use ticket cannot be replayed;
- preserved the existing leaderboard validation suite and API behavior.

No production Worker was deployed in this phase. No Cloudflare dashboard work
is needed yet. When a shared online test is desired, the repository owner must
authorize Wrangler (if the local session is not already logged in) and approve
`npx wrangler deploy`; that deploy applies the `v2` Durable Object migration.

### Phase 2 — Challenge and Lobby UX — ✅ Complete (2026-07-25)

Goal: complete the no-account invitation flow.

Work:

- add **Challenge a Friend** and **Join Duel** entry points;
- add `js/multiplayer.js` for transport/session/reconnect logic;
- add `js/duel-ui.js` for create, code entry, waiting, ready, and error states;
- parse `?duel=CODE` at boot and route directly to the lobby;
- reuse the saved local name, with a temporary-name prompt when absent;
- add native Share, Copy Link, and Copy Code;
- show clear states for invalid, expired, full, cancelled, and offline rooms.

Acceptance gate:

- a host can share through the phone share sheet to WhatsApp;
- a guest can join by either link or typed code;
- no account, email, phone number, or personal contact permission is requested;
- Back/refresh/reconnect behavior is predictable on mobile.

Result:

- added distinct **Challenge a Friend** and **Join Duel** title actions plus a
  compact, keyboard-accessible join/lobby/error overlay;
- added `js/multiplayer.js` for create/read/join requests, capability sessions,
  one-use ticket exchange, ordered socket messages, reconnect backoff, and
  authoritative leave acknowledgement;
- added `js/duel-ui.js` for normalized code entry, two-seat presence/readiness,
  difficulty, sharing, busy states, and clear invalid, expired, full,
  cancelled, offline, replaced-seat, and unavailable-service outcomes;
- challenge URLs use only `?duel=XXXX-XXXX`; private host/guest capabilities
  remain scoped to `sessionStorage` and never enter history or shared links;
- direct links reclaim an owned seat after refresh, otherwise open the guest
  name/code flow; manual Back closes without abandoning the recoverable session,
  and Forward/reopening the link reconnects it;
- Share Invite uses the native Web Share API when available (so installed apps
  such as WhatsApp appear through the operating-system share sheet), with
  clipboard and manual-copy fallbacks; Copy Link and Copy Code are separate;
- localhost pages resolve Duel traffic to the local Wrangler port while
  production continues to use the configured deployed Worker URL;
- expanded the root suite to 37 passing tests, including session secrecy,
  URL construction, ticket exchange, sequencing, reconnect replacement,
  leave acknowledgement, lobby readiness, and user-facing error states;
- completed real-browser validation against local Wrangler with isolated host,
  link-guest, code-guest, and third-player tabs. It covered both join paths,
  room-full handling, synchronized Ready, invite copying, refresh/Forward seat
  recovery, Back dismissal under late socket events, and host cancellation.

Phase 2 intentionally stops at the server countdown handoff. The overlay keeps
that synchronized state visible; Phase 3 will start the seeded game and send
live progress. No Worker or website deployment occurred. A physical phone's
WhatsApp destination remains a short real-device confirmation once Phases 2–3
are deployed together; the native share invocation and non-share fallbacks are
implemented and browser-tested.

### Phase 3 — Live Duel Gameplay (MVP)

Goal: ship an enjoyable one-round live duel.

Work:

- lock difficulty and server seed into Duel's `RunContext`;
- implement ready check and server-time-based countdown;
- clear/disable cheats and disable Pause/Settings while the duel is active;
- send progress after each landing and final stats on game over;
- add the opponent HUD and accessible announcements;
- implement result comparison, early “win secured,” rematch voting, and forfeit;
- retain local personal run history but keep Duel off the existing global/daily
  leaderboards unless a separate Duel history is deliberately added.

Acceptance gate:

- two real phones can join from a WhatsApp link and start within the same
  countdown;
- both receive the same seed/difficulty;
- normal play remains smooth with no per-frame network traffic;
- win, loss, draw, disconnect, reconnect, forfeit, and rematch are correct;
- single-player modes and leaderboard submission still work.

**MVP is complete at the end of Phase 3.**

### Phase 4 — Hardening and Cost Guardrails

Goal: make the MVP safe to leave online unattended.

Work:

- add two-browser Playwright coverage plus real-device background/resume tests;
- test slow network, duplicate/out-of-order messages, Worker restart/hibernation,
  UTC changes, room expiry, and mobile rotation;
- add bounded payload sizes, rate telemetry, structured error codes, and the
  multiplayer kill switch;
- document deploy, rollback, migrations, log inspection, and free-quota checks;
- update the application audit and README after production validation.

Acceptance gate:

- no room retains storage after its cleanup deadline;
- no token or player name appears in logs or shared URLs;
- a failed multiplayer deploy can be disabled without affecting local play or
  leaderboards;
- observed test usage is comfortably inside the free tier.

### Phase 5 — Optional “Beat My Tower” Challenge

Goal: let friends compete even when they cannot be online together.

The host plays a seeded run first, then shares a seven-day challenge link. The
guest plays the same seed once and the room reveals both results. This can reuse
the room code, seed, result comparison, sharing, and cleanup work, but it does
not require both sockets to be connected at once.

Keep this out of the live-Duel MVP. It is an excellent later addition because
WhatsApp challenges are often answered hours later, but mixing live and
asynchronous lifecycle rules too early would slow down delivery.

## Suggested File Shape

```text
js/
  main.js                 # integrates RunContext; remains app coordinator
  run-context.js          # selected settings + immutable active snapshot
  game.js                 # adds neutral progress callback
  multiplayer.js          # HTTP/WebSocket client, tickets, reconnect
  duel-ui.js              # challenge, join, lobby, opponent HUD, result
  storage.js              # room-scoped session helpers only
shared/
  duel-protocol.js        # versioned browser/Worker validation + state contract
worker/
  src/index.js            # route dispatch, existing leaderboard unchanged
  src/match-room.js       # MatchRoom Durable Object
  src/match-protocol.js   # validation and pure state transitions
  wrangler.toml           # MatchRoom binding + v2 migration + kill switch
tests/
  game/
  worker/
  e2e/
```

Splitting the Worker during Phase 1 is worthwhile: `worker/src/index.js` is
already responsible for leaderboards, cheating, admin routes, CORS, storage,
and rate limiting. Multiplayer should not turn it into one monolithic file.

## Final Recommendation

Implement Phases 0–3 on the current stack and treat Phase 4 as the release gate.
Do not add authentication, a general-purpose database, or server-authoritative
physics for the first family-and-friends release.

The key product choice is to make Duel a **shared-seed live race**, not a
frame-synchronized physics game. That choice preserves StackFall's responsive
local controls, uses the architecture already present, works naturally with
WhatsApp links and room codes, and keeps the ongoing cost at zero for the
intended audience.
