import test from 'node:test';
import assert from 'node:assert/strict';

import { handleChallengeRequest } from '../worker/src/challenge-api.js';
import {
  CHALLENGE_DRAFT_MS,
  CHALLENGE_DURATION_MS,
  CHALLENGE_STORAGE_KEY,
  ChallengeRoom,
} from '../worker/src/challenge-room.js';
import { sha256hex } from '../worker/src/match-room.js';

class FakeStorage {
  constructor(){ this.values = new Map(); this.alarm = null; this.deleted = false; }
  async get(key){ return this.values.get(key); }
  async put(key, value){ this.values.set(key, structuredClone(value)); }
  async setAlarm(value){ this.alarm = value; }
  async deleteAlarm(){ this.alarm = null; }
  async deleteAll(){ this.values.clear(); this.alarm = null; this.deleted = true; }
}

class FakeState { constructor(){ this.storage = new FakeStorage(); } }

class FakeNamespace {
  constructor(env){ this.env = env; this.rooms = new Map(); }
  idFromName(name){ return { name }; }
  get(id){
    if (!this.rooms.has(id.name)) this.rooms.set(id.name, new ChallengeRoom(new FakeState(), this.env));
    return this.rooms.get(id.name);
  }
}

class FakeKV {
  constructor(){ this.values = new Map(); }
  async get(key){ return this.values.get(key) || null; }
  async put(key, value){ this.values.set(key, value); }
}

function progress(overrides = {}){
  return {
    score: 12, floors: 5, perfects: 2, maxCombo: 2,
    combo: 0, widthRatio: 0.6, cheated: false, ...overrides,
  };
}

function internal(path, method = 'GET', value){
  return new Request(`https://challenge.internal${path}`, {
    method,
    headers: value == null ? undefined : { 'Content-Type': 'application/json' },
    body: value == null ? undefined : JSON.stringify(value),
  });
}

test('challenge expires drafts quickly, accepts one run each, and cleans up', async () => {
  const state = new FakeState();
  const env = { __TEST_NOW: 10_000 };
  const room = new ChallengeRoom(state, env);
  const hostTokenHash = await sha256hex('host-token');
  const guestTokenHash = await sha256hex('guest-token');
  const init = await room.fetch(internal('/init', 'POST', {
    code: '7KMX-R4QP', hostName: 'Host', hostTokenHash, difficulty: 'hardcore',
  }));
  assert.equal(init.status, 201);
  const created = (await init.json()).challenge;
  assert.equal(created.state, 'host_playing');
  assert.equal(created.expiresAt, 10_000 + CHALLENGE_DRAFT_MS);
  assert.equal(JSON.stringify(created).includes('TokenHash'), false);

  const earlyJoin = await room.fetch(internal('/join', 'POST', {
    guestName: 'Guest', guestTokenHash,
  }));
  assert.equal(earlyJoin.status, 409);
  assert.equal((await earlyJoin.json()).error, 'challenge_not_ready');

  const hostFinish = await room.fetch(internal('/finish', 'POST', {
    tokenHash: hostTokenHash, progress: progress(),
  }));
  assert.equal(hostFinish.status, 200);
  const opened = (await hostFinish.json()).challenge;
  assert.equal(opened.state, 'open');
  assert.equal(opened.expiresAt, 10_000 + CHALLENGE_DURATION_MS);

  const join = await room.fetch(internal('/join', 'POST', {
    guestName: 'Guest', guestTokenHash,
  }));
  assert.equal(join.status, 200);
  const guestFinish = await room.fetch(internal('/finish', 'POST', {
    tokenHash: guestTokenHash, progress: progress({ score: 15 }),
  }));
  const completed = (await guestFinish.json()).challenge;
  assert.equal(completed.state, 'finished');
  assert.deepEqual(completed.result.winner, 'guest');

  const replay = await room.fetch(internal('/finish', 'POST', {
    tokenHash: guestTokenHash, progress: progress({ score: 20 }),
  }));
  assert.equal(replay.status, 409);
  env.__TEST_NOW = opened.expiresAt;
  await room.alarm();
  assert.equal(state.storage.deleted, true);
  assert.equal(await state.storage.get(CHALLENGE_STORAGE_KEY), undefined);
});

function apiRequest(path, { method = 'GET', body, token } = {}){
  const headers = { Origin: 'http://127.0.0.1:8137' };
  if (body != null) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request(`https://worker.example${path}`, {
    method, headers, body: body == null ? undefined : JSON.stringify(body),
  });
}

test('challenge API keeps capabilities private and supports the full delayed flow', async () => {
  const env = { __TEST_NOW: 1000, MULTIPLAYER_ENABLED: '1', LEADERBOARD: new FakeKV() };
  env.CHALLENGE_ROOM = new FakeNamespace(env);
  const cors = { 'Access-Control-Allow-Origin': 'http://127.0.0.1:8137' };
  const create = await handleChallengeRequest(apiRequest('/challenges', {
    method: 'POST', body: { name: 'Host', difficulty: 'normal' },
  }), env, cors);
  assert.equal(create.status, 201);
  const host = await create.json();
  assert.match(host.hostToken, /^[a-f0-9]{48}$/);
  assert.equal(JSON.stringify(host.challenge).includes('Token'), false);

  const finish = await handleChallengeRequest(apiRequest(`/challenges/${host.code}/finish`, {
    method: 'POST', token: host.hostToken, body: progress(),
  }), env, cors);
  assert.equal(finish.status, 200);
  const join = await handleChallengeRequest(apiRequest(`/challenges/${host.code}/join`, {
    method: 'POST', body: { name: 'Guest' },
  }), env, cors);
  assert.equal(join.status, 200);
  const guest = await join.json();
  assert.match(guest.guestToken, /^[a-f0-9]{48}$/);
  const result = await handleChallengeRequest(apiRequest(`/challenges/${host.code}/finish`, {
    method: 'POST', token: guest.guestToken, body: progress({ score: 1 }),
  }), env, cors);
  assert.equal((await result.json()).challenge.result.winner, 'host');

  env.MULTIPLAYER_ENABLED = '0';
  const disabled = await handleChallengeRequest(apiRequest('/challenges', {
    method: 'POST', body: { name: 'Host', difficulty: 'normal' },
  }), env, cors);
  assert.equal(disabled.status, 503);
});
