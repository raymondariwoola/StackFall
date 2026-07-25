import test from 'node:test';
import assert from 'node:assert/strict';

import { handleMatchRequest, isAllowedMatchOrigin, randomRoomCode } from '../worker/src/match-api.js';
import { MatchRoom } from '../worker/src/match-room.js';

class FakeStorage {
  constructor(){ this.values = new Map(); this.alarm = null; }
  async get(key){ return this.values.get(key); }
  async put(key, value){ this.values.set(key, structuredClone(value)); }
  async delete(key){ this.values.delete(key); }
  async setAlarm(value){ this.alarm = value; }
  async deleteAlarm(){ this.alarm = null; }
  async deleteAll(){ this.values.clear(); this.alarm = null; }
}

class FakeState {
  constructor(){ this.storage = new FakeStorage(); this.sockets = []; }
  getWebSockets(){ return this.sockets; }
  acceptWebSocket(socket){ this.sockets.push(socket); }
}

class FakeNamespace {
  constructor(env){ this.env = env; this.rooms = new Map(); }
  idFromName(name){ return { name }; }
  get(id){
    if (!this.rooms.has(id.name)) this.rooms.set(id.name, new MatchRoom(new FakeState(), this.env));
    return this.rooms.get(id.name);
  }
}

class FakeKV {
  constructor(){ this.values = new Map(); }
  async get(key){ return this.values.get(key) || null; }
  async put(key, value){ this.values.set(key, value); }
}

function makeEnv(overrides = {}){
  const env = {
    __TEST_NOW: 1000,
    ALLOW_ORIGIN: 'https://raymondariwoola.github.io,http://127.0.0.1:8137',
    MULTIPLAYER_ENABLED: '1',
    LEADERBOARD: new FakeKV(),
    ...overrides,
  };
  env.MATCH_ROOM = new FakeNamespace(env);
  return env;
}

function request(path, { method = 'GET', body, token, ip = '' } = {}){
  const headers = { Origin: 'http://127.0.0.1:8137' };
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ip) headers['CF-Connecting-IP'] = ip;
  return new Request(`https://worker.example${path}`, {
    method, headers, body: body == null ? undefined : JSON.stringify(body),
  });
}

const cors = { 'Access-Control-Allow-Origin': 'http://127.0.0.1:8137' };

test('room code generation uses eight valid human-safe characters', () => {
  for (let i = 0; i < 50; i++) assert.match(randomRoomCode(), /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
});

test('match API creates, reads, joins, rejects a third player, and issues authorized tickets', async () => {
  const env = makeEnv();
  const createdResponse = await handleMatchRequest(request('/matches', {
    method: 'POST', body: { name: 'Host', difficulty: 'hardcore' },
  }), env, cors);
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.match(created.code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.match(created.hostToken, /^[a-f0-9]{48}$/);

  const stateResponse = await handleMatchRequest(request(`/matches/${created.code}`), env, cors);
  assert.equal(stateResponse.status, 200);
  assert.equal((await stateResponse.json()).room.difficulty, 'hardcore');

  const joinedResponse = await handleMatchRequest(request(`/matches/${created.code}/join`, {
    method: 'POST', body: { name: 'Guest' },
  }), env, cors);
  assert.equal(joinedResponse.status, 200);
  const joined = await joinedResponse.json();
  assert.match(joined.playerToken, /^[a-f0-9]{48}$/);

  const full = await handleMatchRequest(request(`/matches/${created.code}/join`, {
    method: 'POST', body: { name: 'Third' },
  }), env, cors);
  assert.equal(full.status, 409);
  assert.equal((await full.json()).error, 'room_full');

  const unauthorized = await handleMatchRequest(request(`/matches/${created.code}/socket-ticket`, {
    method: 'POST', token: '0'.repeat(48),
  }), env, cors);
  assert.equal(unauthorized.status, 401);

  const ticketResponse = await handleMatchRequest(request(`/matches/${created.code}/socket-ticket`, {
    method: 'POST', token: created.hostToken,
  }), env, cors);
  assert.equal(ticketResponse.status, 201);
  assert.match((await ticketResponse.json()).ticket, /^[a-f0-9]{48}$/);
});

test('match API rejects invalid requests, disabled service, and disallowed origins', async () => {
  const env = makeEnv();
  const invalid = await handleMatchRequest(request('/matches/not-a-code'), env, cors);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'bad_code');

  const badCreate = await handleMatchRequest(request('/matches', {
    method: 'POST', body: { name: '', difficulty: 'normal' },
  }), env, cors);
  assert.equal(badCreate.status, 400);

  env.MULTIPLAYER_ENABLED = '0';
  const disabled = await handleMatchRequest(request('/matches', {
    method: 'POST', body: { name: 'Host', difficulty: 'normal' },
  }), env, cors);
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).error, 'multiplayer_disabled');

  const forbiddenRequest = new Request('https://worker.example/matches/7KMX-R4QP/socket', {
    headers: { Origin: 'https://evil.example', Upgrade: 'websocket' },
  });
  assert.equal(isAllowedMatchOrigin(makeEnv(), forbiddenRequest), false);
  assert.equal(isAllowedMatchOrigin(makeEnv(), request('/matches/7KMX-R4QP/socket')), true);
});

test('match create rate limit uses the shared KV limiter', async () => {
  const env = makeEnv({ MATCH_CREATE_RATE_LIMIT: '1' });
  const first = await handleMatchRequest(request('/matches', {
    method: 'POST', body: { name: 'Host', difficulty: 'normal' }, ip: '192.0.2.1',
  }), env, cors);
  assert.equal(first.status, 201);
  const second = await handleMatchRequest(request('/matches', {
    method: 'POST', body: { name: 'Host', difficulty: 'normal' }, ip: '192.0.2.1',
  }), env, cors);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, 'rate_limited');
});
