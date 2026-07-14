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
import { RNG } from './rng.js';
import { worldFor } from './palettes.js';
import { fetchDailySeed, submitScore, fetchLeaderboard, WORKER_URL } from './leaderboard.js';
import { Cheats } from './cheats.js';
import { CheatMenu } from './cheatmenu.js';

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
let lastRun = { score: 0, floors: 0 };

audio.setMuted(Storage.muted());
ui.setSoundIcon(Storage.muted());
ui.setMode(mode);

const game = new Game({
  view, effects, audio, haptics: Haptics, rng,
  callbacks: {
    onScore: (s, combo) => { ui.setScore(s); ui.setCombo(combo); ui.pulseScore(); },
    onWorld: (world) => { background.setWorld(world); },
    onGameOver: (score, floors, cheated) => {
      lastRun = { score, floors };
      Storage.addScore(score);
      // Submit to the global board (no-ops until WORKER_URL is set), then
      // refresh the panel with the latest standings. The `cheated` flag lets
      // the Worker keep cheated runs off the global board (see BLOCK_CHEATED).
      submitScore(Storage.name() || 'anon', score, cheated)
        .then(() => refreshRemoteBoard())
        .catch(() => {});
      clearTimeout(overlayTimer);
      // Let the tower collapse play out before the panel slides in.
      overlayTimer = setTimeout(() => {
        ui.showGameOver(score, floors);
        refreshRemoteBoard();
      }, 700);
    },
  },
});

// Secret cheat menu. Opening it pauses the swinging block; closing resumes.
const cheatMenu = new CheatMenu({
  game,
  onOpen: () => { game.paused = true; },
  onClose: () => { game.paused = false; },
});

// Share the last run (native share sheet on mobile, clipboard fallback).
async function shareRun(){
  const url = location.href.split('#')[0];
  const board = mode === 'daily' ? " on today's board" : '';
  const text = `I stacked ${lastRun.score} pts (${lastRun.floors} floors)${board} in StackFall! Beat that 👉`;
  if (navigator.share){
    try { await navigator.share({ title: 'StackFall', text, url }); }
    catch (e) { /* user dismissed the sheet */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(`${text} ${url}`);
    ui.flashShare('Copied!');
  } catch (e) {
    window.prompt('Copy your score:', `${text} ${url}`);
  }
}

// Pull the global leaderboard when a Worker is configured; otherwise the
// local "Your Best Runs" board (already rendered) stays in place.
async function refreshRemoteBoard(){
  if (!WORKER_URL) return;
  try {
    const data = await fetchLeaderboard();
    if (data && Array.isArray(data.scores)) ui.renderRemoteScores(data.scores, Storage.name());
  } catch (e) { /* stay on local board */ }
}

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
refreshRemoteBoard();   // show global scores on the title screen if online

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

// Share button (game-over only).
ui.shareBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.shareBtn.addEventListener('click', (e) => { e.stopPropagation(); shareRun(); });

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

  // Slow-motion cheat scales gameplay time (visuals included).
  const gdt = dt * Cheats.ts();
  game.update(gdt);
  const cameraY = game.floors * (game.bh || 30);
  background.update(gdt, cameraY, view.W, view.H);
  renderer.draw(game, background, effects, view);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
