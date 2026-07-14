// StackFall leaderboard + daily-challenge Worker.
//
// Routes (all JSON, CORS-open):
//   GET  /                     → info / health
//   GET  /daily                → { seed, day }         deterministic per UTC day
//   GET  /leaderboard          → { scope:'all',   day, scores:[…20] }
//   GET  /leaderboard?daily=1  → { scope:'daily', day, scores:[…20] }
//   POST /score                → { ok, rank, scores:[…20] }
//
// Storage: a single Workers KV namespace (binding LEADERBOARD). Each board is
// one JSON array kept trimmed to the top 50. This is intentionally simple and
// good enough for a casual game; if you ever need strong consistency or high
// write volume, graduate to Durable Objects or D1 (see README).

const KEEP = 50;              // entries stored per board
const TOP = 20;               // entries returned to clients
const RATE_WINDOW = 60;       // rate-limit window, seconds (KV TTL minimum is 60)
const MAX_BODY_BYTES = 1024;  // reject score bodies larger than this
const DEFAULT_RETENTION = 7;  // how many past days a daily board may be queried

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/' && request.method === 'GET') {
        return json({ ok: true, service: 'stackfall-leaderboard', endpoints: ['/daily', '/leaderboard', '/score'] }, 200, cors);
      }

      if (url.pathname === '/daily' && request.method === 'GET') {
        const day = dailySeedString();
        return json({ seed: hashString(day), day }, 200, cors);
      }

      if (url.pathname === '/leaderboard' && request.method === 'GET') {
        // Reject pathologically long query strings outright.
        if (url.search.length > 128) return json({ ok: false, error: 'bad_request' }, 400, cors);

        const daily = url.searchParams.get('daily') === '1' || url.searchParams.get('scope') === 'daily';
        let day = dailySeedString();
        if (daily) {
          // Only accept a strict, real YYYY-MM-DD within the retention window.
          // Arbitrary/oversized keys are rejected so the KV surface stays bounded.
          const dayParam = url.searchParams.get('day');
          if (dayParam != null) {
            if (!isValidDayKey(dayParam) || !dayWithinRetention(dayParam, retentionDays(env))) {
              return json({ ok: false, error: 'bad_day' }, 400, cors);
            }
            day = dayParam;
          }
        }
        const key = daily ? boardKeyDay(day) : boardKeyAll();
        const scores = (await boardRead(env, key)).slice(0, TOP);
        return json({ scope: daily ? 'daily' : 'all', day, scores }, 200, cors);
      }

      if (url.pathname === '/score' && request.method === 'POST') {
        return await handleScore(request, env, cors);
      }

      if (url.pathname === '/cheat' && request.method === 'POST') {
        return await handleCheat(request, env, cors);
      }

      return json({ ok: false, error: 'not_found' }, 404, cors);
    } catch (err) {
      // Log the detail server-side; return a generic code so implementation,
      // binding, or platform details never leak to callers.
      console.error('stackfall worker error:', err && err.stack || err);
      return json({ ok: false, error: 'server_error' }, 500, cors);
    }
  },
};

// ---------- /score ----------
async function handleScore(request, env, cors) {
  // Per-IP rate limit before any work: bounds spam and forged-signature floods.
  const ip = clientIp(request);
  const limited = await rateLimit(env, 'score', ip, intEnv(env.SCORE_RATE_LIMIT, 30), RATE_WINDOW);
  if (!limited.ok) return tooMany(limited, cors);

  const raw = await request.text();

  // Cap the body: submissions are tiny, so anything large is abuse or malformed.
  if (raw.length > MAX_BODY_BYTES) {
    return json({ ok: false, error: 'too_large' }, 413, cors);
  }

  // Verify the client's lightweight signature. This is NOT real security
  // (the salt ships in client code) — it only deters casual `curl` spam.
  // Real anti-cheat needs a server-authoritative model; see README.
  const salt = env.SIGN_SALT || 'stackfall';
  const sig = request.headers.get('X-Sig') || '';
  const expected = await sha256hex(raw + '|' + salt);
  if (!sig || sig !== expected) {
    return json({ ok: false, error: 'bad_signature' }, 401, cors);
  }

  let body;
  try { body = JSON.parse(raw); } catch (e) {
    return json({ ok: false, error: 'bad_json' }, 400, cors);
  }
  if (typeof body !== 'object' || body === null) {
    return json({ ok: false, error: 'bad_json' }, 400, cors);
  }

  const maxScore = intEnv(env.MAX_SCORE, 100000);
  const score = body.score;
  if (typeof score !== 'number' || !isFinite(score) || score < 0 || score > maxScore || score !== Math.floor(score)) {
    return json({ ok: false, error: 'bad_score' }, 400, cors);
  }

  // The run's competition. Endless runs write only to the all-time board;
  // Daily runs write only to today's board. This keeps the two competitions
  // genuinely separate (an Endless run can no longer land on the Daily board).
  const daily = body.daily === true;
  const day = dailySeedString();           // server-authoritative day for the run
  const key = daily ? boardKeyDay(day) : boardKeyAll();

  // Cheated runs: keep them off the board when BLOCK_CHEATED is on (default).
  // Still return the current standings so the panel can render.
  const blockCheated = (env.BLOCK_CHEATED || '1') !== '0';
  if (body.cheated === true && blockCheated) {
    const board = await boardRead(env, key);
    return json({ ok: true, recorded: false, cheated: true, scope: daily ? 'daily' : 'all', day, scores: board.slice(0, TOP) }, 200, cors);
  }

  const entry = { name: cleanName(body.name), score, ts: Date.now() };
  const res = await boardAdd(env, key, entry);

  return json({ ok: true, recorded: true, scope: daily ? 'daily' : 'all', day, rank: res.rank, scores: res.list.slice(0, TOP) }, 200, cors);
}

// ---------- /cheat ----------
async function handleCheat(request, env, cors) {
  const secret = env.CHEAT_CODE || '';
  if (!secret) return json({ ok: false, error: 'cheats_disabled' }, 403, cors);

  // Throttle guesses per IP so the passphrase can't be brute-forced online.
  const ip = clientIp(request);
  const limited = await rateLimit(env, 'cheat', ip, intEnv(env.CHEAT_RATE_LIMIT, 5), RATE_WINDOW);
  if (!limited.ok) return tooMany(limited, cors);

  let code = '';
  try { code = (await request.json()).code || ''; } catch (e) { code = ''; }
  if (typeof code !== 'string') code = '';

  const ok = timingSafeEqual(code, secret);
  return json({ ok }, ok ? 200 : 401, cors);
}

// Length-independent, constant-time-ish string compare to avoid leaking the
// passphrase length/prefix via response timing.
function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ba.length ^ bb.length;
  const n = Math.max(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    diff |= (ba[i] || 0) ^ (bb[i] || 0);
  }
  return diff === 0;
}

// ---------- board access ----------
// Reads/writes prefer the Leaderboard Durable Object (serialized, no lost
// updates) and fall back to KV automatically when the DO binding isn't
// configured — so the Worker keeps working before/after the DO is deployed.
function boardKeyAll() { return 'board:all'; }
function boardKeyDay(day) { return 'board:day:' + day; }

async function boardRead(env, key) {
  if (env.LEADERBOARD_DO) {
    const r = await doOp(env, { op: 'read', key });
    return Array.isArray(r.list) ? r.list : [];
  }
  return readBoardKV(env, key);
}

// Atomic read-modify-write of a single board. Inside the DO this is serialized;
// the KV fallback is the original (eventually consistent) read-then-write.
async function boardAdd(env, key, entry) {
  if (env.LEADERBOARD_DO) {
    const r = await doOp(env, { op: 'add', key, entry });
    return { list: Array.isArray(r.list) ? r.list : [], rank: r.rank || 0 };
  }
  const list = await readBoardKV(env, key);
  const res = addTo(list, entry);
  await writeBoardKV(env, key, res.list);
  return res;
}

// One DO instance per board key → concurrent submissions to the SAME board are
// serialized, while different boards (all-time vs each day) run independently.
function doOp(env, payload) {
  const id = env.LEADERBOARD_DO.idFromName(payload.key);
  return env.LEADERBOARD_DO.get(id)
    .fetch('https://do.internal/board', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    .then((res) => res.json());
}

async function readBoardKV(env, key) {
  const raw = await env.LEADERBOARD.get(key);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
async function writeBoardKV(env, key, list) {
  await env.LEADERBOARD.put(key, JSON.stringify(list.slice(0, KEEP)));
}
function addTo(list, entry) {
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.ts - b.ts);   // higher score, then earlier
  const rank = list.indexOf(entry) + 1;
  return { list: list.slice(0, KEEP), rank };
}

// ---------- Leaderboard Durable Object ----------
// Serializes board updates. Durable Object input gates guarantee that while a
// storage op is in flight no other request to this instance is delivered, so
// the read → mutate → write below is atomic and cannot lose a concurrent score.
export class Leaderboard {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    let msg;
    try { msg = await request.json(); } catch (e) { return Response.json({ error: 'bad_request' }, { status: 400 }); }
    const { op, key, entry } = msg || {};
    if (!key || typeof key !== 'string') return Response.json({ error: 'bad_key' }, { status: 400 });

    if (op === 'read') {
      const list = (await this.state.storage.get(key)) || [];
      return Response.json({ list });
    }
    if (op === 'add') {
      const list = (await this.state.storage.get(key)) || [];
      const res = addTo(list, entry);
      await this.state.storage.put(key, res.list);
      return Response.json({ list: res.list, rank: res.rank });
    }
    return Response.json({ error: 'bad_op' }, { status: 400 });
  }
}

// ---------- abuse controls ----------
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
}

// Best-effort per-IP fixed-window limiter backed by a short-lived KV key.
// KV is eventually consistent, so this is a soft ceiling, not a hard gate —
// which is the right trade-off for a casual game's spam/brute-force defence.
async function rateLimit(env, bucket, ip, limit, windowSec) {
  if (!ip || !env.LEADERBOARD) return { ok: true };
  const key = `rl:${bucket}:${ip}`;
  let count = 0;
  try { count = parseInt(await env.LEADERBOARD.get(key) || '0', 10) || 0; } catch (e) { /* fail open */ }
  if (count >= limit) return { ok: false, retryAfter: windowSec };
  try { await env.LEADERBOARD.put(key, String(count + 1), { expirationTtl: windowSec }); } catch (e) { /* fail open */ }
  return { ok: true };
}

function tooMany(info, cors) {
  return json(
    { ok: false, error: 'rate_limited' },
    429,
    { ...cors, 'Retry-After': String((info && info.retryAfter) || RATE_WINDOW) },
  );
}

function intEnv(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ---------- day-key validation ----------
// Accept only a real calendar YYYY-MM-DD; reject junk, oversized, and impossible dates.
function isValidDayKey(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Allow today and up to `retentionDays` in the past; never the future.
function dayWithinRetention(day, retentionDays) {
  const today = dailySeedString();
  if (day === today) return true;
  const dt = Date.parse(day + 'T00:00:00Z');
  const now = Date.parse(today + 'T00:00:00Z');
  if (Number.isNaN(dt)) return false;
  const diffDays = (now - dt) / 86400000;
  return diffDays >= 0 && diffDays <= retentionDays;
}

function retentionDays(env) {
  return Math.max(0, intEnv(env && env.RETENTION_DAYS, DEFAULT_RETENTION));
}

// ---------- validation ----------
function cleanName(n) {
  if (typeof n !== 'string') return 'anon';
  // Whitelist: letters, digits, space, and a few safe marks. Everything else
  // (including HTML-dangerous chars) is dropped, so names are XSS-safe.
  n = n.replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 12);
  return n || 'anon';
}

// ---------- daily seed (must match js/rng.js exactly) ----------
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function dailySeedString(d = new Date()) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

// ---------- misc ----------
async function sha256hex(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Sig',
    'Access-Control-Max-Age': '86400',
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
