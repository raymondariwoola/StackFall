// Core game state + rules. Deliberately render-free: it mutates state and
// fires effects/audio/haptics, and exposes just enough for the renderer to
// paint. Discrete moments (score, world change, game over) go out as callbacks.

import { CONFIG, blockH, movingY, topScreenY, baseSpeed } from './config.js';
import { colorForFloor, worldFor, worldIndex } from './palettes.js';
import { Cheats } from './cheats.js';
import { Difficulty } from './difficulty.js';

export class Game {
  constructor({ view, effects, audio, haptics, rng, callbacks }){
    this.view = view;            // { W, H }
    this.effects = effects;
    this.audio = audio;
    this.haptics = haptics;
    this.rng = rng;
    this.cb = callbacks || {};

    this.stack = [];             // [{ x, w, floor }]
    this.moving = null;          // { x, w, dir, speed, floor, invisible }
    this.running = false;
    this.paused = false;         // set while the cheat menu is open
    this.overState = false;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;           // best streak reached this run (for history)
    this.floors = 0;
    this.settle = 0;             // squash animation amount for the top block
    this.baseW = 0;
    this.bh = 0;
    this.topY = 0;
    this.curWorld = 0;
    this.cheated = false;        // true if any cheat affected this run
    this.t = 0;                  // elapsed run time (drives hardcore flicker)
  }

  // A gentle, non-interactive tower for the title screen.
  buildDemo(){
    const { W } = this.view;
    this.running = false;
    this.overState = false;
    this.moving = null;
    this.stack.length = 0;
    const w = W * CONFIG.BASE_WIDTH_RATIO;
    let x = (W - w) / 2;
    for (let f = 0; f < 9; f++){
      this.stack.push({ x, w, floor: f });
      x = Math.max(0, Math.min(W - w, x + (Math.random() - 0.5) * 28));
    }
  }

  reset(seed){
    const { W } = this.view;
    this.rng.reseed(seed);
    this.effects.reset();
    this.stack.length = 0;
    this.moving = null;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.floors = 0;
    this.settle = 0;
    this.curWorld = 0;
    this.overState = false;
    this.cheated = false;
    this.t = 0;
    this.baseW = W * Difficulty.get().baseWidthRatio;
    this.stack.push({ x: (W - this.baseW) / 2, w: this.baseW, floor: 0 });
    this._spawnMoving();
    this.running = true;
  }

  _spawnMoving(){
    const { W } = this.view;
    const diff = Difficulty.get();
    const top = this.stack[this.stack.length - 1];
    let mult = (Cheats.active && Cheats.speedOverride != null)
      ? Cheats.speedOverride
      : Math.min(diff.maxSpeedMult, 1 + this.floors * diff.speedStep);
    const dir = this.rng.bool() ? 1 : -1;
    // Hardcore "gust": a deterministic (seeded) per-floor speed jitter so the
    // swing timing is unpredictable but identical for everyone on a Daily seed.
    if (diff.gust > 0) mult *= 1 + (this.rng.next() - 0.5) * 2 * diff.gust;
    const floor = this.stack.length;
    this.moving = {
      x: dir === 1 ? 0 : (W - top.w),
      w: top.w,
      dir,
      speed: baseSpeed(W) * mult,
      floor,
      // Hardcore "invisible floors": the swinging block flickers near-invisible.
      invisible: diff.invisibleEvery > 0 && floor > 0 && floor % diff.invisibleEvery === 0,
    };
  }

  drop(){
    if (!this.running || this.paused || !this.moving) return;
    const { W, H } = this.view;
    // Mark the run cheated the moment any cheat is engaged during it.
    if (Cheats.active && Cheats.anyEngaged()) this.cheated = true;
    const top = this.stack[this.stack.length - 1];

    // Cheat: snap the swinging block onto the tower before we measure.
    if (Cheats.on('autoPerfect')){
      this.moving.w = top.w;
      this.moving.x = top.x;
    }

    const mLeft = this.moving.x, mRight = this.moving.x + this.moving.w;
    const tLeft = top.x, tRight = top.x + top.w;

    const overlapLeft = Math.max(mLeft, tLeft);
    const overlapRight = Math.min(mRight, tRight);
    const overlapW = overlapRight - overlapLeft;

    const floor = this.moving.floor;
    const color = colorForFloor(floor);
    const dropY = movingY(H);

    // Total miss — the whole block tumbles and the run ends.
    // Cheat "invincible" turns a miss into a free full-width floor instead.
    if (overlapW <= 2 && !Cheats.on('invincible')){
      this.effects.addDebris(this.moving.x, dropY, this.moving.w, this.bh, color, this.moving.dir * 80);
      this.audio.cut();
      this.haptics.buzz(60);
      this._gameOver();
      return;
    }

    const diff = Difficulty.get();
    const perfectPx = Cheats.on('easyPerfect') ? 1e9 : diff.perfectPx;
    const perfect =
      overlapW > 2 &&
      Math.abs(mLeft - tLeft) <= perfectPx &&
      Math.abs(mRight - tRight) <= perfectPx;

    let newLayer;
    if (perfect){
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      // Reward precision: grow the block back toward its base width.
      let nw = Math.min(this.baseW, top.w + diff.perfectRegenPx);
      let nx = tLeft - (nw - top.w) / 2;
      nx = Math.max(0, Math.min(nx, W - nw));
      newLayer = { x: nx, w: nw, floor };

      const gain = (1 + this.combo) * Cheats.mult() * diff.scoreMult;   // streaks snowball the score
      this.score += gain;

      const cx = tLeft + top.w / 2;
      this.effects.burst(cx, dropY + this.bh / 2, color, 18);
      this.effects.ring(cx, dropY + this.bh / 2, '#F5F3EC');
      this.effects.popText(cx, dropY - 6, 'PERFECT +' + gain, '#5EE6D6');
      this.effects.flashScreen(0.18, color);
      this.effects.shakeIt(0.12);
      this.settle = 1;
      this.audio.perfect(this.combo);
      this.haptics.buzz(this.combo >= 3 ? [0, 18, 20, 18] : 15);
    } else if (Cheats.on('noShrink') || Cheats.on('invincible')){
      // Cheat: keep the full width — no slice, no thinning, no death.
      newLayer = { x: top.x, w: top.w, floor };
      this.combo = 0;
      this.score += 1 * Cheats.mult() * diff.scoreMult;
      this.settle = 0.6;
      this.audio.cut();
      this.haptics.buzz(10);
    } else {
      // Slice the overhang off into debris; the tower gets thinner.
      if (mLeft < overlapLeft) this.effects.addDebris(mLeft, dropY, overlapLeft - mLeft, this.bh, color, -60);
      if (mRight > overlapRight) this.effects.addDebris(overlapRight, dropY, mRight - overlapRight, this.bh, color, 60);
      newLayer = { x: overlapLeft, w: overlapW, floor };
      this.combo = 0;
      this.score += 1 * Cheats.mult() * diff.scoreMult;
      this.settle = 0.6;
      this.audio.cut();
      this.haptics.buzz(10);
    }

    this.stack.push(newLayer);
    this.floors++;

    // World shift every WORLD_SIZE floors — palette + celebration.
    const wi = worldIndex(this.floors);
    if (wi !== this.curWorld){
      this.curWorld = wi;
      const world = worldFor(this.floors);
      this.audio.milestone();
      this.haptics.buzz([0, 20, 40, 20]);
      this.effects.flashScreen(0.22, world.glow);
      this.effects.popText(newLayer.x + newLayer.w / 2, dropY - 30, world.name.toUpperCase(), world.glow);
      if (this.cb.onWorld) this.cb.onWorld(world);
    }

    if (this.cb.onScore) this.cb.onScore(this.score, this.combo);

    if (newLayer.w < CONFIG.MIN_WIDTH){
      this._gameOver();
      return;
    }
    this._spawnMoving();
  }

  _gameOver(){
    this.running = false;
    this.overState = true;
    // Collapse the visible tower into a shower of debris.
    const { H } = this.view;
    const ty = topScreenY(H);
    for (let i = this.stack.length - 1; i >= 0; i--){
      const dist = (this.stack.length - 1) - i;
      const y = ty + dist * this.bh;
      if (y > H) break;
      const l = this.stack[i];
      this.effects.addDebris(l.x, y, l.w, this.bh - CONFIG.GAP, colorForFloor(l.floor), (Math.random() - 0.5) * 120);
    }
    this.stack.length = 0;
    this.moving = null;
    this.effects.shakeIt(0.25);
    this.audio.gameOver();
    this.haptics.buzz([0, 40, 60, 80]);
    if (this.cb.onGameOver) this.cb.onGameOver(this.score, this.floors, this.cheated, this.maxCombo);
  }

  update(dt){
    const { W, H } = this.view;
    this.bh = blockH(H);
    this.topY = topScreenY(H);
    if (this.running && !this.paused) this.t += dt;   // drives the hardcore flicker phase

    if (this.running && !this.paused && this.moving){
      this.moving.x += this.moving.dir * this.moving.speed * dt;
      if (this.moving.x <= 0){ this.moving.x = 0; this.moving.dir = 1; }
      if (this.moving.x + this.moving.w >= W){ this.moving.x = W - this.moving.w; this.moving.dir = -1; }
    }

    if (this.settle > 0) this.settle = Math.max(0, this.settle - dt * 3);
    this.effects.update(dt, H);
  }

  // ---------- Cheat actions (invoked from the cheat menu) ----------
  cheatAddScore(n){
    if (!this.running) return;
    this.cheated = true;
    this.score += n;
    if (this.cb.onScore) this.cb.onScore(this.score, this.combo);
  }
  cheatAddFloors(n){
    if (!this.running) return;
    this.cheated = true;
    this.floors += n;
    this.score += n;
    const wi = worldIndex(this.floors);
    if (wi !== this.curWorld){
      this.curWorld = wi;
      const world = worldFor(this.floors);
      if (this.cb.onWorld) this.cb.onWorld(world);
    }
    if (this.cb.onScore) this.cb.onScore(this.score, this.combo);
  }
}
