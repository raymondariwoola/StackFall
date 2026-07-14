// Entry point: builds the subsystems, owns the canvas + RAF loop, and routes
// input. The loop runs continuously so the background keeps breathing even on
// the title and game-over screens.

import { CONFIG } from './config.js';
import { Game } from './game.js';
import { Renderer } from './renderer.js';
import { Background } from './background.js';
import { Effects } from './effects.js';
import { AudioEngine } from './audio.js';
import { Haptics } from './haptics.js';
import { Storage } from './storage.js';
import { UI } from './ui.js';
import { RNG, dailySeed } from './rng.js';
import { worldFor } from './palettes.js';
import { fetchDailySeed, submitScore } from './leaderboard.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const view = { W: 0, H: 0, DPR: 1 };

const effects = new Effects();
const audio = new AudioEngine();
const background = new Background();
const renderer = new Renderer(ctx);
const ui = new UI();
const rng = new RNG((Date.now() >>> 0) || 1);

let mode = 'endless';      // 'endless' | 'daily'
let overlayTimer = null;

audio.setMuted(Storage.muted());
ui.setSoundIcon(Storage.muted());
ui.setMode(mode);

const game = new Game({
  view, effects, audio, haptics: Haptics, rng,
  callbacks: {
    onScore: (s, combo) => { ui.setScore(s); ui.setCombo(combo); ui.pulseScore(); },
    onWorld: (world) => { background.setWorld(world); },
    onGameOver: (score, floors) => {
      Storage.addScore(score);
      submitScore('me', score).catch(() => {});   // no-op until a Worker is wired
      clearTimeout(overlayTimer);
      // Let the tower collapse play out before the panel slides in.
      overlayTimer = setTimeout(() => ui.showGameOver(score, floors), 700);
    },
  },
});

function resize(){
  view.DPR = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_CAP);
  view.W = window.innerWidth;
  view.H = window.innerHeight;
  canvas.width = view.W * view.DPR;
  canvas.height = view.H * view.DPR;
  ctx.setTransform(view.DPR, 0, 0, view.DPR, 0, 0);
  background.init(view.W, view.H);
}

window.addEventListener('resize', resize);
resize();
game.buildDemo();
background.setWorld(worldFor(0));

async function seedForMode(){
  if (mode === 'daily') return await fetchDailySeed();
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

async function start(){
  audio.init();
  audio.resume();
  clearTimeout(overlayTimer);
  ui.hideOverlay();
  ui.setScore(0);
  ui.setCombo(0);
  background.setWorld(worldFor(0));
  const seed = await seedForMode();
  game.reset(seed);
}

// ---------- Input: tap anywhere ----------
function primeAudio(){ audio.init(); audio.resume(); }

function onTap(e){
  if (e.cancelable) e.preventDefault();
  primeAudio();
  if (game.running){
    game.drop();
  } else if (ui.overlay.classList.contains('show')){
    // Instant restart / start — zero friction for "one more try".
    start();
  }
}
document.getElementById('game-wrap').addEventListener('pointerdown', onTap, { passive: false });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'Enter'){
    e.preventDefault();
    primeAudio();
    if (game.running) game.drop();
    else if (ui.overlay.classList.contains('show')) start();
  }
});

// Start button: own handler so it doesn't double-fire with the wrap.
ui.startBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.startBtn.addEventListener('click', (e) => { e.stopPropagation(); start(); });

// Mode toggle (applies to the next run).
ui.modeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.modeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  mode = mode === 'daily' ? 'endless' : 'daily';
  ui.setMode(mode);
});

// Sound toggle (usable mid-run).
ui.soundBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.soundBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const m = !Storage.muted();
  Storage.setMuted(m);
  audio.setMuted(m);
  ui.setSoundIcon(m);
  if (!m){ audio.init(); audio.resume(); }
});

// ---------- Main loop ----------
let last = 0;
function frame(ts){
  if (!last) last = ts;
  const dt = Math.min(0.033, (ts - last) / 1000);
  last = ts;

  game.update(dt);
  const cameraY = game.floors * (game.bh || 30);
  background.update(dt, cameraY, view.W, view.H);
  renderer.draw(game, background, effects, view);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
