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
│   ├── ui.js             # HUD + overlay DOM
│   └── leaderboard.js    # Worker client (set WORKER_URL here)
├── shared/               # versioned browser/Worker multiplayer contracts
├── tests/                # dependency-free Node test suite
├── package.json          # one-command syntax + behavior validation
└── worker/               # Cloudflare Worker (boards, daily seed, Duel rooms)
    ├── src/index.js      # public router + leaderboard Durable Object
    ├── src/match-room.js # hibernating two-player room Durable Object
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
npm test
```

This runs JavaScript syntax checks plus the game, run-context, Duel-contract,
room-state, and Worker-validation tests. It installs no dependencies.

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
and verifies the result. It targets `http://127.0.0.1:8788` by default; override
that with `STACKFALL_WORKER_URL` when deliberately testing another environment.

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
`v1` owns the leaderboard and `v2` adds multiplayer rooms; no separate database
or Cloudflare dashboard resource is required for `MatchRoom`.

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
| GET    | `/matches/:code/socket?ticket=…`      | origin-checked WebSocket upgrade |

`POST /score` body: `{ name, score, day, ts }` with an `X-Sig` header (the client
sets both automatically). The Worker sanitizes names, rejects implausible scores,
and stores the top 50 per board in the serialized `Leaderboard` Durable Object.
KV remains the rate-limit store and automatic leaderboard fallback.

Multiplayer capabilities are bearer secrets and are never returned by the
public room-state route. The future browser client stores its own capability in
`sessionStorage`, exchanges it for a 60-second one-use socket ticket, and puts
only that ticket in the WebSocket URL. Room codes use eight human-safe
characters displayed as `XXXX-XXXX`; the first guest claims the only open seat.

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
quickly — or press the **`` ` ``** (backtick) key on desktop. Enter the
passphrase to reveal the menu.

**Cheats available:** Auto-Perfect, Easy Perfect Window, No Shrink, Invincible
(a miss won't end the run), Slow Motion (0.5×/0.25×), Score Multiplier
(2×/5×/10×), a Block-Speed override, and quick **+10 Floors / +100 pts** buttons.
A red **CHEATS ON** badge shows while any cheat is engaged.

- **Close** keeps your cheats on across runs; **Exit Cheats** turns everything
  off. The passphrase is remembered for the browser session, so you only enter
  it once.
- **Cheated runs are kept off the global board by default.** A run is flagged
  the moment any cheat is engaged; the client sends `cheated: true` on `/score`
  and the Worker skips the KV write. Flip it with the **`BLOCK_CHEATED`** var in
  `wrangler.toml` (`"1"` = block, default; `"0"` = allow cheated scores onto the
  global board). Cheated runs always still appear on the player's local
  **"Your Best Runs"** board.

## Share button

After each run the game-over panel shows **Share Score**, which opens the native
share sheet on mobile (`navigator.share`) or copies a "beat that" message + your
site URL to the clipboard on desktop. In **Daily** mode the text calls out
"today's board" to fuel the challenge loop.

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
