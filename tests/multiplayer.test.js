import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MultiplayerClient,
  MultiplayerError,
  buildChallengeUrl,
  challengeCodeFromUrl,
  resolveMultiplayerWorkerUrl,
  withoutChallengeUrl,
} from '../js/multiplayer.js';

class MemoryStorage {
  constructor(){ this.values = new Map(); }
  getItem(key){ return this.values.get(key) ?? null; }
  setItem(key, value){ this.values.set(key, value); }
  removeItem(key){ this.values.delete(key); }
}

class FakeSocket {
  static instances = [];
  constructor(url){
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  addEventListener(type, listener){
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  emit(type, detail = {}){
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const listener of this.listeners.get(type) || []) listener(detail);
  }
  send(value){ this.sent.push(JSON.parse(value)); }
  close(code, reason){ this.emit('close', { code, reason }); }
}

function response(status, body){
  return { ok: status >= 200 && status < 300, status, async json(){ return body; } };
}

function harness(){
  const requests = [];
  const storage = new MemoryStorage();
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/matches')) return response(201, {
      ok: true, code: '7KMX-R4QP', hostToken: 'a'.repeat(48), room: { code: '7KMX-R4QP', state: 'waiting' },
    });
    if (url.endsWith('/join')) return response(200, {
      ok: true, playerToken: 'b'.repeat(48), room: { code: '7KMX-R4QP', state: 'waiting' },
    });
    if (url.endsWith('/socket-ticket')) return response(201, { ok: true, ticket: 'c'.repeat(48) });
    if (url.includes('/matches/')) return response(200, {
      ok: true, room: { code: '7KMX-R4QP', state: 'waiting', seats: { host: {}, guest: null } },
    });
    throw new Error('unexpected request');
  };
  const client = new MultiplayerClient({
    baseUrl: 'https://worker.example', fetchImpl, WebSocketImpl: FakeSocket, sessionStore: storage,
  });
  return { client, requests, storage };
}

async function nextSocket(){
  for (let i = 0; i < 8 && !FakeSocket.instances.length; i++) await Promise.resolve();
  assert.ok(FakeSocket.instances.length, 'expected a WebSocket after ticket exchange');
  return FakeSocket.instances[0];
}

test('challenge URLs parse normalized codes and strip unrelated sharing state', () => {
  const link = buildChallengeUrl('https://example.com/StackFall/?old=1#score', '7kmx r4qp');
  assert.equal(link, 'https://example.com/StackFall/?duel=7KMX-R4QP');
  assert.equal(challengeCodeFromUrl(link), '7KMX-R4QP');
  assert.equal(challengeCodeFromUrl('https://example.com/?duel=bad'), '');
  assert.equal(challengeCodeFromUrl('https://example.com/'), null);
  assert.equal(withoutChallengeUrl(link), 'https://example.com/StackFall/');
  assert.equal(
    resolveMultiplayerWorkerUrl('https://worker.example', { hostname: '127.0.0.1', protocol: 'http:' }),
    'http://127.0.0.1:8788',
  );
  assert.equal(
    resolveMultiplayerWorkerUrl('https://worker.example/', { hostname: 'game.example', protocol: 'https:' }),
    'https://worker.example',
  );
});

test('create and join keep bearer capabilities in session storage only', async () => {
  const { client, requests } = harness();
  const created = await client.create({ name: ' Host! ', difficulty: 'normal' });
  assert.equal(created.session.seat, 'host');
  assert.equal(client.session(created.session.code).token, 'a'.repeat(48));
  assert.equal(requests[0].url.includes('aaaa'), false);
  assert.deepEqual(JSON.parse(requests[0].options.body), { name: 'Host', difficulty: 'normal' });

  const joined = await client.join({ code: '7kmx r4qp', name: 'Guest' });
  assert.equal(joined.session.seat, 'guest');
  assert.equal(client.session(joined.session.code).token, 'b'.repeat(48));
});

test('connect exchanges the capability for a URL ticket and sequences messages', async () => {
  FakeSocket.instances.length = 0;
  const { client, requests } = harness();
  await client.create({ name: 'Host', difficulty: 'normal' });
  const connecting = client.connect('7KMX-R4QP');
  const socket = await nextSocket();
  assert.ok(socket.url.startsWith('wss://worker.example/matches/7KMX-R4QP/socket?ticket='));
  assert.equal(socket.url.includes('a'.repeat(48)), false);
  assert.equal(requests.at(-1).options.headers.Authorization, `Bearer ${'a'.repeat(48)}`);
  socket.emit('open');
  await connecting;

  assert.equal(client.ready(), 0);
  assert.equal(client.send('heartbeat'), 1);
  assert.deepEqual(socket.sent.map((message) => message.seq), [0, 1]);
  assert.equal(client.session('7KMX-R4QP').nextSeq, 2);
});

test('snapshots update room state and replaced sockets do not reconnect', async () => {
  FakeSocket.instances.length = 0;
  const { client } = harness();
  await client.create({ name: 'Host', difficulty: 'normal' });
  const connecting = client.connect();
  const socket = await nextSocket();
  socket.emit('open');
  await connecting;

  let snapshot = null;
  client.on('snapshot', (payload) => { snapshot = payload.room; });
  socket.emit('message', { data: JSON.stringify({
    v: 1, type: 'snapshot', payload: { room: { code: '7KMX-R4QP', state: 'waiting', you: 'host' } },
  }) });
  assert.equal(snapshot.you, 'host');
  assert.equal(client.room.you, 'host');

  socket.emit('message', { data: JSON.stringify({ v: 1, type: 'error', payload: { code: 'socket_replaced' } }) });
  socket.emit('close', { code: 4001, reason: 'replaced' });
  assert.equal(client.connection, 'replaced');
  assert.equal(FakeSocket.instances.length, 1);
});

test('leave waits for the authoritative room update before clearing the seat session', async () => {
  FakeSocket.instances.length = 0;
  const { client } = harness();
  await client.create({ name: 'Host', difficulty: 'normal' });
  const connecting = client.connect();
  const socket = await nextSocket();
  socket.emit('open');
  await connecting;

  const leaving = client.leave();
  assert.equal(socket.sent.at(-1).type, 'leave');
  assert.ok(client.session('7KMX-R4QP'));
  socket.emit('message', { data: JSON.stringify({
    v: 1,
    type: 'presence',
    payload: { room: { code: '7KMX-R4QP', state: 'cancelled', seats: { host: {}, guest: {} } } },
  }) });
  await leaving;
  assert.equal(client.session('7KMX-R4QP'), null);
  assert.equal(client.connection, 'idle');
});

test('API failures become stable multiplayer error codes', async () => {
  const client = new MultiplayerClient({
    baseUrl: 'https://worker.example',
    fetchImpl: async () => response(409, { ok: false, error: 'room_full' }),
    sessionStore: new MemoryStorage(),
  });
  await assert.rejects(
    client.join({ code: '7KMX-R4QP', name: 'Guest' }),
    (error) => error instanceof MultiplayerError && error.code === 'room_full' && error.status === 409,
  );
});
