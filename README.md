# StackFall

A mobile-first, tap-to-drop stacking game. Land each floor cleanly to build
combos; overhang gets sliced off; miss entirely and the tower falls. Every 10
floors the world shifts palette, the speed ticks up, and the background pushes
up with parallax. Procedural audio, haptics, particle bursts, and a
tower-collapse game over give it arcade-grade juice.

It ships as **plain static files** (no build step) plus a **Cloudflare Worker**
for the deployed global leaderboard and synced daily challenge. Local play still
works when the Worker is unavailable.

```
StackFall/
├── index.html            # markup + font links
├── css/styles.css        # all styling
├── js/                   # ES modules (see below)
│   ├── main.js           # entry: boot, RAF loop, input
│   ├── run-context.js    # selected settings + immutable active-run snapshot
│   ├── config.js         # gameplay tunables + layout math
│   ├── palettes.js       # worlds (block colors + bg gradient)
│   ├── rng.js            # seedable RNG + daily-seed hashing
│   ├── game.js           # core rules/state
│   ├── renderer.js       # canvas drawing
│   ├── background.js     # morphing gradient + parallax
│   ├── effects.js        # particles/debris/pops/flash/shake
│   ├── audio.js          # procedural Web Audio
│   ├── haptics.js        # Vibration API
│   ├── storage.js        # localStorage (best/scores/name/mute)
│   ├── multiplayer.js    # Duel HTTP/WebSocket session + reconnect client
│   ├── beat-challenge.js # asynchronous seeded challenge client
│   ├── duel-gameplay.js  # pure Duel progress/countdown/result helpers
│   ├── duel-ui.js        # challenge, lobby, live HUD, and result presentation
│   ├── sharecard.js      # solo + multiplayer Canvas PNG result cards
│   ├── ui.js             # HUD + overlay DOM
│   └── leaderboard.js    # Worker client (set WORKER_URL here)
├── shared/               # versioned browser/Worker multiplayer contracts
├── tests/                # dependency-free Node test suite
├── e2e/                  # two-browser Playwright Duel coverage
├── package.json          # unit and browser validation commands
└── worker/               # Cloudflare Worker (boards, daily seed, Duel rooms)
    ├── src/index.js      # public router + leaderboard Durable Object
    ├── src/match-room.js # hibernating two-player room Durable Object
    ├── src/challenge-room.js # low-traffic asynchronous challenge Durable Object
    ├── integration/      # real HTTP/WebSocket local integration client
    ├── wrangler.toml
    └── package.json
```

---

## Run it locally

ES modules must be served over HTTP (browsers block `file://` module loads), so
**don't** just double-click `index.html`. From the repo root:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(or `npx serve` if you prefer Node). That's the full game — local best scores and
a locally-computed daily seed work with no backend at all.

### Run the validation suite

From the repository root:

```bash
npm ci
npm test
```

This runs JavaScript syntax checks plus the game, run-context, Duel-contract,
room-state, hardening, and Worker-validation tests.

The real two-browser suite also needs Chromium once:

```bash
npx playwright install chromium
npm run test:e2e
```

That command owns both local servers and runs isolated host/guest contexts for
both modes. It verifies live create/join, synchronized play, forfeit, rematch,
rotation and results, plus a time-separated Beat My Tower claim on the same seed
and unfinished-run exit cleanup. It shuts the servers down afterward.

### Run the real Worker integration test

Install the Worker's locked development dependencies once, then use two
terminals:

```bash
cd worker
npm ci
npm run dev -- --local --port 8788
```

```bash
cd worker
npm run test:integration
```

The integration client creates and joins a room, opens both WebSockets, reclaims
the host seat as a refreshed client, rejects ticket replay, completes a match,
starts a new-seed rematch, verifies a countdown forfeit, and completes the
delayed create/finish/claim/result lifecycle in the same run. It targets
`http://127.0.0.1:8788` by default; override that with
`STACKFALL_WORKER_URL` when deliberately testing another environment.

### Try a live Duel locally

Start the Worker as above, then run the same-origin Duel development server from
the repository root:

```bash
npm run dev:duel
# open http://127.0.0.1:8137/
```

The development server serves the static game and proxies `/matches`,
`/challenges`, and the live WebSocket upgrade to `http://127.0.0.1:8788`.
Deployed pages continue to use the configured Worker directly.
Choose **Challenge a Friend**, then open the generated link in another tab or
choose **Join Duel** and enter its code. Each tab keeps only its own private seat
capability in `sessionStorage`, so a refresh can reclaim that seat without an
account. Ready up in both tabs: they receive the same seed and server-time
countdown, then play independently while the compact race HUD updates after
each landing. Finish both towers to see the authoritative result, vote for a
rematch from both result panels, or use **Forfeit** during a live round.
Score-based results use escalating rivalry copy: close finishes stay playful,
while decisive gaps earn progressively harsher winner and loser taunts.
Every completed Duel or Beat My Tower result also offers **Share Result** and
**Save Image**. StackFall renders a 1080×1350 portrait PNG locally with the
taunt, both names/scores/floors, difficulty, and round. Phones attach it to the
native share sheet for WhatsApp, email, Messages, or a gallery/files action;
browsers without image sharing download the PNG instead. The card and share
text contain no room capability or finished challenge code.

For an asynchronous challenge, choose **Beat My Tower · Play Later**, finish
your seeded tower, then share the generated seven-day link. The first friend to
claim it plays the same seed whenever convenient; no tab or socket needs to stay
open while you wait.

---

## Deploy so other people can play

There are two parts. **Part A alone makes the game publicly playable.** Part B/C
add the shared global leaderboard and synced daily board. All of this fits in
Cloudflare's free tier.

### Part A — Put the game on the internet (required)

The committed deployment configuration uses **GitHub Pages** at the project
path `/StackFall/`.

1. GitHub repository → **Settings** → **Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Select `main` and `/(root)`, then save.
4. The site is available at
   `https://raymondariwoola.github.io/StackFall/` after GitHub finishes the
   deployment.

Cloudflare Pages remains a valid alternative, but moving the static site is not
required for the planned multiplayer work. If the public origin changes, update
the Worker's `ALLOW_ORIGIN` before deploying.

> At this point the game is live. Scores are stored per-device and the daily
> board is computed locally. Do Part B/C only if you want a **shared** leaderboard.

### Part B — Deploy the backend Worker (optional)

```bash
cd worker
npm install                        # or use `npx wrangler@latest ...` below

npx wrangler login                 # opens a browser to authorize (one time)

# 1) Create the KV namespace that stores the boards:
npx wrangler kv namespace create LEADERBOARD
#    (older wrangler: `npx wrangler kv:namespace create LEADERBOARD`)
```

That command prints an `id`. **Copy it into `worker/wrangler.toml`**, replacing
the placeholder:

```toml
[[kv_namespaces]]
binding = "LEADERBOARD"
id = "paste-the-id-here"
```

Then deploy:

```bash
npx wrangler deploy
```

Wrangler also applies the committed SQLite Durable Object migrations. Migration
`v1` owns the leaderboard, `v2` adds live rooms, and `v3` adds delayed
`ChallengeRoom` objects; no separate database or dashboard database is required.

Wrangler prints your Worker URL, e.g.
`https://stackfall-lb.YOURNAME.workers.dev`. Sanity-check it in a browser:

```
https://stackfall-lb.YOURNAME.workers.dev/daily
→ {"seed":3550460695,"day":"2026-07-14"}
```

### Part C — Point the game at the Worker (optional)

1. Edit [`js/leaderboard.js`](js/leaderboard.js) and set the URL from Part B:
   ```js
   export const WORKER_URL = 'https://stackfall-lb.YOURNAME.workers.dev';
   ```
2. Keep CORS locked down: in `worker/wrangler.toml`, `ALLOW_ORIGIN` must include
   `https://raymondariwoola.github.io` (plus an explicit local origin when
   developing against the deployed Worker), then run `npx wrangler deploy`.
3. **Redeploy the site** (push to GitHub, or re-run the Part A command) so the
   edited `leaderboard.js` ships.

### Part D — Verify it's working

1. Open your Pages URL, type a name, play a round, and lose.
2. The panel's board flips from **"Your Best Runs"** to **"Global Top 20"** and
   your score appears. Toggle **Daily Board** on the title screen — everyone who
   plays that day gets the identical layout (great for "I got 47 on today's
   board, beat that").

Quick API smoke test from a terminal:
```bash
curl https://stackfall-lb.YOURNAME.workers.dev/leaderboard
curl https://stackfall-lb.YOURNAME.workers.dev/daily
```

---

## Worker API

| Method | Path                                  | Purpose / return |
|--------|---------------------------------------|------------------|
| GET    | `/`                                   | health / endpoint list |
| GET    | `/daily`                              | deterministic `{ seed, day }` |
| GET    | `/leaderboard`                        | all-time board |
| GET    | `/leaderboard?daily=1`                | daily board |
| POST   | `/score`                              | validate and record a score |
| POST   | `/cheat`                              | validate the cheat passphrase |
| POST   | `/matches`                            | create a room; returns host capability |
| GET    | `/matches/:code`                      | safe public room snapshot |
| POST   | `/matches/:code/join`                 | claim the guest seat; returns guest capability |
| POST   | `/matches/:code/socket-ticket`        | exchange a Bearer capability for a one-use ticket |
| GET    | `/matches/:code/socket`               | origin-checked WebSocket upgrade; one-use ticket is a subprotocol, not a URL |
| POST   | `/challenges`                          | create a two-hour Beat My Tower draft; returns host capability |
| GET    | `/challenges/:code`                    | safe public delayed-challenge state |
| POST   | `/challenges/:code/join`               | first guest claims the delayed challenge |
| POST   | `/challenges/:code/finish`             | capability-backed one-time final result |
| POST   | `/challenges/:code/cancel`             | host cancels an unfinished challenge |

`POST /score` body: `{ name, score, day, ts }` with an `X-Sig` header (the client
sets both automatically). The Worker sanitizes names, rejects implausible scores,
and stores the top 50 per board in the serialized `Leaderboard` Durable Object.
KV remains the rate-limit store and automatic leaderboard fallback.

Multiplayer capabilities are bearer secrets and are never returned by the
public room-state route. The browser client stores its own capability in
`sessionStorage`, exchanges it for a 60-second one-use socket ticket, and puts
that ticket in the WebSocket protocol header rather than a logged/shared URL.
Room codes use eight human-safe
characters displayed as `XXXX-XXXX`; the first guest claims the only open seat.

Beat My Tower uses the same safe code/name contract but its own HTTP-only room.
The host result opens the invitation; the first guest claims it and submits one
final. Both capabilities remain in `sessionStorage`, and the same seed is
public to both players. An abandoned host draft expires after two hours; when
the host finishes, the expiry resets and one alarm removes the challenge seven
days later whether it was claimed, completed, or left open.

### Duel operations and rollback

Before a production release, run `npm test`, `npm run test:e2e`, and the Worker
integration test above. Deploy from `worker/` with `npx wrangler deploy`; the
committed migrations are additive: `v1` creates `Leaderboard`, `v2` creates
`MatchRoom`, and `v3` creates `ChallengeRoom`. Do not remove or rename these
classes in a routine rollback.

Emergency multiplayer disable (single-player and leaderboards stay available):

1. Set `MULTIPLAYER_ENABLED = "0"` in `worker/wrangler.toml`.
2. Run `cd worker` then `npx wrangler deploy`.
3. Confirm `/` reports `multiplayer.enabled: false`, `/matches` returns
   `multiplayer_disabled`, and `/leaderboard` still succeeds.
4. Re-enable by restoring `"1"`, rerunning the validation gates, and deploying.

For a code-only Worker regression, `npx wrangler rollback` selects the previous
deployment. Cloudflare does not roll back bindings or Durable Object migrations,
so use the kill switch instead when the target version crosses a class lifecycle
change. Roll the static site back by reverting the responsible Git commit and
letting GitHub Pages redeploy it.

Inspect live events from `worker/` with `npx wrangler tail --format pretty`, or
use **Workers & Pages → stackfall-lb → Observability**. Custom events contain
only bounded event names, counters, error types, and rate-limit buckets—never
player names, capabilities, IP addresses, request URLs, or stack traces. Admin
credentials are accepted only through `X-Admin-Key`, never a query string:

```bash
curl -H "X-Admin-Key: YOUR_KEY" "https://YOUR_WORKER/admin/boards?days=7"
curl -X POST -H "X-Admin-Key: YOUR_KEY" "https://YOUR_WORKER/admin/reset"
```

After deployment, check Cloudflare **Workers & Pages → Metrics** and Durable
Objects usage after the first day and week. As of July 2026, Workers Free allows
SQLite-backed Durable Objects and lists 100,000 Durable Object requests/day,
13,000 GB-s/day, 5 million rows read/day, 100,000 rows written/day, and 5 GB
stored data. Limits can change; verify the official
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
before launch. StackFall hibernates idle sockets and sends live progress only on
landings plus a 15-second heartbeat, while Beat My Tower sends only a few HTTP
operations across seven days. Both paths are rate-limited and delete expired
storage, so family-and-friends use should remain far below those allowances.
The dashboard—not this estimate—is the production acceptance gate.

---

## Secret cheat menu

There's a hidden cheat menu, gated by a passphrase you control.

**Enable it** (otherwise it's off and the passphrase always fails):

```bash
cd worker
npx wrangler secret put CHEAT_CODE     # you'll be prompted to type the phrase
npx wrangler deploy
```

Using `wrangler secret` keeps the phrase out of the repo. (For local-only dev
with no Worker, the fallback phrase is `LOCAL_CHEAT_CODE` in
[`js/leaderboard.js`](js/leaderboard.js), default `iddqd`.)

**Open it:** on the title or game-over screen, tap the **“StackFall” title 5×**
quickly. During a live Duel or Beat My Tower run, tap the existing **“You”**
label in the multiplayer HUD 5×. The **`` ` ``** (backtick) key works on desktop
in either case. Enter the passphrase to reveal the menu.

**Cheats available:** Auto-Perfect, Easy Perfect Window, No Shrink, Invincible
(a miss won't end the run), Slow Motion (0.5×/0.25×), Score Multiplier
(2×/5×/10×), a Block-Speed override, and quick **+10 Floors / +100 pts** buttons.
A red **CHEATS ON** badge shows while any cheat is engaged.

- **Close** keeps your cheats on across runs; **Exit Cheats** turns everything
  off. The passphrase is remembered for the browser session, so you only enter
  it once. This includes Duel and Beat My Tower: cheats armed on the title
  screen remain active through the lobby and countdown, so Hardcore players do
  not need to reopen the menu after the timer starts.
- **Cheated runs are kept off the global board by default.** A run is flagged
  the moment any cheat is engaged; the client sends `cheated: true` on `/score`
  and the Worker skips the KV write. Flip it with the **`BLOCK_CHEATED`** var in
  `wrangler.toml` (`"1"` = block, default; `"0"` = allow cheated scores onto the
  global board). Cheated runs always still appear on the player's local
  **"Your Best Runs"** board.
- **Friend multiplayer deliberately treats cheat use as private local state.**
  Duel and Beat My Tower send the resulting score/progress but not the local
  `cheated` flag, so the opponent sees no cheat badge, warning, or special
  disqualification reason. The red badge and secret menu exist only on the
  passphrase owner's device. Unusually strong progress can still be inferred
  by a friend; this is a playful trust-model exception, not hidden cryptography.

## Share button

After each run the game-over panel shows **Share Score**, which opens the native
share sheet on mobile (`navigator.share`) or copies a "beat that" message + your
site URL to the clipboard on desktop. In **Daily** mode the text calls out
"today's board" to fuel the challenge loop.

Multiplayer results use their own portrait card described above. **Share
Result** prefers native PNG file sharing, while **Save Image** always downloads
the card so it can be kept or attached manually.

---

## Good to know

- **Free-tier limits change over time.** The current Worker uses SQLite-backed
  Durable Objects, which are supported on Workers Free. Check the official
  [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
  and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
  before a larger launch. Family-and-friends leaderboard and planned Duel usage
  should be comfortably inside the free allowances.
- **The signature is anti-spam, not anti-cheat.** The salt ships in client code,
  so it only deters trivial `curl` posting. Truly trustworthy scores need a
  server-authoritative model (replay/validate the run) and/or Cloudflare
  Turnstile. The `MAX_SCORE` cap in `wrangler.toml` is a crude sanity guard.
- **No secrets on the client** — the game needs no API keys; the Worker only
  holds a KV binding.
- **Custom domain** (optional): add one to the Pages project in the dashboard,
  then update `ALLOW_ORIGIN` to match.
