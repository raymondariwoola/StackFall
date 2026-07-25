import assert from 'node:assert/strict';
import WebSocket from 'ws';

// Run against a separately started local Wrangler instance.

const HTTP_BASE = process.env.STACKFALL_WORKER_URL || 'http://127.0.0.1:8788';
const WS_BASE = HTTP_BASE.replace(/^http/, 'ws');
const ORIGIN = process.env.STACKFALL_TEST_ORIGIN || 'http://127.0.0.1:8137';
const TIMEOUT_MS = 5000;

async function api(path, options = {}){
  const response = await fetch(`${HTTP_BASE}${path}`, {
    ...options,
    headers: { Origin: ORIGIN, ...(options.headers || {}) },
  });
  const body = await response.json();
  return { response, body };
}

function jsonPost(body, token){
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

class SocketInbox {
  constructor(socket){
    this.socket = socket;
    this.messages = [];
    this.waiters = [];
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === message.type);
      if (waiterIndex >= 0) this.waiters.splice(waiterIndex, 1)[0].resolve(message);
      else this.messages.push(message);
    });
  }

  next(type, timeoutMs = TIMEOUT_MS){
    const index = this.messages.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { type, resolve: (message) => { clearTimeout(timer); resolve(message); } };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  send(type, seq, payload = {}){
    this.socket.send(JSON.stringify({ v: 1, type, seq, payload }));
  }
}

function openSocket(code, ticket){
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_BASE}/matches/${code}/socket`, [
      'stackfall.v1', `stackfall-ticket.${ticket}`,
    ], {
      origin: ORIGIN,
      handshakeTimeout: TIMEOUT_MS,
    });
    socket.once('open', () => resolve(new SocketInbox(socket)));
    socket.once('error', reject);
  });
}

function expectRejectedUpgrade(code, ticket){
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_BASE}/matches/${code}/socket`, [
      'stackfall.v1', `stackfall-ticket.${ticket}`,
    ], {
      origin: ORIGIN,
      handshakeTimeout: TIMEOUT_MS,
    });
    const timer = setTimeout(() => reject(new Error('ticket replay was not rejected')), TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error('one-use ticket unexpectedly opened a second socket'));
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      assert.equal(response.statusCode, 401);
      response.resume();
      resolve();
    });
    socket.once('error', () => {});
  });
}

const progress = (score, floors) => ({
  score,
  floors,
  perfects: Math.min(2, floors),
  maxCombo: Math.min(3, floors),
  combo: Math.min(2, floors),
  widthRatio: 0.75,
});

let host;
let guest;
try {
  const health = await api('/');
  assert.equal(health.response.status, 200);

  const created = await api('/matches', jsonPost({ name: 'Host', difficulty: 'normal' }));
  assert.equal(created.response.status, 201);
  const { code, hostToken } = created.body;

  const joined = await api(`/matches/${code}/join`, jsonPost({ name: 'Guest' }));
  assert.equal(joined.response.status, 200);
  const { playerToken } = joined.body;

  const hostTicketResponse = await api(
    `/matches/${code}/socket-ticket`, jsonPost({}, hostToken),
  );
  const guestTicketResponse = await api(
    `/matches/${code}/socket-ticket`, jsonPost({}, playerToken),
  );
  assert.equal(hostTicketResponse.response.status, 201);
  assert.equal(guestTicketResponse.response.status, 201);

  host = await openSocket(code, hostTicketResponse.body.ticket);
  await host.next('snapshot');
  guest = await openSocket(code, guestTicketResponse.body.ticket);
  await guest.next('snapshot');
  await expectRejectedUpgrade(code, hostTicketResponse.body.ticket);

  const oldHost = host;
  const replaced = oldHost.next('error');
  const replacementTicket = await api(
    `/matches/${code}/socket-ticket`, jsonPost({}, hostToken),
  );
  assert.equal(replacementTicket.response.status, 201);
  host = await openSocket(code, replacementTicket.body.ticket);
  const replacementSnapshot = await host.next('snapshot');
  assert.equal(replacementSnapshot.payload.room.you, 'host');
  assert.equal((await replaced).payload.code, 'socket_replaced');

  host.send('ready', 0);
  guest.send('ready', 0);
  const countdown = await host.next('countdown');
  await guest.next('countdown');
  assert.ok(Number.isInteger(countdown.payload.seed));
  assert.equal(countdown.payload.round, 1);
  assert.ok(Number.isFinite(countdown.payload.serverTime));

  const waitMs = Math.max(0, countdown.payload.startAt - Date.now() + 100);
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  host.send('progress', 1, progress(60, 4));
  const opponentProgress = await guest.next('opponent_progress');
  assert.equal(opponentProgress.payload.progress.score, 60);

  host.send('finish', 2, progress(120, 8));
  await guest.next('opponent_finished');
  guest.send('finish', 1, progress(80, 7));
  const result = await host.next('result');
  console.log('Round one result received.');
  assert.equal(result.payload.room.state, 'finished');
  assert.equal(result.payload.room.result.winner, 'host');
  assert.equal(result.payload.room.result.reason, 'score');

  const finalState = await api(`/matches/${code}`);
  assert.equal(finalState.body.room.state, 'finished');
  assert.equal(finalState.body.room.result.winner, 'host');

  host.send('rematch_vote', 3);
  guest.send('rematch_vote', 2);
  const rematchCountdown = await host.next('countdown');
  await guest.next('countdown');
  console.log('Round two countdown received.');
  assert.equal(rematchCountdown.payload.round, 2);
  assert.notEqual(rematchCountdown.payload.seed, countdown.payload.seed);

  guest.send('leave', 3);
  const forfeit = await host.next('result');
  console.log('Round two forfeit received.');
  assert.equal(forfeit.payload.room.state, 'forfeit');
  assert.equal(forfeit.payload.room.result.winner, 'host');
  assert.equal(forfeit.payload.room.result.reason, 'left');

  const asyncCreated = await api('/challenges', jsonPost({ name: 'Later Host', difficulty: 'hardcore' }));
  assert.equal(asyncCreated.response.status, 201);
  const asyncCode = asyncCreated.body.code;
  const asyncSeed = asyncCreated.body.challenge.seed;
  const asyncHostFinish = await api(
    `/challenges/${asyncCode}/finish`, jsonPost(progress(90, 6), asyncCreated.body.hostToken),
  );
  assert.equal(asyncHostFinish.body.challenge.state, 'open');
  const asyncJoined = await api(`/challenges/${asyncCode}/join`, jsonPost({ name: 'Later Guest' }));
  assert.equal(asyncJoined.response.status, 200);
  assert.equal(asyncJoined.body.challenge.seed, asyncSeed);
  const asyncGuestFinish = await api(
    `/challenges/${asyncCode}/finish`, jsonPost(progress(110, 7), asyncJoined.body.guestToken),
  );
  assert.equal(asyncGuestFinish.body.challenge.state, 'finished');
  assert.equal(asyncGuestFinish.body.challenge.result.winner, 'guest');
  console.log(`Integration passed: live ${code} and delayed ${asyncCode} completed on real local Worker state.`);
} finally {
  host?.socket.close();
  guest?.socket.close();
}
