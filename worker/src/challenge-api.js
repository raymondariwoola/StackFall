import {
  formatRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  validateCreateMatchRequest,
  validateJoinMatchRequest,
} from '../../shared/duel-protocol.js';
import { sha256hex } from './match-room.js';
import { clientIp, intEnv, rateLimit } from './rate-limit.js';

const MAX_BODY_BYTES = 1024;
const RATE_WINDOW_SECONDS = 60;
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function isChallengePath(pathname){
  return pathname === '/challenges' || pathname.startsWith('/challenges/');
}

function json(body, status, cors){
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function randomHex(bytes = 24){
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function randomCode(){
  const values = new Uint8Array(8);
  crypto.getRandomValues(values);
  return [...values].map((value) => ALPHABET[value % ALPHABET.length]).join('');
}

async function body(request){
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return { ok: false, status: 413, error: 'too_large' };
  }
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch (error){ return { ok: false, status: 400, error: 'bad_json' }; }
}

function stub(env, code){ return env.CHALLENGE_ROOM.get(env.CHALLENGE_ROOM.idFromName(normalizeRoomCode(code))); }

async function internal(target, path, value){
  return target.fetch(new Request(`https://challenge.internal${path}`, {
    method: value == null ? 'GET' : 'POST',
    headers: value == null ? undefined : { 'Content-Type': 'application/json' },
    body: value == null ? undefined : JSON.stringify(value),
  }));
}

async function relay(response, cors, additions = null){
  let data;
  try { data = await response.json(); }
  catch (error){ return json({ ok: false, error: 'challenge_error' }, 502, cors); }
  return json(additions && response.ok ? { ...data, ...additions } : data, response.status, cors);
}

function token(request){
  const match = /^Bearer ([a-f0-9]{48})$/.exec(request.headers.get('Authorization') || '');
  return match ? match[1] : '';
}

function tooMany(info, cors){
  return json({ ok: false, error: 'rate_limited' }, 429, {
    ...cors,
    'Retry-After': String(info.retryAfter || RATE_WINDOW_SECONDS),
    'X-RateLimit-Limit': String(info.limit || 0),
    'X-RateLimit-Remaining': String(info.remaining || 0),
  });
}

export async function handleChallengeRequest(request, env, cors){
  if ((env.MULTIPLAYER_ENABLED || '1') === '0') {
    return json({ ok: false, error: 'multiplayer_disabled' }, 503, cors);
  }
  if (!env.CHALLENGE_ROOM) return json({ ok: false, error: 'multiplayer_unconfigured' }, 503, cors);
  const url = new URL(request.url);

  if (url.pathname === '/challenges'){
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    const limited = await rateLimit(env, 'match-create', clientIp(request), intEnv(env.MATCH_CREATE_RATE_LIMIT, 10), RATE_WINDOW_SECONDS);
    if (!limited.ok) return tooMany(limited, cors);
    const parsed = await body(request);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status, cors);
    const valid = validateCreateMatchRequest(parsed.value);
    if (!valid.ok) return json({ ok: false, error: valid.error }, 400, cors);
    const hostToken = randomHex();
    const hostTokenHash = await sha256hex(hostToken);
    for (let attempt = 0; attempt < 6; attempt++){
      const code = randomCode();
      const response = await internal(stub(env, code), '/init', {
        code: formatRoomCode(code), hostName: valid.value.name,
        hostTokenHash, difficulty: valid.value.difficulty,
      });
      if (response.status === 409) continue;
      return relay(response, cors, response.ok ? { code: formatRoomCode(code), hostToken } : null);
    }
    return json({ ok: false, error: 'code_generation_failed' }, 503, cors);
  }

  const match = /^\/challenges\/([^/]+)(?:\/(join|finish|cancel))?$/.exec(url.pathname);
  if (!match) return json({ ok: false, error: 'not_found' }, 404, cors);
  let decoded;
  try { decoded = decodeURIComponent(match[1]); } catch (error){ return json({ ok: false, error: 'bad_code' }, 400, cors); }
  const code = normalizeRoomCode(decoded);
  if (!isValidRoomCode(code)) return json({ ok: false, error: 'bad_code' }, 400, cors);
  const action = match[2] || 'state';
  const target = stub(env, code);
  if (action === 'state'){
    if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    return relay(await internal(target, '/state'), cors);
  }
  if (action === 'join'){
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    const limited = await rateLimit(env, 'match-join', clientIp(request), intEnv(env.MATCH_JOIN_RATE_LIMIT, 30), RATE_WINDOW_SECONDS);
    if (!limited.ok) return tooMany(limited, cors);
    const parsed = await body(request);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status, cors);
    const valid = validateJoinMatchRequest(parsed.value);
    if (!valid.ok) return json({ ok: false, error: valid.error }, 400, cors);
    const guestToken = randomHex();
    const response = await internal(target, '/join', {
      guestName: valid.value.name, guestTokenHash: await sha256hex(guestToken),
    });
    return relay(response, cors, response.ok ? { guestToken } : null);
  }
  const bearer = token(request);
  if (!bearer) return json({ ok: false, error: 'unauthorized' }, 401, cors);
  if (action === 'finish'){
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    const parsed = await body(request);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status, cors);
    return relay(await internal(target, '/finish', {
      tokenHash: await sha256hex(bearer), progress: parsed.value,
    }), cors);
  }
  if (action === 'cancel'){
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    return relay(await internal(target, '/cancel', { tokenHash: await sha256hex(bearer) }), cors);
  }
  return json({ ok: false, error: 'not_found' }, 404, cors);
}
