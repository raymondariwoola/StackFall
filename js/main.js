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
import { announce, trapFocus, prefersReducedMotion } from './a11y.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const view = { W: 0, H: 0, DPR: 1 };

const effects = new Effects();
const audio = new AudioEngine();
const background = new Background();
const renderer = new Renderer(ctx);
const ui = new UI();
const rng = new RNG((Date.now() >>> 0) || 1);

let mode = 'endless';      // 'endless' | 'daily' — the mode for the NEXT run
let runMode = mode;        // the mode captured when the CURRENT run started
let overlayTimer = null;
let lastRun = { score: 0, floors: 0, mode };
let startToken = 0;        // monotonic id: only the latest start() may reset
let starting = false;      // true while a Daily seed is being fetched
let paused = false;        // our pause (button/visibility), distinct from cheat pause

audio.setMuted(Storage.muted());
ui.setSoundIcon(Storage.muted());
ui.setMode(mode);

// Honor prefers-reduced-motion for the canvas juice (shake/flash), tracked live.
effects.reduceMotion = prefersReducedMotion();
if (window.matchMedia){
  window.matchMedia('(prefers-reduced-motion: reduce)')
    .addEventListener('change', (e) => { effects.reduceMotion = e.matches; });
}

// Modal focus management: only the topmost overlay traps Tab focus at a time.
let releaseTrap = null;
function setModal(container, initial){
  if (releaseTrap) releaseTrap();
  releaseTrap = trapFocus(container, initial);
}
function clearModal(){
  if (releaseTrap){ releaseTrap(); releaseTrap = null; }
}

const game = new Game({
  view, effects, audio, haptics: Haptics, rng,
  callbacks: {
    onScore: (s, combo) => { ui.setScore(s); ui.setCombo(combo); ui.pulseScore(); },
    onWorld: (world) => { background.setWorld(world); },
    onGameOver: (score, floors, cheated) => {
      // Capture the mode the run was actually played in — the mode toggle may
      // change afterwards, so `runMode` (not the live `mode`) is authoritative
      // for submission, board refresh, and share text.
      const playedMode = runMode;
      lastRun = { score, floors, mode: playedMode };
      Storage.addScore(score);
      // A run can't end while paused, but clear the state defensively.
      paused = false;
      ui.hidePause();
      ui.setPauseButtonVisible(false);
      const isDaily = playedMode === 'daily';
      // Submit to the matching board (no-ops until WORKER_URL is set), then
      // refresh the panel with the latest standings. The `cheated` flag lets
      // the Worker keep cheated runs off the board (see BLOCK_CHEATED).
      submitScore(Storage.name() || 'anon', score, cheated, isDaily)
        .then(() => refreshRemoteBoard(isDaily))
        .catch(() => {});
      clearTimeout(overlayTimer);
      announce(`Game over. ${score} points, ${floors} floors.`);
      // Let the tower collapse play out before the panel slides in.
      overlayTimer = setTimeout(() => {
        ui.showGameOver(score, floors);
        setModal(ui.panel, ui.startBtn);
        refreshRemoteBoard(isDaily);
      }, 700);
    },
  },
});

// Secret cheat menu. Opening it pauses the swinging block; closing restores the
// prior pause state (so it doesn't un-pause a deliberately paused game).
const cheatMenu = new CheatMenu({
  game,
  onOpen: () => { game.paused = true; },
  onClose: () => { game.paused = paused; },
});

// Share the last run (native share sheet on mobile, clipboard fallback).
async function shareRun(){
  const url = location.href.split('#')[0];
  // Use the mode the run was played in, not the (possibly toggled) live mode,
  // so the shared message can't claim a Daily result for an Endless run.
  const board = lastRun.mode === 'daily' ? " on today's board" : '';
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

// Pull the leaderboard for the given competition when a Worker is configured;
// otherwise the local "Your Best Runs" board (already rendered) stays in place.
// Defaults to the currently selected mode so the title-screen board matches the
// mode toggle.
async function refreshRemoteBoard(daily = mode === 'daily'){
  if (!WORKER_URL) return;
  try {
    const data = await fetchLeaderboard(daily);
    if (data && Array.isArray(data.scores)){
      ui.renderRemoteScores(data.scores, Storage.name(), data.scope || (daily ? 'daily' : 'all'));
    }
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

// ---------- First-run tutorial ----------
function dismissTutorial(){
  Storage.setTutorialSeen();
  ui.hideTutorial();
  // Hand the focus trap to the start panel that's now the active modal.
  setModal(ui.panel, ui.startBtn);
  announce('Tutorial closed. Tap to start.');
}

window.addEventListener('resize', resize);
resize();
game.buildDemo();
background.setWorld(worldFor(0));
refreshRemoteBoard();   // show global scores on the title screen if online

// Show the tutorial once for new players; returning players go straight to the
// start panel. Either way, the topmost overlay traps keyboard focus.
if (!Storage.tutorialSeen()){
  ui.showTutorial();
  setModal(ui.tutorialOverlay, ui.tutorialBtn);
} else {
  setModal(ui.panel, ui.startBtn);
}

async function seedForMode(forMode){
  if (forMode === 'daily') return await fetchDailySeed();
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

async function start(){
  // Ignore taps that arrive while a Daily seed is still loading — the in-flight
  // start already owns this attempt (and will time out and fall back if slow).
  if (starting) return;
  audio.init();
  audio.resume();
  clearTimeout(overlayTimer);

  // Capture the mode for THIS run up front; the toggle may change afterwards.
  const forMode = mode;
  const myToken = ++startToken;

  // For Daily we must await the network seed. Keep the overlay up with a
  // loading state instead of flashing a blank screen, and disable Start.
  if (forMode === 'daily'){
    starting = true;
    ui.setStarting(true);
  } else {
    ui.hideOverlay();
  }

  const seed = await seedForMode(forMode);
  starting = false;

  // A newer start() superseded us (e.g. the player re-tapped) — do not reset,
  // or a stale seed would clobber the newer run.
  if (myToken !== startToken){
    ui.setStarting(false);
    return;
  }

  if (forMode === 'daily'){
    ui.setStarting(false);
    ui.hideOverlay();
  }

  // Leaving all overlays for live gameplay — clear any pause and focus trap.
  paused = false;
  ui.hidePause();
  clearModal();

  runMode = forMode;
  ui.setScore(0);
  ui.setCombo(0);
  ui.setPauseButtonVisible(true);
  background.setWorld(worldFor(0));
  game.reset(seed);
  announce(forMode === 'daily' ? 'Daily run started' : 'Game started');
}

// ---------- Pause ----------
function pauseGame(){
  if (!game.running || paused) return;
  paused = true;
  game.paused = true;
  ui.showPause();
  setModal(ui.pauseOverlay, ui.resumeBtn);
  announce('Paused');
}
function resumeGame(){
  if (!paused) return;
  paused = false;
  game.paused = false;
  ui.hidePause();
  clearModal();
  announce('Resumed');
}

// Auto-pause when the tab/app is backgrounded so switching away can't cost a
// miss. Stays paused on return until the player taps — no surprise drop.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseGame();
});

// ---------- Input: tap anywhere ----------
function primeAudio(){ audio.init(); audio.resume(); }

// Space/Enter should act on a focused button/input themselves, not also drop.
function isInteractive(el){
  return !!el && /^(button|input|select|textarea|a)$/i.test(el.tagName);
}

function onTap(e){
  if (e.cancelable) e.preventDefault();
  primeAudio();
  if (paused){
    resumeGame();
  } else if (game.running){
    game.drop();
  } else if (ui.overlay.classList.contains('show')){
    // Instant restart / start — zero friction for "one more try".
    start();
  }
}
document.getElementById('game-wrap').addEventListener('pointerdown', onTap, { passive: false });

// Tapping the pause overlay (backdrop or panel) resumes; the Resume button has
// its own handler below. stopPropagation so the drop handler never also fires.
ui.pauseOverlay.addEventListener('pointerdown', (e) => { e.stopPropagation(); resumeGame(); });

window.addEventListener('keydown', (e) => {
  // Let a focused control handle its own Space/Enter (avoids double-firing).
  if ((e.code === 'Space' || e.code === 'Enter') && isInteractive(document.activeElement)) return;

  if (e.code === 'Space' || e.code === 'Enter'){
    e.preventDefault();
    primeAudio();
    if (paused) resumeGame();
    else if (game.running) game.drop();
    else if (ui.overlay.classList.contains('show')) start();
  } else if (e.code === 'KeyP'){
    // P toggles pause during a run — a keyboard-reachable alternative to the button.
    if (game.running){ e.preventDefault(); paused ? resumeGame() : pauseGame(); }
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
  // Show the board for the newly selected competition so the toggle actually
  // changes what the player is comparing against, not just the seed.
  refreshRemoteBoard(mode === 'daily');
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

// Pause / resume buttons.
ui.pauseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); pauseGame(); });
ui.resumeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); resumeGame(); });

// First-run tutorial dismissal — remembered locally so it only shows once.
ui.tutorialBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.tutorialBtn.addEventListener('click', (e) => { e.stopPropagation(); dismissTutorial(); });
ui.tutorialOverlay.addEventListener('pointerdown', (e) => e.stopPropagation());

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
