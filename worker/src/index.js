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

const KEEP = 50;   // entries stored per board
const TOP = 20;    // entries returned to clients

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
        const daily = url.searchParams.get('daily') === '1' || url.searchParams.get('scope') === 'daily';
        const day = url.searchParams.get('day') || dailySeedString();
        const key = daily ? boardKeyDay(day) : boardKeyAll();
        const scores = (await readBoard(env, key)).slice(0, TOP);
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
      return json({ ok: false, error: 'server_error', detail: String(err && err.message || err) }, 500, cors);
    }
  },
};

// ---------- /score ----------
async function handleScore(request, env, cors) {
  const raw = await request.text();

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

  const maxScore = parseInt(env.MAX_SCORE || '100000', 10);
  const score = body.score;
  if (typeof score !== 'number' || !isFinite(score) || score < 0 || score > maxScore || score !== Math.floor(score)) {
    return json({ ok: false, error: 'bad_score' }, 400, cors);
  }

  // Cheated runs: keep them off the global board when BLOCK_CHEATED is on
  // (default). Still return the current standings so the panel can render.
  const blockCheated = (env.BLOCK_CHEATED || '1') !== '0';
  if (body.cheated === true && blockCheated) {
    const all = await readBoard(env, boardKeyAll());
    return json({ ok: true, recorded: false, cheated: true, scores: all.slice(0, TOP) }, 200, cors);
  }

  const entry = { name: cleanName(body.name), score, ts: Date.now() };
  const day = dailySeedString();

  const all = await readBoard(env, boardKeyAll());
  const allRes = addTo(all, { ...entry });
  await writeBoard(env, boardKeyAll(), allRes.list);

  const dayBoard = await readBoard(env, boardKeyDay(day));
  const dayRes = addTo(dayBoard, { ...entry });
  await writeBoard(env, boardKeyDay(day), dayRes.list);

  return json({ ok: true, rank: allRes.rank, dailyRank: dayRes.rank, scores: allRes.list.slice(0, TOP) }, 200, cors);
}

// ---------- /cheat ----------
async function handleCheat(request, env, cors) {
  const secret = env.CHEAT_CODE || '';
  if (!secret) return json({ ok: false, error: 'cheats_disabled' }, 403, cors);

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

// ---------- board helpers ----------
function boardKeyAll() { return 'board:all'; }
function boardKeyDay(day) { return 'board:day:' + day; }

async function readBoard(env, key) {
  const raw = await env.LEADERBOARD.get(key);
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
async function writeBoard(env, key, list) {
  await env.LEADERBOARD.put(key, JSON.stringify(list.slice(0, KEEP)));
}
function addTo(list, entry) {
  list.push(entry);
  list.sort((a, b) => b.score - a.score || a.ts - b.ts);   // higher score, then earlier
  const rank = list.indexOf(entry) + 1;
  return { list: list.slice(0, KEEP), rank };
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
