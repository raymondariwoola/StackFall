import test from 'node:test';
import assert from 'node:assert/strict';

import { duelErrorText, roomLobbyModel } from '../js/duel-ui.js';

function room(overrides = {}){
  return {
    code: '7KMX-R4QP',
    state: 'waiting',
    difficulty: 'normal',
    seats: {
      host: { name: 'Host', ready: false, connected: true },
      guest: null,
    },
    ...overrides,
  };
}

test('lobby model keeps Ready disabled until both players and transport are present', () => {
  const session = { seat: 'host' };
  const waiting = roomLobbyModel(room(), session, 'connected');
  assert.equal(waiting.canReady, false);
  assert.equal(waiting.readyLabel, 'Waiting for Friend');

  const joinedRoom = room({
    seats: {
      host: { name: 'Host', ready: false, connected: true },
      guest: { name: 'Guest', ready: false, connected: true },
    },
  });
  assert.equal(roomLobbyModel(joinedRoom, session, 'connected').canReady, true);
  assert.equal(roomLobbyModel(joinedRoom, session, 'reconnecting').canReady, false);

  joinedRoom.seats.host.ready = true;
  assert.equal(roomLobbyModel(joinedRoom, session, 'connected').readyLabel, 'Ready ✓');
});

test('lobby and error copy distinguishes invitation outcomes', () => {
  const countdown = roomLobbyModel(room({ state: 'countdown' }), { seat: 'host' }, 'connected');
  assert.match(countdown.status, /starting/i);
  assert.match(roomLobbyModel(room({ state: 'playing' }), { seat: 'host' }, 'connected').status, /completed/i);
  assert.match(duelErrorText('room_full'), /two players/i);
  assert.match(duelErrorText('room_not_found'), /expired/i);
  assert.match(duelErrorText('room_cancelled'), /cancelled/i);
  assert.match(duelErrorText('offline'), /offline/i);
  assert.match(duelErrorText('unknown'), /interrupted/i);
});
