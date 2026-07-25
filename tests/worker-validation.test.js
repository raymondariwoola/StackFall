import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addTo,
  cleanDifficulty,
  cleanName,
  dayWithinRetention,
  isValidDayKey,
  isValidDifficulty,
  isValidScore,
} from '../worker/src/index.js';

function utcDay(offset = 0){
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

test('score validation accepts only bounded non-negative integers', () => {
  assert.equal(isValidScore(0, 100000), true);
  assert.equal(isValidScore(100000, 100000), true);
  for (const value of [-1, 1.5, Infinity, NaN, '10', 100001]){
    assert.equal(isValidScore(value, 100000), false, String(value));
  }
});

test('Worker name and difficulty normalization matches its public contract', () => {
  assert.equal(cleanName('  Ray<script>  '), 'Rayscript');
  assert.equal(cleanName('<>'), 'anon');
  assert.equal(isValidDifficulty('normal'), true);
  assert.equal(isValidDifficulty('hardcore'), true);
  assert.equal(isValidDifficulty('nightmare'), false);
  assert.equal(cleanDifficulty('nightmare'), 'normal');
});

test('daily board keys require real dates inside the retention window', () => {
  assert.equal(isValidDayKey('2024-02-29'), true);
  assert.equal(isValidDayKey('2025-02-29'), false);
  assert.equal(isValidDayKey('2026-13-01'), false);
  assert.equal(dayWithinRetention(utcDay(), 7), true);
  assert.equal(dayWithinRetention(utcDay(-7), 7), true);
  assert.equal(dayWithinRetention(utcDay(-8), 7), false);
  assert.equal(dayWithinRetention(utcDay(1), 7), false);
});

test('serialized leaderboard ordering remains score-first and earlier-first', () => {
  const list = [
    { name: 'Later', score: 10, ts: 20 },
    { name: 'Low', score: 5, ts: 1 },
  ];
  const entry = { name: 'Earlier', score: 10, ts: 10 };
  const result = addTo(list, entry);
  assert.equal(result.rank, 1);
  assert.deepEqual(result.list.map((row) => row.name), ['Earlier', 'Later', 'Low']);
});
