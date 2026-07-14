# StackFall Application Audit

Date: 2026-07-14

Scope: static client, Cloudflare Worker, Wrangler configuration, and the
GitHub Pages/Worker deployment shape visible in this repository. This is a
static code audit; production behavior, DNS, deployed Worker variables, KV
contents, and real-device behavior were not directly inspected.

## Executive summary

The core game is small and understandable, and all JavaScript files pass a
syntax check. The highest-impact problems are:

1. Endless scores are written to the daily leaderboard, so the daily board is
   not actually a daily-only competition.
2. The UI never requests the daily leaderboard, even when Daily Board mode is
   selected.
3. The Worker accepts a client-generated signature and has no rate limit, so a
   user can forge unlimited valid submissions and brute-force the cheat API.
4. KV read-modify-write operations can lose scores when submissions arrive at
   the same time.

## Bugs and risks

### High: Endless runs contaminate the daily board — ✅ Fixed (2026-07-14)

Resolution: the client now sends an explicit `daily` boolean captured at the
start of the run (`js/main.js` `runMode`, `js/leaderboard.js` `submitScore`).
The Worker writes to exactly one board per run — `board:all` for Endless,
`board:day:<server-day>` for Daily — using its own server-authoritative day
(`worker/src/index.js` `handleScore`). An Endless run can no longer land on the
Daily board, and the day key is the run's accepted day, not processing time.

Evidence: `js/main.js:50` submits every game-over with only the score and
cheat flag. In `worker/src/index.js:93-102`, every accepted score is written
to both `board:all` and the current UTC-day board. The client-generated
`day` field is ignored by the Worker.

Impact: an Endless run is counted in the Daily leaderboard, and a score made
just before midnight is assigned according to the Worker’s processing time,
not the run’s mode or submitted timestamp. This makes Daily rankings
inaccurate and makes the API’s `dailyRank` misleading.

Recommendation: send an explicit `mode` or `daily` boolean with the run,
validate it server-side, and only write `board:day:*` for genuine Daily runs.
Record the run’s server-accepted day once, and display separate ranks for the
two modes.

### High: Daily mode still displays the all-time board — ✅ Fixed (2026-07-14)

Resolution: `fetchLeaderboard(daily)` now requests `/leaderboard?daily=1` when
Daily is selected, `refreshRemoteBoard(daily)` is scope-aware and is re-run when
the mode toggle changes (`js/main.js`), and the board heading reflects the scope
("Today's Top 20" vs "Global Top 20", `js/ui.js` `renderRemoteScores`). The
game-over panel and share text use the mode captured at the start of the run.

Evidence: `js/main.js:90-95` always calls `fetchLeaderboard()` without a
daily query. `js/leaderboard.js:40-43` always requests `/leaderboard`, while
the Worker only selects the daily board when `daily=1` or `scope=daily` is
provided (`worker/src/index.js:37-42`).

Impact: the “Daily Board” button changes the seed but not the displayed
leaderboard. Players cannot compare their daily result with the correct
competition.

Recommendation: make the client request `/leaderboard?daily=1` in Daily mode,
pass the selected scope into the UI, and refresh the board when the mode
changes. Use the mode captured at the start of a run for the game-over panel
and share text.

### High: Score signatures are forgeable and submissions are unauthenticated — ⚠️ Partially addressed (2026-07-14)

Resolution (partial): added a per-IP rate limit (`SCORE_RATE_LIMIT`, default 30
per 60s) and a request-size cap (`MAX_BODY_BYTES` = 1KB) in
`worker/src/index.js` `handleScore`, plus stricter body-type validation. This
bounds forged-signature floods and casual spam. The signature remains
client-authoritative by design — a server-verifiable replay or Turnstile gate
(and/or a visible "unverified" label) is still outstanding for real trust.

Evidence: the salt is public in `worker/wrangler.toml:13-15` and the same
algorithm is shipped to every browser in `js/leaderboard.js:16-25`. The Worker
only checks that the request body hashes with that public salt
(`worker/src/index.js:64-71`).

Impact: anyone can generate a valid signature for an arbitrary score/name and
post up to `MAX_SCORE`. This is explicitly not a trustworthy anti-cheat
mechanism, and the open Worker endpoint also has no per-IP/user rate limit.

Recommendation: treat all client scores as untrusted. Add inexpensive abuse
controls such as a per-IP/user-agent rate limit using a short-lived KV key,
request-size limits, duplicate/replay detection, and a server-issued run
token. For meaningful trust, validate a compact server-verifiable replay or
use a free Cloudflare Turnstile gate for score submission. Keep a visible
“unverified” label if scores remain client-authoritative.

### High: KV updates can overwrite each other — ✅ Fixed (2026-07-14)

Resolution: board reads/writes now go through a `Leaderboard` Durable Object
(`worker/src/index.js`), one instance per board key. Durable Object input gates
serialize the read → mutate → write, so concurrent submissions to the same board
can no longer lose each other's scores, and a returned rank is consistent with
the write that produced it. The Worker falls back to the previous KV path
automatically when the DO binding is absent, so nothing breaks pre-deploy. The
DO is SQLite-backed (`new_sqlite_classes` in `worker/wrangler.toml`) so it runs
on the Workers free plan. Add/read/rank logic is covered by a local test harness.

Evidence: each score reads a board, mutates the local array, and writes it
back (`worker/src/index.js:96-102`, `worker/src/index.js:138-151`). Cloudflare KV
does not provide an atomic compare-and-swap transaction for this pattern.

Impact: concurrent submissions can read the same old board and the later write
can erase scores accepted by the earlier write. The returned rank can also be
stale immediately after another write.

Recommendation: use a Durable Object for serialized leaderboard updates, or
accept append-only per-score records and periodically rebuild the top list.
For a small launch, at minimum document that rankings are eventually
consistent and add a retry/re-read path.

### Medium: Arbitrary daily keys can be queried forever — ✅ Fixed (2026-07-14)

Resolution: `/leaderboard` now accepts a `day` override only for daily queries,
validates it against a strict real-calendar `YYYY-MM-DD` (`isValidDayKey`),
restricts it to a retention window (`RETENTION_DAYS`, default 7 days, no future)
via `dayWithinRetention`, and rejects query strings over 128 chars. Invalid
values return `400 bad_day`. Validators are covered by a local test harness.

Evidence: `worker/src/index.js:38-41` accepts any `day` query string and uses it
directly in the KV key through `boardKeyDay(day)`.

Impact: anyone can make the Worker read arbitrary historical or junk daily
keys. This increases free-tier reads and exposes a broad, unbounded API
surface; it also makes it possible to create confusing URLs with very long
keys.

Recommendation: accept only a strict `YYYY-MM-DD` value, optionally restrict
queries to today and a small retention window, and reject oversized query
strings. Consider removing the public `day` override unless historical boards
are a feature.

### Medium: Cheat passphrase endpoint can be brute-forced — ✅ Fixed (2026-07-14)

Resolution: `/cheat` is now rate-limited per IP (`CHEAT_RATE_LIMIT`, default 5
guesses per 60s) before the passphrase is compared, returning `429 rate_limited`
with a `Retry-After` header once exceeded. Combined with the existing
constant-time compare and a long random `CHEAT_CODE`, online brute force is
impractical. (Gating the endpoint behind an enable flag remains an option.)

Evidence: `worker/src/index.js:108-117` performs unlimited online guesses at
`/cheat`, with no throttling, lockout, or request provenance requirement.

Impact: the passphrase can eventually be discovered, after which the hidden
cheat tools become available to anyone. The endpoint also makes the existence
of the feature easy to probe.

Recommendation: add a short per-IP failure counter and exponential backoff in
KV, use a long random secret, and avoid exposing the endpoint unless cheats
are enabled. A local-only development switch is safer for a public game.

### Medium: Worker returns internal error details to public callers — ✅ Fixed (2026-07-14)

Resolution: the top-level catch now logs the full error/stack server-side with
`console.error` and returns a generic `{ ok: false, error: 'server_error' }`
with no `detail`, so implementation/binding details no longer leak to callers.

Evidence: `worker/src/index.js:54-56` includes `err.message` in a 500 response.

Impact: implementation, binding, or platform details can leak to attackers and
make error responses inconsistent.

Recommendation: log the detailed error server-side and return a generic error
code/message to clients.

### Medium: Local storage failures can break boot or a completed run — ✅ Fixed (2026-07-14)

Resolution: `js/storage.js` now routes every read/write through `safeGet`/
`safeSet` helpers that catch storage exceptions and fall back to an in-memory
`Map`, so private-browsing/quota/policy errors can never throw during boot or
game-over. `scores()` is sanitized to finite, non-negative integers before use,
and `addScore` ignores non-finite/negative inputs.

Evidence: `js/storage.js:11`, `24-27` call `localStorage` without guards, and
`js/main.js:35-36` reads storage during startup. Only JSON parsing is wrapped.

Impact: private browsing restrictions, disabled storage, quota exhaustion, or
browser security policy can throw and prevent the game from loading or from
recording a game-over.

Recommendation: wrap every storage read/write in safe helpers with an in-memory
fallback. Validate that `scores()` returns an array of finite non-negative
numbers before sorting or rendering.

### Medium: Starting a Daily run has no timeout or cancellation — ✅ Fixed (2026-07-14)

Resolution: `fetchDailySeed` now uses an `AbortController` with a 6s timeout and
falls back to the locally computed seed on timeout/error (`js/leaderboard.js`).
`start()` keeps the overlay up with a "Loading…" state and disables Start while
the seed loads, ignores re-entrant taps (`starting` guard), and uses a
monotonically increasing `startToken` so only the latest request can reset the
game (`js/main.js`, `js/ui.js` `setStarting`).

Evidence: `js/main.js:119-130` hides the overlay before awaiting
`fetchDailySeed()`, and `js/leaderboard.js:66-74` performs an uncancelled fetch.

Impact: a slow or stalled Worker leaves the player with a blank/non-responsive
start state. Repeated taps can call `start()` multiple times while earlier
seed requests are still pending, allowing an older response to reset a newer
run.

Recommendation: add an `AbortController` timeout, keep a loading state, disable
Start while loading, and use a monotonically increasing start request id so
only the latest request can reset the game.

### Low: Share text can describe the wrong mode — ✅ Fixed (2026-07-14)

Resolution: the run's mode is captured into `lastRun.mode` at game over (from the
`runMode` snapshot taken when the run started), and `shareRun()` reads
`lastRun.mode` instead of the live global `mode` (`js/main.js`). Toggling to Daily
after an Endless run can no longer produce a "today's board" share message.

Evidence: `js/main.js:73-74` reads the mutable global `mode` when Share Score
is clicked. The mode button remains available after game over.

Impact: a player can finish Endless, toggle to Daily, and share a message that
claims the score was made on today’s board.

Recommendation: store `lastRun.mode` at the beginning of the run and use that
captured value for sharing and result labels.

### Low: Resize/orientation changes do not re-layout an active stack

Evidence: `js/main.js:98-105` updates viewport dimensions and canvas size, but
`Game` keeps existing layer coordinates and widths. `js/game.js:216-221` only
updates movement bounds.

Impact: rotating a phone or resizing the browser can leave the tower outside
the new canvas or make the next landing geometry inconsistent.

Recommendation: pause briefly on resize and scale/recenter existing layers, or
restart the current run with a clear “viewport changed” state.

### Low: Accessibility and input feedback are incomplete — ✅ Fixed (2026-07-14)

Resolution: overlays now carry `role="dialog"`/`aria-modal` with `aria-labelledby`
(start, pause, tutorial, and cheat panels). A new `js/a11y.js` traps Tab focus
inside the topmost modal and restores focus on close (`setModal`/`clearModal` in
`js/main.js`), and a visually-hidden `#sr-status` `aria-live="polite"` region
announces game start, game over (with score/floors), and pause/resume. Visible
keyboard instructions were added ("Space / Enter to drop · P to pause"), a
`:focus-visible` ring was added for keyboard users, and `prefers-reduced-motion`
is honored in CSS (animations) and in the canvas (screen shake + flash gated via
`effects.reduceMotion`, tracked live).

Evidence: the overlays are plain `div`s (`index.html:29-43`, `46-104`) without
dialog semantics, focus management, or an accessible live score/status region.
The canvas itself has no fallback instructions for keyboard or assistive-tech
users.

Impact: keyboard and screen-reader users may not know when the game starts,
ends, or which controls are available; focus can remain behind an open modal.

Recommendation: use `role="dialog"` and labels, trap/restore focus for modal
overlays, add `aria-live="polite"` to score/result text, provide visible
keyboard instructions, and honor `prefers-reduced-motion`.

### Low: External font availability is a single point of visual degradation

Evidence: `index.html:9-11` depends on Google Fonts at runtime.

Impact: offline users, restrictive networks, or an outage fall back to system
fonts and may see layout shifts. The game still runs, but the first render is
less predictable.

Recommendation: add a robust local/system font stack and `font-display: swap`
if fonts are self-hosted later. Keep the game fully usable without the CDN.

## Free enhancements and features

### Player experience

- ✅ **Done (2026-07-14)** — Add a first-run tutorial overlay with one animated
  example drop, then allow it to be skipped and remembered locally.
- ✅ **Done (2026-07-14)** — Add a pause button and automatic pause on
  `visibilitychange`, with a clear “Paused” state so switching apps does not
  cause an accidental miss. (Resume is tap/Space/P, not automatic, to avoid a
  surprise drop on return.)
- Add a personal run history showing score, floors, mode, date, and best streak;
  keep only a bounded local list.
- Add daily streaks, personal daily best, and a countdown to the next UTC board.
- Add a “share result card” rendered with Canvas rather than requiring a paid
  image service.
- Add an optional high-contrast palette, reduced-motion mode, and a setting to
  disable haptics independently from sound.

### Competition and retention

- Show separate Endless and Daily tabs with the player’s rank and score delta
  to the next leaderboard position.
- Add a deterministic seed/code view so players can replay a specific daily
  challenge and compare fairly.
- Add achievements for milestones such as 10 floors, five perfect drops, and
  reaching each world; store them locally.
- Add a practice mode with no leaderboard submission and an explicit practice
  label.
- Add a “new personal best” animation and a local best-by-mode record.

### Reliability and deployment

- Add a lightweight health indicator and a non-blocking offline banner when
  the Worker is unavailable; retain local play and local scores.
- Add a service worker/cache manifest for installable offline play on supported
  browsers, while keeping the Worker optional.
- Add a GitHub Actions workflow for syntax checks, link checks, and a static
  deployment smoke test on every push.
- Add a strict Content Security Policy compatible with the chosen font source,
  and set security headers from the Worker or hosting configuration.
- Restrict Worker CORS to the actual GitHub Pages origin rather than `*`, and
  add `Cache-Control` headers for the daily seed and read-only leaderboard.
- Add a small Worker test harness covering score validation, name cleaning,
  daily routing, cheat blocking, and concurrent-update behavior.

## Suggested implementation order

1. ✅ **Done (2026-07-14)** — Fix mode propagation and fetch the correct daily
   leaderboard.
2. ✅ **Done (2026-07-14)** — Add Worker input validation, rate limiting, generic
   errors, and strict day keys. (Score submissions remain client-authoritative;
   a server-verifiable replay / Turnstile gate is still outstanding.)
3. ✅ **Done (2026-07-14)** — Make local storage and daily startup failure-safe.
4. ✅ **Done (2026-07-14)** — Move leaderboard writes to a serialized Durable
   Object. Implemented as a SQLite-backed `Leaderboard` DO (free-plan eligible),
   one instance per board, with automatic KV fallback. **Requires a Cloudflare
   redeploy to take effect** (see the note below).
5. ✅ **Done (2026-07-14)** — Add pause/visibility handling, accessibility
   semantics, and a first-run tutorial.

## Cloudflare deployment notes (for items 2 & 4)

The client and Worker code are complete, but the following take effect only
after the Worker is redeployed:

- **Redeploy the Worker** so the Durable Object migration runs and the new
  validation/rate-limit/day-key logic ships:
  `cd worker && npx wrangler deploy`. The first deploy applies migration `v1`
  (`new_sqlite_classes = ["Leaderboard"]`) automatically.
- **No new KV namespace or dashboard change is required** — the existing
  `LEADERBOARD` KV binding is reused for rate-limit counters and as the
  leaderboard fallback. The Durable Object uses its own built-in storage.
- **Existing KV board history does not migrate** into the Durable Object; the
  DO-backed boards start empty on first deploy. If preserving current standings
  matters, do a one-time copy from KV before cutover (otherwise no action).
- **Optional tunables** (all have safe defaults in `wrangler.toml`, no change
  needed): `SCORE_RATE_LIMIT`, `CHEAT_RATE_LIMIT`, `RETENTION_DAYS`,
  `ALLOW_ORIGIN` (still `*` — tighten to the GitHub Pages origin when ready).
- **Durable Objects on the free plan**: the DO is SQLite-backed, which is
  free-plan eligible. If the account is on a very old Workers configuration and
  the migration is rejected, either enable the current DO/SQLite defaults or
  simply remove the `[[durable_objects.bindings]]` + `[[migrations]]` blocks —
  the Worker then transparently falls back to KV.
