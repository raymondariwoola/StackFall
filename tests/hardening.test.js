import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/index.js';
import { rateLimit } from '../worker/src/rate-limit.js';
import { safeErrorEvent, safeMetricEvent } from '../worker/src/safe-log.js';

class FakeKV {
  constructor(){ this.values = new Map(); }
  async get(key){ return this.values.get(key) || null; }
  async put(key, value){ this.values.set(key, value); }
}

test('health exposes anonymous multiplayer guardrails and kill-switch state', async () => {
  const response = await worker.fetch(new Request('https://worker.example/'), {
    MULTIPLAYER_ENABLED: '0', MATCH_CREATE_RATE_LIMIT: '7', MATCH_TICKET_RATE_LIMIT: '12',
  });
  const body = await response.json();
  assert.equal(body.multiplayer.enabled, false);
  assert.equal(body.multiplayer.protocol, 1);
  assert.equal(body.multiplayer.maxMessageBytes, 4096);
  assert.equal(body.multiplayer.createPerMinute, 7);
  assert.equal(body.multiplayer.ticketsPerMinute, 12);
  assert.equal(JSON.stringify(body).includes('token'), false);
});

test('multiplayer kill switch leaves leaderboard reads available', async () => {
  const env = { MULTIPLAYER_ENABLED: '0', LEADERBOARD: new FakeKV() };
  const matches = await worker.fetch(new Request('https://worker.example/matches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Host', difficulty: 'normal' }),
  }), env);
  assert.equal(matches.status, 503);
  assert.equal((await matches.json()).error, 'multiplayer_disabled');

  const leaderboard = await worker.fetch(
    new Request('https://worker.example/leaderboard?difficulty=normal'), env,
  );
  assert.equal(leaderboard.status, 200);
});

test('admin credentials are accepted only in a header, never in a URL', async () => {
  const env = { ADMIN_KEY: 'phase-four-secret', LEADERBOARD: new FakeKV() };
  const queryResponse = await worker.fetch(
    new Request('https://worker.example/admin/boards?key=phase-four-secret'),
    env,
  );
  assert.equal(queryResponse.status, 403);

  const headerResponse = await worker.fetch(new Request('https://worker.example/admin/boards', {
    headers: { 'X-Admin-Key': 'phase-four-secret' },
  }), env);
  assert.equal(headerResponse.status, 200);
});

test('safe operational events cannot serialize names, tokens, URLs, or stacks', () => {
  const secret = 'a'.repeat(48);
  const error = new Error(`GuestName ${secret} https://worker/matches/X?ticket=${secret}`);
  const rendered = JSON.stringify(safeErrorEvent('match failed!', error));
  assert.equal(rendered.includes('GuestName'), false);
  assert.equal(rendered.includes(secret), false);
  assert.equal(rendered.includes('https'), false);
  assert.deepEqual(safeMetricEvent('rate limited', { bucket: 'match-ticket', limit: 60 }), {
    event: 'ratelimited', bucket: 'match-ticket', limit: 60,
  });
});

test('rate-limit telemetry is anonymous and reports bounded counters', async () => {
  const env = { LEADERBOARD: new FakeKV() };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...values) => warnings.push(JSON.stringify(values));
  try {
    const first = await rateLimit(env, 'match-ticket', '192.0.2.45', 1, 60);
    const second = await rateLimit(env, 'match-ticket', '192.0.2.45', 1, 60);
    assert.deepEqual({ ok: first.ok, limit: first.limit, remaining: first.remaining }, {
      ok: true, limit: 1, remaining: 0,
    });
    assert.equal(second.ok, false);
    assert.equal(second.remaining, 0);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes('192.0.2.45'), false);
  } finally { console.warn = originalWarn; }
});
