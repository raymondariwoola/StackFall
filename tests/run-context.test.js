import test from 'node:test';
import assert from 'node:assert/strict';

import { RunContext, RUN_MODES } from '../js/run-context.js';

test('RunContext captures an immutable active run independently of later selections', () => {
  const context = new RunContext({ mode: RUN_MODES.DAILY, difficulty: 'hardcore' });
  const active = context.begin(1234);

  context.setMode(RUN_MODES.PRACTICE);
  context.setDifficulty('normal');

  assert.deepEqual(active, {
    mode: RUN_MODES.DAILY,
    difficulty: 'hardcore',
    seed: 1234,
    duel: null,
  });
  assert.deepEqual(context.selection, { mode: RUN_MODES.PRACTICE, difficulty: 'normal' });
  assert.ok(Object.isFrozen(active));
  assert.equal(context.complete(), active);
  assert.equal(context.active, null);
});

test('RunContext cycles only title-screen modes and accepts explicit Duel metadata', () => {
  const context = new RunContext();
  assert.equal(context.cycleMode().mode, RUN_MODES.DAILY);
  assert.equal(context.cycleMode().mode, RUN_MODES.PRACTICE);
  assert.equal(context.cycleMode().mode, RUN_MODES.ENDLESS);

  const duel = context.begin(0, {
    mode: RUN_MODES.DUEL,
    difficulty: 'hardcore',
    duel: { code: '7KMXR4QP', seat: 'host' },
  });
  assert.equal(duel.mode, RUN_MODES.DUEL);
  assert.equal(duel.seed, 1);
  assert.deepEqual(duel.duel, { code: '7KMXR4QP', seat: 'host' });
  assert.ok(Object.isFrozen(duel.duel));

  const beat = context.begin(42, {
    mode: RUN_MODES.BEAT,
    duel: { code: '7KMXR4QP', seat: 'guest', kind: 'beat' },
  });
  assert.equal(beat.mode, RUN_MODES.BEAT);
  assert.deepEqual(beat.duel, { code: '7KMXR4QP', seat: 'guest', kind: 'beat' });
});

test('RunContext normalizes unsupported selections', () => {
  const context = new RunContext({ mode: 'unknown', difficulty: 'impossible' });
  assert.deepEqual(context.selection, { mode: RUN_MODES.ENDLESS, difficulty: 'normal' });
  assert.equal(context.setMode(RUN_MODES.DUEL).mode, RUN_MODES.ENDLESS);
  assert.equal(context.setDifficulty('hardcore').difficulty, 'hardcore');
});
