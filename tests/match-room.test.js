import test from 'node:test';
import assert from 'node:assert/strict';

import { DUEL_PROTOCOL_VERSION, ROOM_STATES } from '../shared/duel-protocol.js';
import {
  MATCH_DURATIONS,
  MatchRoom,
  ROOM_STORAGE_KEY,
  TICKET_PREFIX,
  comparePlayers,
  createRoom,
  nextRoomDeadline,
  publicRoom,
  reconcileRoom,
  sha256hex,
  validateProgress,
} from '../worker/src/match-room.js';

class FakeStorage {
  constructor(){ this.values = new Map(); this.alarm = null; this.deleteAllCalled = false; }
  async get(key){ return this.values.get(key); }
  async put(key, value){ this.values.set(key, structuredClone(value)); }
  async delete(key){ this.values.delete(key); }
  async setAlarm(value){ this.alarm = value; }
  async getAlarm(){ return this.alarm; }
  async deleteAlarm(){ this.alarm = null; }
  async deleteAll(){ this.values.clear(); this.alarm = null; this.deleteAllCalled = true; }
}

class FakeSocket {
  constructor(seat){
    this.attachment = { seat, v: DUEL_PROTOCOL_VERSION };
    this.sent = [];
    this.readyState = 1;
    this.tags = [`seat:${seat}`];
  }
  serializeAttachment(value){ this.attachment = structuredClone(value); }
  deserializeAttachment(){ return structuredClone(this.attachment); }
  send(value){ this.sent.push(JSON.parse(value)); }
  close(code, reason){ this.readyState = 3; this.closed = { code, reason }; }
}

class FakeState {
  constructor(){ this.storage = new FakeStorage(); this.sockets = []; }
  getWebSockets(tag){
    return this.sockets.filter((socket) => !tag || socket.tags.includes(tag));
  }
  acceptWebSocket(socket, tags){ socket.tags = tags || []; this.sockets.push(socket); }
}

function jsonRequest(path, method = 'GET', body){
  return new Request(`https://match.internal${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
}

async function setupRoom(now = 10_000){
  const state = new FakeState();
  const env = { __TEST_NOW: now };
  const match = new MatchRoom(state, env);
  const hostTokenHash = await sha256hex('host-token');
  const init = await match.fetch(jsonRequest('/init', 'POST', {
    code: '7KMX-R4QP', hostName: 'Host', hostTokenHash, difficulty: 'normal',
  }));
  assert.equal(init.status, 201);
  return { state, env, match, hostTokenHash };
}

async function joinGuest(harness){
  const guestTokenHash = await sha256hex('guest-token');
  const response = await harness.match.fetch(jsonRequest('/join', 'POST', {
    guestName: 'Guest', guestTokenHash,
  }));
  assert.equal(response.status, 200);
  return guestTokenHash;
}

function envelope(type, seq, payload = {}){
  return JSON.stringify({ v: DUEL_PROTOCOL_VERSION, type, seq, payload });
}

async function readyAndStart(harness, hostSocket, guestSocket){
  await harness.match.webSocketMessage(hostSocket, envelope('ready', 0));
  await harness.match.webSocketMessage(guestSocket, envelope('ready', 0));
  let room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.state, ROOM_STATES.COUNTDOWN);
  harness.env.__TEST_NOW = room.startAt;
  await harness.match.alarm();
  room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.state, ROOM_STATES.PLAYING);
  return room;
}

function progress(overrides = {}){
  return {
    score: 2, floors: 1, perfects: 1, maxCombo: 1,
    combo: 1, widthRatio: 1, cheated: false, ...overrides,
  };
}

test('pure room helpers hide capabilities and enforce progress/result rules', () => {
  const room = createRoom({
    code: '7KMX-R4QP', hostName: 'Host', hostTokenHash: 'secret', difficulty: 'normal', now: 1000,
  });
  const snapshot = publicRoom(room, 'host');
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal(nextRoomDeadline(room), room.expiresAt);
  assert.equal(validateProgress(progress()).ok, true);
  assert.equal(validateProgress(progress({ floors: 0 })).error, 'bad_progress');
  assert.equal(validateProgress(progress({ widthRatio: 2 })).error, 'bad_progress');

  const host = { progress: progress({ score: 10 }) };
  const guest = { progress: progress({ score: 9 }) };
  assert.deepEqual(comparePlayers(host, guest), { winner: 'host', reason: 'score' });
});

test('room initialization is atomic, join is limited to one guest, and public state is safe', async () => {
  const harness = await setupRoom();
  const duplicate = await harness.match.fetch(jsonRequest('/init', 'POST', {
    code: '7KMX-R4QP', hostName: 'Other', hostTokenHash: 'x', difficulty: 'normal',
  }));
  assert.equal(duplicate.status, 409);

  await joinGuest(harness);
  const full = await harness.match.fetch(jsonRequest('/join', 'POST', {
    guestName: 'Third', guestTokenHash: await sha256hex('third'),
  }));
  assert.equal(full.status, 409);
  assert.equal((await full.json()).error, 'room_full');

  const stateResponse = await harness.match.fetch(jsonRequest('/state'));
  const stateBody = await stateResponse.json();
  assert.equal(stateBody.room.seats.guest.name, 'Guest');
  assert.equal(JSON.stringify(stateBody).includes('TokenHash'), false);
  assert.equal(JSON.stringify(stateBody).includes('host-token'), false);
});

test('socket tickets require a seat capability and are stored hashed', async () => {
  const harness = await setupRoom();
  await joinGuest(harness);
  const ticketHash = await sha256hex('one-use-ticket');
  const unauthorized = await harness.match.fetch(jsonRequest('/ticket', 'POST', {
    tokenHash: await sha256hex('wrong'), ticketHash, expiresAt: harness.env.__TEST_NOW + 1000,
  }));
  assert.equal(unauthorized.status, 401);

  const authorized = await harness.match.fetch(jsonRequest('/ticket', 'POST', {
    tokenHash: harness.hostTokenHash, ticketHash, expiresAt: harness.env.__TEST_NOW + 1000,
  }));
  assert.equal(authorized.status, 201);
  assert.deepEqual(await harness.state.storage.get(TICKET_PREFIX + ticketHash), {
    seat: 'host', expiresAt: harness.env.__TEST_NOW + 1000,
  });
  assert.equal([...harness.state.storage.values.keys()].some((key) => key.includes('one-use-ticket')), false);
});

test('ready messages start one seeded countdown and duplicate sequences are rejected', async () => {
  const harness = await setupRoom();
  await joinGuest(harness);
  const host = new FakeSocket('host');
  const guest = new FakeSocket('guest');
  harness.state.sockets.push(host, guest);
  await readyAndStart(harness, host, guest);

  const countdown = host.sent.find((message) => message.type === 'countdown');
  assert.equal(countdown.payload.serverTime, 10_000);

  await harness.match.webSocketMessage(host, envelope('progress', 1, progress()));
  let room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.seats.host.progress.floors, 1);
  await harness.match.webSocketMessage(host, envelope('progress', 1, progress({ floors: 2 })));
  room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.seats.host.progress.floors, 1);
  assert.equal(host.sent.at(-1).payload.code, 'duplicate_sequence');
});

test('socket message bursts are bounded per hibernation attachment', async () => {
  const harness = await setupRoom();
  harness.env.MATCH_MESSAGE_RATE_LIMIT = '10';
  const host = new FakeSocket('host');
  harness.state.sockets.push(host);

  for (let seq = 0; seq < 10; seq++){
    await harness.match.webSocketMessage(host, envelope('heartbeat', seq));
  }
  await harness.match.webSocketMessage(host, envelope('heartbeat', 10));
  assert.equal(host.sent.at(-1).type, 'error');
  assert.equal(host.sent.at(-1).payload.code, 'rate_limited');

  harness.env.__TEST_NOW += 10_000;
  await harness.match.webSocketMessage(host, envelope('heartbeat', 10));
  assert.equal(host.sent.at(-1).type, 'presence');
});

test('out-of-order messages stay rejected across a hibernation-style class restart', async () => {
  const harness = await setupRoom();
  await joinGuest(harness);
  const host = new FakeSocket('host');
  const guest = new FakeSocket('guest');
  harness.state.sockets.push(host, guest);
  await readyAndStart(harness, host, guest);

  await harness.match.webSocketMessage(host, envelope('progress', 3, progress()));
  const restarted = new MatchRoom(harness.state, harness.env);
  await restarted.webSocketMessage(host, envelope('progress', 2, progress({ score: 4, floors: 2 })));
  assert.equal(host.sent.at(-1).payload.code, 'duplicate_sequence');
  const room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.seats.host.progress.floors, 1);

  await restarted.webSocketMessage(guest, envelope('progress', 1, progress({ score: 3 })));
  assert.equal((await harness.state.storage.get(ROOM_STORAGE_KEY)).seats.guest.score, undefined);
  assert.equal((await harness.state.storage.get(ROOM_STORAGE_KEY)).seats.guest.progress.score, 3);
});

test('active sockets honor the multiplayer kill switch without exposing room data', async () => {
  const harness = await setupRoom();
  const host = new FakeSocket('host');
  harness.state.sockets.push(host);
  harness.env.MULTIPLAYER_ENABLED = '0';
  await harness.match.webSocketMessage(host, envelope('heartbeat', 0));
  assert.deepEqual(host.sent.at(-1), {
    v: DUEL_PROTOCOL_VERSION, type: 'error', payload: { code: 'multiplayer_disabled' },
  });
  assert.deepEqual(host.closed, { code: 4003, reason: 'multiplayer disabled' });
  assert.equal(JSON.stringify(host.sent).includes('Host'), false);
});

test('two finishes produce a deterministic result and two votes start a fresh round', async () => {
  const harness = await setupRoom();
  await joinGuest(harness);
  const host = new FakeSocket('host');
  const guest = new FakeSocket('guest');
  harness.state.sockets.push(host, guest);
  await readyAndStart(harness, host, guest);

  await harness.match.webSocketMessage(host, envelope('finish', 1, progress({ score: 8, floors: 3, perfects: 1 })));
  await harness.match.webSocketMessage(guest, envelope('finish', 1, progress({ score: 6, floors: 3, perfects: 1 })));
  let room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.state, ROOM_STATES.FINISHED);
  assert.equal(room.result.winner, 'host');
  await harness.match.webSocketMessage(host, envelope('rematch_vote', 2));
  await harness.match.webSocketMessage(guest, envelope('rematch_vote', 2));
  room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.state, ROOM_STATES.COUNTDOWN);
  assert.equal(room.round, 2);
  assert.ok(Number.isInteger(room.seed) && room.seed > 0);
  assert.equal(room.result, null);
});

test('leaving during the countdown immediately forfeits the round', async () => {
  const harness = await setupRoom();
  await joinGuest(harness);
  const host = new FakeSocket('host');
  const guest = new FakeSocket('guest');
  harness.state.sockets.push(host, guest);
  await harness.match.webSocketMessage(host, envelope('ready', 0));
  await harness.match.webSocketMessage(guest, envelope('ready', 0));

  await harness.match.webSocketMessage(guest, envelope('leave', 1));
  const room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.state, ROOM_STATES.FORFEIT);
  assert.equal(room.result.winner, 'host');
  assert.equal(room.result.reason, 'left');
});

test('cheated progress causes an immediate server-owned forfeit', async () => {
  const harness = await setupRoom();
  await joinGuest(harness);
  const host = new FakeSocket('host');
  const guest = new FakeSocket('guest');
  harness.state.sockets.push(host, guest);
  await readyAndStart(harness, host, guest);

  await harness.match.webSocketMessage(host, envelope('progress', 1, progress({ cheated: true })));
  const room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.state, ROOM_STATES.FORFEIT);
  assert.deepEqual(room.result.winner, 'guest');
  assert.deepEqual(room.result.reason, 'cheated');
});

test('disconnect grace expires into a forfeit and reconnect replacement avoids a false disconnect', async () => {
  const harness = await setupRoom();
  await joinGuest(harness);
  const oldHost = new FakeSocket('host');
  const guest = new FakeSocket('guest');
  harness.state.sockets.push(oldHost, guest);
  await readyAndStart(harness, oldHost, guest);

  const replacement = new FakeSocket('host');
  harness.state.sockets.push(replacement);
  oldHost.serializeAttachment({ ...oldHost.deserializeAttachment(), replaced: true });
  await harness.match.webSocketClose(oldHost, 4001, 'replaced', true);
  let room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.seats.host.disconnectedAt, null);

  await harness.match.webSocketClose(replacement, 1000, 'gone', true);
  room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.seats.host.disconnectedAt, harness.env.__TEST_NOW);
  harness.env.__TEST_NOW += MATCH_DURATIONS.DISCONNECT_GRACE_MS;
  await harness.match.alarm();
  room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  assert.equal(room.state, ROOM_STATES.FORFEIT);
  assert.equal(room.result.winner, 'guest');
  assert.equal(room.result.reason, 'disconnect');
});

test('expired alarms close sockets and delete all Durable Object storage', async () => {
  const harness = await setupRoom();
  const host = new FakeSocket('host');
  harness.state.sockets.push(host);
  const room = await harness.state.storage.get(ROOM_STORAGE_KEY);
  harness.env.__TEST_NOW = room.expiresAt;
  await harness.match.alarm();

  assert.equal(await harness.state.storage.get(ROOM_STORAGE_KEY), undefined);
  assert.equal(harness.state.storage.deleteAllCalled, true);
  assert.deepEqual(host.closed, { code: 4000, reason: 'expired' });
});

test('reconciliation moves countdowns to play and expires stale rooms', () => {
  const room = createRoom({
    code: '7KMX-R4QP', hostName: 'Host', hostTokenHash: 'secret', difficulty: 'normal', now: 1000,
  });
  room.seats.guest = structuredClone(room.seats.host);
  room.seats.guest.id = 'guest';
  room.seats.host.ready = room.seats.guest.ready = true;
  room.state = ROOM_STATES.COUNTDOWN;
  room.startAt = 2000;
  room.expiresAt = 5000;
  const playing = reconcileRoom(room, 2000);
  assert.equal(playing.room.state, ROOM_STATES.PLAYING);
  assert.equal(playing.changed, true);
  assert.equal(reconcileRoom(playing.room, playing.room.expiresAt).expired, true);
});
