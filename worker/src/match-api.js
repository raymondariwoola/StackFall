import {
  ticketFromSocketProtocols,
  formatRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  validateCreateMatchRequest,
  validateJoinMatchRequest,
} from '../../shared/duel-protocol.js';
import { MATCH_DURATIONS, sha256hex } from './match-room.js';
import { clientIp, intEnv, rateLimit } from './rate-limit.js';

const MAX_MATCH_BODY_BYTES = 1024;
const RATE_WINDOW_SECONDS = 60;
const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function isMatchPath(pathname){
  return pathname === '/matches' || pathname.startsWith('/matches/');
}

function json(body, status, cors){
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function tooMany(info, cors){
  return json(
    { ok: false, error: 'rate_limited' },
    429,
    {
      ...cors,
      'Retry-After': String((info && info.retryAfter) || RATE_WINDOW_SECONDS),
      'X-RateLimit-Limit': String((info && info.limit) || 0),
      'X-RateLimit-Remaining': String((info && info.remaining) || 0),
    },
  );
}

async function readBody(request){
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_MATCH_BODY_BYTES) {
    return { ok: false, error: 'too_large', status: 413 };
  }
  try {
    const value = JSON.parse(raw);
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: 'bad_json', status: 400 };
  }
}

function randomHex(bytes = 24){
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function randomRoomCode(){
  // Rejection sampling avoids modulo bias because the human-safe alphabet has
  // 31 symbols after ambiguous characters are removed.
  let code = '';
  while (code.length < 8){
    const values = new Uint8Array(8);
    crypto.getRandomValues(values);
    for (const value of values){
      if (value >= 248) continue; // 248 is the largest multiple of 31 below 256
      code += ROOM_ALPHABET[value % ROOM_ALPHABET.length];
      if (code.length === 8) break;
    }
  }
  return code;
}

export function isAllowedMatchOrigin(env, request){
  const allowed = (env.ALLOW_ORIGIN || '*').split(',').map((value) => value.trim()).filter(Boolean);
  if (allowed.includes('*')) return true;
  const origin = request.headers.get('Origin') || '';
  return !!origin && allowed.includes(origin);
}

function roomStub(env, code){
  const id = env.MATCH_ROOM.idFromName(code);
  return env.MATCH_ROOM.get(id);
}

async function internalJson(stub, path, method, body){
  return stub.fetch(new Request(`https://match.internal${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  }));
}

async function relayJson(response, cors, additions = null){
  let data;
  try { data = await response.json(); }
  catch (e) { return json({ ok: false, error: 'room_error' }, 502, cors); }
  return json(additions && response.ok ? { ...data, ...additions } : data, response.status, cors);
}

function parseMatchRoute(pathname){
  const match = /^\/matches\/([^/]+)(?:\/(join|socket-ticket|socket))?$/.exec(pathname);
  if (!match) return null;
  let rawCode;
  try { rawCode = decodeURIComponent(match[1]); }
  catch (e) { return null; }
  const code = normalizeRoomCode(rawCode);
  if (!isValidRoomCode(code)) return { error: 'bad_code' };
  return { code, action: match[2] || 'state' };
}

export async function handleMatchRequest(request, env, cors){
  if ((env.MULTIPLAYER_ENABLED || '1') === '0') {
    return json({ ok: false, error: 'multiplayer_disabled' }, 503, cors);
  }
  if (!env.MATCH_ROOM) return json({ ok: false, error: 'multiplayer_unconfigured' }, 503, cors);

  const url = new URL(request.url);
  if (url.pathname === '/matches'){
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    const limited = await rateLimit(
      env, 'match-create', clientIp(request), intEnv(env.MATCH_CREATE_RATE_LIMIT, 10), RATE_WINDOW_SECONDS,
    );
    if (!limited.ok) return tooMany(limited, cors);

    const parsed = await readBody(request);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status, cors);
    const validated = validateCreateMatchRequest(parsed.value);
    if (!validated.ok) return json({ ok: false, error: validated.error }, 400, cors);

    const hostToken = randomHex();
    const hostTokenHash = await sha256hex(hostToken);
    for (let attempt = 0; attempt < 6; attempt++){
      const code = randomRoomCode();
      const response = await internalJson(roomStub(env, code), '/init', 'POST', {
        code: formatRoomCode(code),
        hostName: validated.value.name,
        hostTokenHash,
        difficulty: validated.value.difficulty,
      });
      if (response.status === 409) continue;
      return relayJson(response, cors, response.ok ? { code: formatRoomCode(code), hostToken } : null);
    }
    return json({ ok: false, error: 'code_generation_failed' }, 503, cors);
  }

  const route = parseMatchRoute(url.pathname);
  if (!route) return json({ ok: false, error: 'not_found' }, 404, cors);
  if (route.error) return json({ ok: false, error: route.error }, 400, cors);
  const stub = roomStub(env, route.code);

  if (route.action === 'state'){
    if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    return relayJson(await internalJson(stub, '/state', 'GET'), cors);
  }

  if (route.action === 'join'){
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    const limited = await rateLimit(
      env, 'match-join', clientIp(request), intEnv(env.MATCH_JOIN_RATE_LIMIT, 30), RATE_WINDOW_SECONDS,
    );
    if (!limited.ok) return tooMany(limited, cors);
    const parsed = await readBody(request);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status, cors);
    const validated = validateJoinMatchRequest(parsed.value);
    if (!validated.ok) return json({ ok: false, error: validated.error }, 400, cors);
    const playerToken = randomHex();
    const response = await internalJson(stub, '/join', 'POST', {
      guestName: validated.value.name,
      guestTokenHash: await sha256hex(playerToken),
    });
    return relayJson(response, cors, response.ok ? { playerToken } : null);
  }

  if (route.action === 'socket-ticket'){
    if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    const limited = await rateLimit(
      env, 'match-ticket', clientIp(request), intEnv(env.MATCH_TICKET_RATE_LIMIT, 60), RATE_WINDOW_SECONDS,
    );
    if (!limited.ok) return tooMany(limited, cors);
    const authorization = request.headers.get('Authorization') || '';
    const match = /^Bearer ([a-f0-9]{48})$/.exec(authorization);
    if (!match) return json({ ok: false, error: 'unauthorized' }, 401, cors);
    const ticket = randomHex();
    const expiresAt = Date.now() + MATCH_DURATIONS.TICKET_MS;
    const response = await internalJson(stub, '/ticket', 'POST', {
      tokenHash: await sha256hex(match[1]),
      ticketHash: await sha256hex(ticket),
      expiresAt,
    });
    return relayJson(response, cors, response.ok ? { ticket } : null);
  }

  if (route.action === 'socket'){
    if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
    if (!isAllowedMatchOrigin(env, request)) return json({ ok: false, error: 'origin_forbidden' }, 403, cors);
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return json({ ok: false, error: 'upgrade_required' }, 426, cors);
    }
    const ticket = ticketFromSocketProtocols(request.headers.get('Sec-WebSocket-Protocol'));
    if (!ticket) return json({ ok: false, error: 'invalid_ticket' }, 401, cors);
    return stub.fetch(new Request('https://match.internal/socket', {
      method: 'GET', headers: request.headers,
    }));
  }

  return json({ ok: false, error: 'not_found' }, 404, cors);
}
