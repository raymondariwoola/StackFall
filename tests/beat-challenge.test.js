import test from 'node:test';
import assert from 'node:assert/strict';

import { BeatChallengeClient, beatCodeFromUrl, buildBeatUrl } from '../js/beat-challenge.js';

class MemoryStorage {
  constructor(){ this.values = new Map(); }
  getItem(key){ return this.values.get(key) ?? null; }
  setItem(key, value){ this.values.set(key, value); }
  removeItem(key){ this.values.delete(key); }
}

function response(status, body){
  return { ok: status >= 200 && status < 300, status, async json(){ return body; } };
}

test('Beat My Tower URLs contain only the public code', () => {
  const url = buildBeatUrl('https://example.com/StackFall/?duel=OLD#score', '7kmx r4qp');
  assert.equal(url, 'https://example.com/StackFall/?beat=7KMX-R4QP');
  assert.equal(beatCodeFromUrl(url), '7KMX-R4QP');
  assert.equal(url.includes('token'), false);
});

test('challenge client keeps capabilities in session storage and submits one final', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/challenges')) return response(201, {
      ok: true, code: '7KMX-R4QP', hostToken: 'a'.repeat(48),
      challenge: { kind: 'beat', code: '7KMX-R4QP', state: 'host_playing', seed: 42 },
    });
    if (url.endsWith('/finish')) return response(200, {
      ok: true, challenge: { kind: 'beat', code: '7KMX-R4QP', state: 'open', seed: 42 },
    });
    throw new Error('unexpected request');
  };
  const storage = new MemoryStorage();
  const client = new BeatChallengeClient({ baseUrl: 'https://worker.example', fetchImpl, sessionStore: storage });
  const { session } = await client.create({ name: 'Host', difficulty: 'normal' });
  assert.equal(session.token, 'a'.repeat(48));
  assert.equal(requests[0].options.body.includes(session.token), false);
  await client.finish({ score: 5, floors: 2, perfects: 1, maxCombo: 1, combo: 0, widthRatio: 0.5 });
  assert.equal(requests[1].options.headers.Authorization, `Bearer ${session.token}`);
  assert.equal(client.challenge.state, 'open');
});
