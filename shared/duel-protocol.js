// Versioned, dependency-free contract shared by the future browser client and
// MatchRoom Durable Object. Phase 0 defines and tests the contract; Phase 1
// will connect it to HTTP and WebSocket routes.

export const DUEL_PROTOCOL_VERSION = 1;

export const ROOM_STATES = Object.freeze({
  WAITING: 'waiting',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  FINISHED: 'finished',
  FORFEIT: 'forfeit',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

export const CLIENT_MESSAGE_TYPES = Object.freeze([
  'ready',
  'progress',
  'finish',
  'heartbeat',
  'rematch_vote',
  'leave',
]);

export const SERVER_MESSAGE_TYPES = Object.freeze([
  'snapshot',
  'player_joined',
  'presence',
  'countdown',
  'opponent_progress',
  'opponent_finished',
  'result',
  'expired',
  'error',
]);

export const DUEL_LIMITS = Object.freeze({
  MAX_NAME_LENGTH: 12,
  MAX_MESSAGE_BYTES: 4096,
  MAX_SEQUENCE: 1_000_000,
  ROOM_CODE_LENGTH: 8,
});

const ROOM_CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/;
const TRANSITIONS = Object.freeze({
  [ROOM_STATES.WAITING]: [ROOM_STATES.COUNTDOWN, ROOM_STATES.CANCELLED, ROOM_STATES.EXPIRED],
  [ROOM_STATES.COUNTDOWN]: [ROOM_STATES.PLAYING, ROOM_STATES.CANCELLED, ROOM_STATES.EXPIRED],
  [ROOM_STATES.PLAYING]: [ROOM_STATES.FINISHED, ROOM_STATES.FORFEIT, ROOM_STATES.EXPIRED],
  [ROOM_STATES.FINISHED]: [ROOM_STATES.COUNTDOWN, ROOM_STATES.EXPIRED],
  [ROOM_STATES.FORFEIT]: [ROOM_STATES.COUNTDOWN, ROOM_STATES.EXPIRED],
  [ROOM_STATES.CANCELLED]: [],
  [ROOM_STATES.EXPIRED]: [],
});

function isRecord(value){
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeRoomCode(value){
  return String(value || '').toUpperCase().replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, '');
}

export function formatRoomCode(value){
  const code = normalizeRoomCode(value);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4, 8)}` : code;
}

export function isValidRoomCode(value){
  return ROOM_CODE_RE.test(normalizeRoomCode(value));
}

export function cleanDuelName(value){
  if (typeof value !== 'string') return '';
  return value
    .replace(/[^A-Za-z0-9 _.-]/g, '')
    .trim()
    .slice(0, DUEL_LIMITS.MAX_NAME_LENGTH);
}

export function validateCreateMatchRequest(body){
  if (!isRecord(body)) return { ok: false, error: 'bad_request' };
  const name = cleanDuelName(body.name);
  if (!name) return { ok: false, error: 'bad_name' };
  if (body.difficulty !== 'normal' && body.difficulty !== 'hardcore') {
    return { ok: false, error: 'bad_difficulty' };
  }
  return { ok: true, value: { name, difficulty: body.difficulty } };
}

export function validateJoinMatchRequest(body){
  if (!isRecord(body)) return { ok: false, error: 'bad_request' };
  const name = cleanDuelName(body.name);
  if (!name) return { ok: false, error: 'bad_name' };
  return { ok: true, value: { name } };
}

export function validateClientEnvelope(message){
  if (!isRecord(message)) return { ok: false, error: 'bad_message' };
  if (message.v !== DUEL_PROTOCOL_VERSION) return { ok: false, error: 'bad_version' };
  if (!CLIENT_MESSAGE_TYPES.includes(message.type)) return { ok: false, error: 'bad_type' };
  if (!Number.isSafeInteger(message.seq) || message.seq < 0 || message.seq > DUEL_LIMITS.MAX_SEQUENCE) {
    return { ok: false, error: 'bad_sequence' };
  }
  if (!isRecord(message.payload)) return { ok: false, error: 'bad_payload' };
  return {
    ok: true,
    value: { v: DUEL_PROTOCOL_VERSION, type: message.type, seq: message.seq, payload: message.payload },
  };
}

export function canTransitionRoom(from, to){
  return !!TRANSITIONS[from] && TRANSITIONS[from].includes(to);
}

export function transitionRoom(room, nextState, updatedAt){
  if (!isRecord(room) || !canTransitionRoom(room.state, nextState)) {
    throw new Error(`invalid_room_transition:${room && room.state || 'unknown'}:${nextState}`);
  }
  const timestamp = Number(updatedAt);
  return Object.freeze({
    ...room,
    state: nextState,
    updatedAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
  });
}
