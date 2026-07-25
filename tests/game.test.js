import test from 'node:test';
import assert from 'node:assert/strict';

import { Game } from '../js/game.js';
import { RNG } from '../js/rng.js';
import { Difficulty } from '../js/difficulty.js';
import { Cheats } from '../js/cheats.js';

function noOp(){}

function createHarness({ difficulty = 'normal', onProgress = noOp, onGameOver = noOp } = {}){
  Difficulty.set(difficulty);
  Cheats.reset();
  const view = { W: 400, H: 800 };
  const effects = {
    reset: noOp, addDebris: noOp, burst: noOp, ring: noOp,
    popText: noOp, flashScreen: noOp, shakeIt: noOp, update: noOp,
  };
  const audio = { cut: noOp, perfect: noOp, milestone: noOp, gameOver: noOp };
  const haptics = { buzz: noOp };
  const game = new Game({
    view,
    effects,
    audio,
    haptics,
    rng: new RNG(1),
    callbacks: { onProgress, onGameOver, onScore: noOp, onWorld: noOp },
  });
  return { game, view };
}

function playPerfectSchedule(seed, floors = 18){
  const { game } = createHarness({ difficulty: 'hardcore' });
  game.reset(seed);
  const schedule = [];
  for (let i = 0; i < floors && game.running; i++){
    schedule.push({
      floor: game.moving.floor,
      dir: game.moving.dir,
      gust: game.moving.gust,
      invisible: game.moving.invisible,
      hazard: game.hazard ? { ...game.hazard } : null,
      blackout: game.blackoutDur > 0 && game.blackout > 0,
    });
    const top = game.stack[game.stack.length - 1];
    game.moving.x = top.x;
    game.moving.w = top.w;
    game.drop();
  }
  return schedule;
}

test('seeded Hardcore event schedules remain stable for identical seeds', () => {
  assert.deepEqual(playPerfectSchedule(0xC0FFEE), playPerfectSchedule(0xC0FFEE));
  assert.notDeepEqual(playPerfectSchedule(0xC0FFEE), playPerfectSchedule(0xBADF00D));
});

test('a resolved landing emits one neutral progress event', () => {
  const progress = [];
  const { game } = createHarness({ onProgress: (event) => progress.push(event) });
  game.reset(42);
  const top = game.stack[game.stack.length - 1];
  game.moving.x = top.x;
  game.moving.w = top.w;
  game.drop();

  assert.equal(progress.length, 1);
  assert.deepEqual(progress[0], {
    seq: 1,
    score: 2,
    floors: 1,
    combo: 1,
    perfects: 1,
    maxCombo: 1,
    widthRatio: 1,
    cheated: false,
  });
});

test('a total miss ends the run without reporting landed progress', () => {
  const progress = [];
  let ended = 0;
  const { game } = createHarness({
    onProgress: (event) => progress.push(event),
    onGameOver: () => { ended++; },
  });
  game.reset(42);
  game.moving.x = 0;
  game.moving.w = 10;
  game.drop();

  assert.equal(game.running, false);
  assert.equal(ended, 1);
  assert.deepEqual(progress, []);
});

test('horizontal resize preserves normalized tower and moving-block geometry', () => {
  const { game, view } = createHarness();
  game.reset(99);
  const before = {
    stack: game.stack.map((layer) => ({ x: layer.x / view.W, w: layer.w / view.W })),
    moving: { x: game.moving.x / view.W, w: game.moving.w / view.W },
    baseW: game.baseW / view.W,
  };

  game.resizeWidth(400, 800);
  view.W = 800;

  assert.deepEqual(
    game.stack.map((layer) => ({ x: layer.x / view.W, w: layer.w / view.W })),
    before.stack,
  );
  assert.deepEqual(
    { x: game.moving.x / view.W, w: game.moving.w / view.W },
    before.moving,
  );
  assert.equal(game.baseW / view.W, before.baseW);
  for (const layer of [...game.stack, game.moving]){
    assert.ok(layer.x >= 0);
    assert.ok(layer.x + layer.w <= view.W);
  }
});
