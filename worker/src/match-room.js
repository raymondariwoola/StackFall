import {
  DUEL_LIMITS,
  DUEL_PROTOCOL_VERSION,
  DUEL_SOCKET_PROTOCOL,
  ROOM_STATES,
  transitionRoom,
  validateClientEnvelope,
  ticketFromSocketProtocols,
} from '../../shared/duel-protocol.js';
import { safeErrorEvent } from './safe-log.js';

export const ROOM_STORAGE_KEY = 'room';
export const TICKET_PREFIX = 'ticket:';
export const MATCH_DURATIONS = Object.freeze({
  WAITING_MS: 2 * 60 * 60 * 1000,
  COUNTDOWN_MS: 3000,
  ACTIVE_MS: 20 * 60 * 1000,
  DISCONNECT_GRACE_MS: 30 * 1000,
  FINISHED_MS: 15 * 60 * 1000,
  TICKET_MS: 60 * 1000,
});
export const MESSAGE_RATE_WINDOW_MS = 10 * 1000;
export const DEFAULT_MESSAGE_RATE_LIMIT = 60;

const MAX_DUEL_SCORE = 1_000_000;
const MAX_DUEL_FLOORS = 100_000;

function isRecord(value){
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nowFor(env){
  const testNow = Number(env && env.__TEST_NOW);
  return Number.isFinite(testNow) ? testNow : Date.now();
}

function messageRateLimit(env){
  const configured = Number(env && env.MATCH_MESSAGE_RATE_LIMIT);
  return Number.isInteger(configured) && configured >= 10 && configured <= 300
    ? configured
    : DEFAULT_MESSAGE_RATE_LIMIT;
}

function consumeMessageAllowance(ws, env, now){
  const attachment = ws.deserializeAttachment() || {};
  const windowStart = Number(attachment.messageWindowStart);
  if (!Number.isFinite(windowStart) || now - windowStart >= MESSAGE_RATE_WINDOW_MS || now < windowStart){
    attachment.messageWindowStart = now;
    attachment.messageCount = 0;
  }
  attachment.messageCount = (Number(attachment.messageCount) || 0) + 1;
  ws.serializeAttachment(attachment);
  return attachment.messageCount <= messageRateLimit(env);
}

function emptyProgress(){
  return { score: 0, floors: 0, perfects: 0, maxCombo: 0, combo: 0, widthRatio: 1 };
}

function makeSeat(id, name, tokenHash, now){
  return {
    id,
    name,
    tokenHash,
    ready: false,
    connected: false,
    disconnectedAt: null,
    lastSeenAt: now,
    lastSeq: -1,
    progress: emptyProgress(),
    finished: false,
    finishedAt: null,
    forfeited: false,
    rematch: false,
  };
}

export function createRoom({ code, hostName, hostTokenHash, difficulty, now }){
  return {
    v: DUEL_PROTOCOL_VERSION,
    code,
    state: ROOM_STATES.WAITING,
    round: 1,
    difficulty,
    seed: null,
    startAt: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + MATCH_DURATIONS.WAITING_MS,
    seats: {
      host: makeSeat('host', hostName, hostTokenHash, now),
      guest: null,
    },
    result: null,
  };
}

function publicSeat(seat){
  if (!seat) return null;
  return {
    id: seat.id,
    name: seat.name,
    ready: seat.ready,
    connected: seat.connected,
    progress: { ...seat.progress },
    finished: seat.finished,
    forfeited: seat.forfeited,
    rematch: seat.rematch,
  };
}

export function publicRoom(room, you = null){
  return {
    v: room.v,
    code: room.code,
    state: room.state,
    round: room.round,
    difficulty: room.difficulty,
    seed: room.seed,
    startAt: room.startAt,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    expiresAt: room.expiresAt,
    you,
    seats: {
      host: publicSeat(room.seats.host),
      guest: publicSeat(room.seats.guest),
    },
    result: room.result ? { ...room.result } : null,
  };
}

export function validateProgress(payload, previous = emptyProgress(), { finish = false } = {}){
  if (!isRecord(payload)) return { ok: false, error: 'bad_progress' };
  const integerFields = ['score', 'floors', 'perfects', 'maxCombo', 'combo'];
  for (const key of integerFields){
    if (!Number.isSafeInteger(payload[key]) || payload[key] < 0) {
      return { ok: false, error: 'bad_progress' };
    }
  }
  if (payload.score > MAX_DUEL_SCORE || payload.floors > MAX_DUEL_FLOORS ||
      payload.perfects > payload.floors || payload.maxCombo > payload.floors ||
      payload.combo > payload.maxCombo || !Number.isFinite(payload.widthRatio) ||
      payload.widthRatio < 0 || payload.widthRatio > 1) {
    return { ok: false, error: 'bad_progress' };
  }
  if (payload.score < previous.score || payload.floors < previous.floors ||
      payload.perfects < previous.perfects || payload.maxCombo < previous.maxCombo ||
      (!finish && payload.floors <= previous.floors)) {
    return { ok: false, error: 'progress_regression' };
  }
  return {
    ok: true,
    value: {
      score: payload.score,
      floors: payload.floors,
      perfects: payload.perfects,
      maxCombo: payload.maxCombo,
      combo: payload.combo,
      widthRatio: payload.widthRatio,
    },
    cheated: payload.cheated === true,
  };
}

export function comparePlayers(host, guest){
  const fields = [
    ['score', 'score'],
    ['floors', 'floors'],
    ['perfects', 'perfects'],
    ['maxCombo', 'max_combo'],
  ];
  for (const [field, reason] of fields){
    const a = host.progress[field];
    const b = guest.progress[field];
    if (a !== b) return { winner: a > b ? 'host' : 'guest', reason };
  }
  return { winner: null, reason: 'draw' };
}

function randomSeed(){
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] || 1;
}

function resetSeatForRound(seat, now){
  if (!seat) return;
  seat.ready = true;
  seat.progress = emptyProgress();
  seat.finished = false;
  seat.finishedAt = null;
  seat.forfeited = false;
  seat.rematch = false;
  seat.lastSeenAt = now;
}

export function startCountdown(room, now, { rematch = false } = {}){
  resetSeatForRound(room.seats.host, now);
  resetSeatForRound(room.seats.guest, now);
  return {
    ...transitionRoom(room, ROOM_STATES.COUNTDOWN, now),
    round: room.round + (rematch ? 1 : 0),
    seed: randomSeed(),
    startAt: now + MATCH_DURATIONS.COUNTDOWN_MS,
    expiresAt: now + MATCH_DURATIONS.COUNTDOWN_MS + MATCH_DURATIONS.ACTIVE_MS,
    result: null,
  };
}

function finishRoom(room, now){
  const comparison = comparePlayers(room.seats.host, room.seats.guest);
  return {
    ...transitionRoom(room, ROOM_STATES.FINISHED, now),
    expiresAt: now + MATCH_DURATIONS.FINISHED_MS,
    result: { ...comparison, finishedAt: now },
  };
}

function forfeitRoom(room, losers, now, reason = 'forfeit'){
  const loserSet = new Set(Array.isArray(losers) ? losers : [losers]);
  for (const id of loserSet){
    const seat = room.seats[id];
    if (seat){ seat.forfeited = true; seat.finished = true; seat.finishedAt = now; }
  }
  const winner = loserSet.size === 1
    ? (loserSet.has('host') ? (room.seats.guest ? 'guest' : null) : 'host')
    : null;
  return {
    ...transitionRoom(room, ROOM_STATES.FORFEIT, now),
    expiresAt: now + MATCH_DURATIONS.FINISHED_MS,
    result: {
      winner,
      reason: loserSet.size > 1 ? 'both_disconnected' : reason,
      loser: loserSet.size === 1 ? [...loserSet][0] : null,
      finishedAt: now,
    },
  };
}

export function nextRoomDeadline(room){
  const deadlines = [room.expiresAt];
  if (room.state === ROOM_STATES.COUNTDOWN && room.startAt) deadlines.push(room.startAt);
  if (room.state === ROOM_STATES.COUNTDOWN || room.state === ROOM_STATES.PLAYING){
    for (const seat of [room.seats.host, room.seats.guest]){
      if (seat && seat.disconnectedAt != null) {
        deadlines.push(seat.disconnectedAt + MATCH_DURATIONS.DISCONNECT_GRACE_MS);
      }
    }
  }
  return Math.min(...deadlines.filter((value) => Number.isFinite(value)));
}

export function reconcileRoom(room, now){
  if (now >= room.expiresAt) return { room: null, expired: true, changed: false };
  let next = room;
  let changed = false;

  if (next.state === ROOM_STATES.COUNTDOWN && next.startAt != null && now >= next.startAt){
    next = {
      ...transitionRoom(next, ROOM_STATES.PLAYING, now),
      expiresAt: now + MATCH_DURATIONS.ACTIVE_MS,
    };
    changed = true;
  }

  if (next.state === ROOM_STATES.COUNTDOWN || next.state === ROOM_STATES.PLAYING){
    const disconnected = ['host', 'guest'].filter((id) => {
      const seat = next.seats[id];
      return seat && seat.disconnectedAt != null &&
        now >= seat.disconnectedAt + MATCH_DURATIONS.DISCONNECT_GRACE_MS;
    });
    if (disconnected.length){
      next = forfeitRoom(next, disconnected, now, 'disconnect');
      changed = true;
    }
  }

  return { room: next, expired: false, changed };
}

export async function sha256hex(value){
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200){
  return Response.json(body, { status });
}

export class MatchRoom {
  constructor(state, env){
    this.state = state;
    this.env = env;
  }

  async fetch(request){
    const url = new URL(request.url);
    const now = nowFor(this.env);

    if (url.pathname === '/init' && request.method === 'POST'){
      const existing = await this.state.storage.get(ROOM_STORAGE_KEY);
      if (existing && now < existing.expiresAt) return json({ ok: false, error: 'code_conflict' }, 409);
      if (existing) await this._deleteAll('expired');
      const body = await request.json();
      const room = createRoom({ ...body, now });
      await this._save(room);
      return json({ ok: true, room: publicRoom(room, 'host') }, 201);
    }

    const room = await this._loadAndReconcile();
    if (!room) return json({ ok: false, error: 'room_not_found' }, 404);

    if (url.pathname === '/state' && request.method === 'GET'){
      return json({ ok: true, room: publicRoom(room) });
    }

    if (url.pathname === '/join' && request.method === 'POST'){
      if (room.state !== ROOM_STATES.WAITING) return json({ ok: false, error: 'room_started' }, 409);
      if (room.seats.guest) return json({ ok: false, error: 'room_full' }, 409);
      const body = await request.json();
      room.seats.guest = makeSeat('guest', body.guestName, body.guestTokenHash, now);
      room.updatedAt = now;
      await this._save(room);
      await this._broadcast('player_joined', { room: publicRoom(room) });
      return json({ ok: true, seat: 'guest', room: publicRoom(room, 'guest') }, 200);
    }

    if (url.pathname === '/ticket' && request.method === 'POST'){
      const body = await request.json();
      const seat = this._seatForToken(room, body.tokenHash);
      if (!seat) return json({ ok: false, error: 'unauthorized' }, 401);
      if (!/^[a-f0-9]{64}$/.test(body.ticketHash || '')) return json({ ok: false, error: 'bad_ticket' }, 400);
      const expiresAt = Math.min(Number(body.expiresAt) || 0, now + MATCH_DURATIONS.TICKET_MS);
      if (expiresAt <= now) return json({ ok: false, error: 'bad_ticket' }, 400);
      await this.state.storage.put(TICKET_PREFIX + body.ticketHash, { seat: seat.id, expiresAt });
      return json({ ok: true, seat: seat.id, expiresAt }, 201);
    }

    if (url.pathname === '/socket' && request.method === 'GET'){
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return json({ ok: false, error: 'upgrade_required' }, 426);
      }
      const ticket = ticketFromSocketProtocols(request.headers.get('Sec-WebSocket-Protocol'));
      const ticketHash = await sha256hex(ticket);
      const stored = await this.state.storage.get(TICKET_PREFIX + ticketHash);
      if (!stored || stored.expiresAt <= now) {
        if (stored) await this.state.storage.delete(TICKET_PREFIX + ticketHash);
        return json({ ok: false, error: 'invalid_ticket' }, 401);
      }
      await this.state.storage.delete(TICKET_PREFIX + ticketHash); // one use
      const seat = room.seats[stored.seat];
      if (!seat) return json({ ok: false, error: 'invalid_ticket' }, 401);

      for (const socket of this.state.getWebSockets(`seat:${seat.id}`)){
        try {
          const attachment = socket.deserializeAttachment() || {};
          socket.serializeAttachment({ ...attachment, replaced: true });
          socket.send(JSON.stringify(this._message('error', { code: 'socket_replaced' })));
          socket.close(4001, 'replaced');
        } catch (e) { /* stale socket */ }
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server, [`seat:${seat.id}`]);
      server.serializeAttachment({
        seat: seat.id,
        joinedAt: now,
        v: DUEL_PROTOCOL_VERSION,
        messageWindowStart: now,
        messageCount: 0,
      });
      seat.connected = true;
      seat.disconnectedAt = null;
      seat.lastSeenAt = now;
      room.updatedAt = now;
      await this._save(room);
      await this._broadcast('presence', { room: publicRoom(room) });
      server.send(JSON.stringify(this._message('snapshot', { room: publicRoom(room, seat.id) })));
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'Sec-WebSocket-Protocol': DUEL_SOCKET_PROTOCOL },
      });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  }

  async webSocketMessage(ws, raw){
    try {
      if ((this.env.MULTIPLAYER_ENABLED || '1') === '0'){
        this._sendError(ws, 'multiplayer_disabled');
        try { ws.close(4003, 'multiplayer disabled'); } catch (e) { /* already closed */ }
        return;
      }
      if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > DUEL_LIMITS.MAX_MESSAGE_BYTES) {
        return this._sendError(ws, 'message_too_large');
      }
      const now = nowFor(this.env);
      if (!consumeMessageAllowance(ws, this.env, now)) return this._sendError(ws, 'rate_limited');
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return this._sendError(ws, 'bad_json'); }
      const checked = validateClientEnvelope(parsed);
      if (!checked.ok) return this._sendError(ws, checked.error);

      const attachment = ws.deserializeAttachment() || {};
      if (attachment.replaced) return this._sendError(ws, 'socket_replaced');
      let room = await this._loadAndReconcile();
      if (!room) return this._sendError(ws, 'room_not_found');
      const seat = room.seats[attachment.seat];
      if (!seat) return this._sendError(ws, 'unauthorized');
      const message = checked.value;
      if (message.seq <= seat.lastSeq) return this._sendError(ws, 'duplicate_sequence');
      if (message.type === 'ready'){
        if (room.state !== ROOM_STATES.WAITING || !room.seats.guest) return this._sendError(ws, 'not_readyable');
        seat.ready = true;
        seat.lastSeq = message.seq;
        seat.lastSeenAt = now;
        room.updatedAt = now;
        if (room.seats.host.ready && room.seats.guest.ready){
          room = startCountdown(room, now);
          await this._save(room);
          await this._broadcast('countdown', {
            seed: room.seed, startAt: room.startAt, round: room.round,
            difficulty: room.difficulty, serverTime: now,
          });
        } else {
          await this._save(room);
          await this._broadcast('presence', { room: publicRoom(room) });
        }
        return;
      }

      if (message.type === 'progress' || message.type === 'finish'){
        if (room.state !== ROOM_STATES.PLAYING) return this._sendError(ws, 'not_playing');
        const finish = message.type === 'finish';
        const progress = validateProgress(message.payload, seat.progress, { finish });
        if (!progress.ok) return this._sendError(ws, progress.error);
        seat.lastSeq = message.seq;
        seat.lastSeenAt = now;
        seat.progress = progress.value;

        if (progress.cheated){
          room = forfeitRoom(room, seat.id, now, 'cheated');
          await this._save(room);
          await this._broadcast('result', { room: publicRoom(room) });
          return;
        }

        if (finish){
          seat.finished = true;
          seat.finishedAt = now;
          if (room.seats.host.finished && room.seats.guest.finished){
            room = finishRoom(room, now);
            await this._save(room);
            await this._broadcast('result', { room: publicRoom(room) });
          } else {
            room.updatedAt = now;
            await this._save(room);
            await this._sendOthers(seat.id, 'opponent_finished', { seat: seat.id, progress: seat.progress });
          }
        } else {
          room.updatedAt = now;
          await this._save(room);
          await this._sendOthers(seat.id, 'opponent_progress', { seat: seat.id, progress: seat.progress });
        }
        return;
      }

      if (message.type === 'heartbeat'){
        seat.lastSeq = message.seq;
        seat.lastSeenAt = now;
        await this._save(room);
        ws.send(JSON.stringify(this._message('presence', { serverTime: now })));
        return;
      }

      if (message.type === 'rematch_vote'){
        if (room.state !== ROOM_STATES.FINISHED && room.state !== ROOM_STATES.FORFEIT) {
          return this._sendError(ws, 'rematch_unavailable');
        }
        seat.lastSeq = message.seq;
        seat.rematch = true;
        seat.lastSeenAt = now;
        if (room.seats.host.rematch && room.seats.guest.rematch){
          room = startCountdown(room, now, { rematch: true });
          await this._save(room);
          await this._broadcast('countdown', {
            seed: room.seed, startAt: room.startAt, round: room.round,
            difficulty: room.difficulty, serverTime: now,
          });
        } else {
          room.updatedAt = now;
          await this._save(room);
          await this._broadcast('presence', { room: publicRoom(room) });
        }
        return;
      }

      if (message.type === 'leave'){
        seat.lastSeq = message.seq;
        if (room.state === ROOM_STATES.WAITING){
          if (seat.id === 'host'){
            room = { ...transitionRoom(room, ROOM_STATES.CANCELLED, now), expiresAt: now + MATCH_DURATIONS.FINISHED_MS };
          } else {
            room.seats.guest = null;
            room.updatedAt = now;
          }
        } else if (room.state === ROOM_STATES.COUNTDOWN || room.state === ROOM_STATES.PLAYING){
          room = forfeitRoom(room, seat.id, now, 'left');
        }
        await this._save(room);
        await this._broadcast(room.result ? 'result' : 'presence', { room: publicRoom(room) });
      }
    } catch (error){
      console.error('stackfall_error', safeErrorEvent('match_message_failed', error));
      this._sendError(ws, 'server_error');
    }
  }

  async webSocketClose(ws, code, reason, wasClean){
    const attachment = ws.deserializeAttachment() || {};
    const room = await this._loadAndReconcile();
    if (!room || !room.seats[attachment.seat]) return;

    const otherOpen = this.state.getWebSockets(`seat:${attachment.seat}`)
      .some((candidate) => candidate !== ws && candidate.readyState === 1 &&
        !(candidate.deserializeAttachment() || {}).replaced);
    if (otherOpen) return;

    const now = nowFor(this.env);
    const seat = room.seats[attachment.seat];
    seat.connected = false;
    if (room.state === ROOM_STATES.COUNTDOWN || room.state === ROOM_STATES.PLAYING) {
      seat.disconnectedAt = now;
    }
    room.updatedAt = now;
    await this._save(room);
    await this._broadcast('presence', { room: publicRoom(room) });
    try { ws.close(code, reason); } catch (e) { /* already closed */ }
  }

  async webSocketError(ws, error){
    console.error('stackfall_error', safeErrorEvent('match_transport_failed', error));
    await this.webSocketClose(ws, 1011, 'socket error', false);
  }

  async alarm(){
    const room = await this.state.storage.get(ROOM_STORAGE_KEY);
    if (!room) return;
    const outcome = reconcileRoom(room, nowFor(this.env));
    if (outcome.expired){
      await this._broadcast('expired', { code: room.code });
      await this._deleteAll('expired');
      return;
    }
    if (outcome.changed){
      await this._save(outcome.room);
      await this._broadcast(outcome.room.result ? 'result' : 'snapshot', { room: publicRoom(outcome.room) });
    } else {
      await this._schedule(room);
    }
  }

  _seatForToken(room, tokenHash){
    if (!/^[a-f0-9]{64}$/.test(tokenHash || '')) return null;
    if (room.seats.host.tokenHash === tokenHash) return room.seats.host;
    if (room.seats.guest && room.seats.guest.tokenHash === tokenHash) return room.seats.guest;
    return null;
  }

  async _loadAndReconcile(){
    const room = await this.state.storage.get(ROOM_STORAGE_KEY);
    if (!room) return null;
    const outcome = reconcileRoom(room, nowFor(this.env));
    if (outcome.expired){
      await this._deleteAll('expired');
      return null;
    }
    if (outcome.changed){
      await this._save(outcome.room);
      await this._broadcast(outcome.room.result ? 'result' : 'snapshot', { room: publicRoom(outcome.room) });
    }
    return outcome.room;
  }

  async _save(room){
    await this.state.storage.put(ROOM_STORAGE_KEY, room);
    await this._schedule(room);
  }

  async _schedule(room){
    const deadline = nextRoomDeadline(room);
    if (Number.isFinite(deadline)) await this.state.storage.setAlarm(deadline);
  }

  async _deleteAll(reason){
    for (const socket of this.state.getWebSockets()){
      try { socket.close(4000, reason); } catch (e) { /* stale socket */ }
    }
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }

  _message(type, payload){
    return { v: DUEL_PROTOCOL_VERSION, type, payload };
  }

  _sendError(ws, code){
    try { ws.send(JSON.stringify(this._message('error', { code }))); } catch (e) { /* closed */ }
  }

  async _broadcast(type, payload){
    const data = JSON.stringify(this._message(type, payload));
    for (const socket of this.state.getWebSockets()){
      if ((socket.deserializeAttachment() || {}).replaced) continue;
      try { socket.send(data); } catch (e) { /* stale socket */ }
    }
  }

  async _sendOthers(seatId, type, payload){
    const data = JSON.stringify(this._message(type, payload));
    for (const socket of this.state.getWebSockets()){
      const attachment = socket.deserializeAttachment() || {};
      if (attachment.replaced || attachment.seat === seatId) continue;
      try { socket.send(data); } catch (e) { /* stale socket */ }
    }
  }
}
