import test from 'node:test';
import assert from 'node:assert/strict';

import {
  countdownValue,
  duelProgress,
  estimateServerOffset,
  hasSecuredWin,
  privateMultiplayerProgress,
  progressFromGame,
  resultModel,
} from '../js/duel-gameplay.js';

test('Duel progress strips local sequence data and normalizes width', () => {
  assert.deepEqual(duelProgress({
    seq: 12, score: 7, floors: 2, perfects: 1, maxCombo: 2, combo: 0,
    widthRatio: 1.2, cheated: false,
  }), {
    score: 7, floors: 2, perfects: 1, maxCombo: 2, combo: 0,
    widthRatio: 1, cheated: false,
  });
  const game = {
    score: 9, floors: 3, perfects: 2, maxCombo: 2, combo: 1,
    baseW: 200, stack: [{ w: 80 }], cheated: false,
  };
  assert.equal(progressFromGame(game).widthRatio, .4);
  assert.deepEqual(privateMultiplayerProgress({
    score: 50, floors: 4, perfects: 4, maxCombo: 4, combo: 4,
    widthRatio: .8, cheated: true,
  }), {
    score: 50, floors: 4, perfects: 4, maxCombo: 4, combo: 4,
    widthRatio: .8, cheated: false,
  });
});

test('win-secured only fires after the opponent finishes below the live score', () => {
  assert.equal(hasSecuredWin({ score: 10 }, { score: 9 }, false), false);
  assert.equal(hasSecuredWin({ score: 10 }, { score: 9 }, true), true);
  assert.equal(hasSecuredWin({ score: 9 }, { score: 9 }, true), false);
});

test('result model is seat-relative and explains forfeits', () => {
  const room = {
    result: { winner: 'guest', reason: 'left' },
    seats: {
      host: { name: 'A', progress: { score: 5, floors: 2 } },
      guest: { name: 'B', progress: { score: 6, floors: 2 }, rematch: true },
    },
  };
  assert.equal(resultModel(room, 'guest').tone, 'win');
  assert.match(resultModel(room, 'guest').detail, /forfeited/i);
  assert.equal(resultModel(room, 'host').tone, 'loss');
  assert.equal(resultModel(room, 'host').opponentRematch, true);
});

test('countdown uses the measured server clock offset', () => {
  assert.equal(estimateServerOffset(1_050, 1_000, 1_100), 0);
  assert.equal(estimateServerOffset(10_050, 5_000, 5_100), 5_000);
  assert.equal(countdownValue(10_000, 500, 7_100), '3');
  assert.equal(countdownValue(10_000, 500, 9_500), 'GO!');
});
