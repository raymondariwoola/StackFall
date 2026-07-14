# StackFall

A mobile-first, tap-to-drop stacking game. Land each floor cleanly to build
combos; overhang gets sliced off; miss entirely and the tower falls. Every 10
floors the world shifts palette, the speed ticks up, and the background pushes
up with parallax. Procedural audio, haptics, particle bursts, and a
tower-collapse game over give it arcade-grade juice.

It ships as **plain static files** (no build step) plus an **optional
Cloudflare Worker** for a global leaderboard and a synced daily challenge.

```
StackFall/
├── index.html            # markup + font links
├── css/styles.css        # all styling
├── js/                   # ES modules (see below)
│   ├── main.js           # entry: boot, RAF loop, input
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
└── worker/               # optional Cloudflare Worker (leaderboard + daily seed)
    ├── src/index.js
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

---

## Deploy so other people can play

There are two parts. **Part A alone makes the game publicly playable.** Part B/C
add the shared global leaderboard and synced daily board. All of this fits in
Cloudflare's free tier.

### Part A — Put the game on the internet (required)

Host the static files on **Cloudflare Pages**. Easiest path:

**Option 1 — Connect the GitHub repo (auto-deploys on every push):**
1. Push this repo to GitHub.
2. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** →
   **Connect to Git** → pick this repo.
3. Build settings: **Framework preset = None**, **Build command = (empty)**,
   **Build output directory = `/`**. Save & Deploy.
4. You get a URL like `https://stackfall.pages.dev`. Share it — people can play. ✅

**Option 2 — One-off from the CLI:**
```bash
npx wrangler login
npx wrangler pages deploy . --project-name stackfall
```

> At this point the game is live. Scores are stored per-device and the daily
> board is computed locally. Do Part B/C only if you want a **shared** leaderboard.

### Part B — Deploy the leaderboard Worker (optional)

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
2. (Recommended) Lock down CORS: in `worker/wrangler.toml` set
   `ALLOW_ORIGIN = "https://stackfall.pages.dev"` (your Pages URL), then
   `npx wrangler deploy` again.
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

| Method | Path                  | Returns                                             |
|--------|-----------------------|-----------------------------------------------------|
| GET    | `/`                   | health / endpoint list                              |
| GET    | `/daily`              | `{ seed, day }` — deterministic per UTC day          |
| GET    | `/leaderboard`        | `{ scope:"all", day, scores:[…20] }`                 |
| GET    | `/leaderboard?daily=1`| `{ scope:"daily", day, scores:[…20] }`               |
| POST   | `/score`              | `{ ok, rank, dailyRank, scores:[…20] }`              |

`POST /score` body: `{ name, score, day, ts }` with an `X-Sig` header (the client
sets both automatically). The Worker sanitizes names, rejects implausible scores,
and stores the top 50 per board in KV.

---

## Good to know

- **Free-tier limits:** Workers KV free tier allows ~1,000 writes/day and
  ~100k reads/day. Each game-over is 2 writes (all-time + daily). Plenty for a
  small launch; if it goes viral, move the boards to **Durable Objects** or **D1**.
- **The signature is anti-spam, not anti-cheat.** The salt ships in client code,
  so it only deters trivial `curl` posting. Truly trustworthy scores need a
  server-authoritative model (replay/validate the run) and/or Cloudflare
  Turnstile. The `MAX_SCORE` cap in `wrangler.toml` is a crude sanity guard.
- **No secrets on the client** — the game needs no API keys; the Worker only
  holds a KV binding.
- **Custom domain** (optional): add one to the Pages project in the dashboard,
  then update `ALLOW_ORIGIN` to match.
