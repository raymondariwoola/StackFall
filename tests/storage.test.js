import test from 'node:test';
import assert from 'node:assert/strict';

import { Storage } from '../js/storage.js';

test('Duel runs appear in local history without changing competitive records', () => {
  const beforeDifficulty = Storage.bestForDifficulty('normal');
  const beforeEndless = Storage.bestForMode('endless');
  const run = Storage.addRun({
    score: Math.max(beforeDifficulty, beforeEndless) + 100,
    floors: 12,
    mode: 'duel',
    difficulty: 'normal',
    streak: 4,
  });

  assert.equal(run.mode, 'duel');
  assert.equal(Storage.runs()[0].mode, 'duel');
  assert.equal(Storage.bestForDifficulty('normal'), beforeDifficulty);
  assert.equal(Storage.bestForMode('endless'), beforeEndless);

  const challenge = Storage.addRun({
    score: run.score + 1, floors: 13, mode: 'beat', difficulty: 'normal', streak: 5,
  });
  assert.equal(challenge.mode, 'beat');
  assert.equal(Storage.bestForDifficulty('normal'), beforeDifficulty);
  assert.equal(Storage.bestForMode('endless'), beforeEndless);
});
