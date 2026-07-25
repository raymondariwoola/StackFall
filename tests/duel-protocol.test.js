import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DUEL_PROTOCOL_VERSION,
  ROOM_STATES,
  canTransitionRoom,
  cleanDuelName,
  formatRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  transitionRoom,
  validateClientEnvelope,
  validateCreateMatchRequest,
  validateJoinMatchRequest,
} from '../shared/duel-protocol.js';

test('room codes normalize, format, and reject ambiguous/short input', () => {
  assert.equal(normalizeRoomCode('7kmx-r4qp'), '7KMXR4QP');
  assert.equal(formatRoomCode('7kmxr4qp'), '7KMX-R4QP');
  assert.equal(isValidRoomCode('7KMX-R4QP'), true);
  assert.equal(isValidRoomCode('O0IL-1234'), false);
  assert.equal(isValidRoomCode('ABC'), false);
});

test('create and join request validators sanitize names and enforce difficulty', () => {
  assert.deepEqual(validateCreateMatchRequest({ name: '  Ray<script> ', difficulty: 'hardcore' }), {
    ok: true,
    value: { name: 'Rayscript', difficulty: 'hardcore' },
  });
  assert.deepEqual(validateCreateMatchRequest({ name: 'Ray', difficulty: 'nightmare' }), {
    ok: false,
    error: 'bad_difficulty',
  });
  assert.deepEqual(validateJoinMatchRequest({ name: '<>' }), { ok: false, error: 'bad_name' });
  assert.equal(cleanDuelName('abcdefghijklmnop'), 'abcdefghijkl');
});

test('client envelopes require the current version, known type, sequence, and object payload', () => {
  const valid = { v: DUEL_PROTOCOL_VERSION, type: 'progress', seq: 4, payload: { floors: 4 } };
  assert.deepEqual(validateClientEnvelope(valid), { ok: true, value: valid });
  assert.equal(validateClientEnvelope({ ...valid, v: 99 }).error, 'bad_version');
  assert.equal(validateClientEnvelope({ ...valid, type: 'teleport' }).error, 'bad_type');
  assert.equal(validateClientEnvelope({ ...valid, seq: -1 }).error, 'bad_sequence');
  assert.equal(validateClientEnvelope({ ...valid, payload: [] }).error, 'bad_payload');
});

test('room transitions enforce the versioned lifecycle', () => {
  assert.equal(canTransitionRoom(ROOM_STATES.WAITING, ROOM_STATES.COUNTDOWN), true);
  assert.equal(canTransitionRoom(ROOM_STATES.WAITING, ROOM_STATES.FINISHED), false);
  const countdown = transitionRoom({ state: ROOM_STATES.WAITING, round: 1 }, ROOM_STATES.COUNTDOWN, 1000);
  assert.deepEqual(countdown, { state: ROOM_STATES.COUNTDOWN, round: 1, updatedAt: 1000 });
  assert.ok(Object.isFrozen(countdown));
  assert.throws(
    () => transitionRoom(countdown, ROOM_STATES.FINISHED, 2000),
    /invalid_room_transition/,
  );
});
