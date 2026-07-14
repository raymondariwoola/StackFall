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
import { dailySeedString } from './rng.js';
import { worldFor, setHighContrast } from './palettes.js';
import { fetchDailySeed, submitScore, fetchLeaderboard, WORKER_URL } from './leaderboard.js';
import { Cheats } from './cheats.js';
import { CheatMenu } from './cheatmenu.js';
import { announce, trapFocus, prefersReducedMotion } from './a11y.js';
import { Difficulty } from './difficulty.js';
import { buildShareCard } from './sharecard.js';

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
let difficulty = Storage.difficulty();   // 'normal' | 'hardcore' — the NEXT run
let runDifficulty = difficulty;          // captured when the CURRENT run started
let overlayTimer = null;
let lastRun = { score: 0, floors: 0, mode, difficulty, streak: 0 };
let startToken = 0;        // monotonic id: only the latest start() may reset
let starting = false;      // true while a Daily seed is being fetched
let paused = false;        // our pause (button/visibility), distinct from cheat pause

audio.setMuted(Storage.muted());
ui.setSoundIcon(Storage.muted());
ui.setMode(mode);
Difficulty.set(difficulty);
ui.setDifficulty(difficulty);

// ---------- Settings application (persisted, applied live) ----------
function applyReducedMotion(){
  // Effective = OS preference OR the in-app toggle. Drives both the canvas
  // (shake/flash) and CSS animations (via a root class).
  const eff = prefersReducedMotion() || Storage.reducedMotion();
  effects.reduceMotion = eff;
  document.documentElement.classList.toggle('reduce-motion', eff);
}
function applyHighContrast(){
  setHighContrast(Storage.highContrast());
  // Refresh the backdrop to the (possibly high-contrast) palette.
  background.setWorld(worldFor(game && game.running ? game.floors : 0));
}
function applyHaptics(){ Haptics.setEnabled(Storage.haptics()); }

applyReducedMotion();
applyHaptics();
if (window.matchMedia){
  window.matchMedia('(prefers-reduced-motion: reduce)')
    .addEventListener('change', applyReducedMotion);
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
    onGameOver: (score, floors, cheated, maxCombo) => {
      // Capture the mode/difficulty the run was actually played in — the toggles
      // may change afterwards, so the captured values (not the live ones) are
      // authoritative for submission, board refresh, history, and share.
      const playedMode = runMode;
      const playedDifficulty = runDifficulty;
      const streak = maxCombo || 0;
      lastRun = { score, floors, mode: playedMode, difficulty: playedDifficulty, streak };
      Storage.addScore(score);
      Storage.addRun({ score, floors, mode: playedMode, difficulty: playedDifficulty, streak });
      if (playedMode === 'daily') Storage.recordDaily(dailySeedString(), score);
      updateStats();
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

// Share the last run: a Canvas-rendered result card via the Web Share API when
// possible, a PNG download on desktop, and a text/clipboard fallback otherwise.
async function shareRun(){
  const url = location.href.split('#')[0];
  // Use the mode/difficulty the run was played in, not the (possibly toggled)
  // live values, so the share can't mislabel the result.
  const board = lastRun.mode === 'daily' ? " on today's board" : '';
  const diffTxt = lastRun.difficulty === 'hardcore' ? ' [Hardcore]' : '';
  const text = `I stacked ${lastRun.score} pts (${lastRun.floors} floors)${board}${diffTxt} in StackFall! Beat that 👉`;

  // Build the image card (best-effort — never block sharing on it).
  let file = null;
  try {
    const blob = await buildShareCard({
      score: lastRun.score, floors: lastRun.floors, mode: lastRun.mode,
      difficulty: lastRun.difficulty, streak: lastRun.streak,
      name: Storage.name() || 'anon', date: dailySeedString(),
    });
    if (blob) file = new File([blob], 'stackfall.png', { type: 'image/png' });
  } catch (e) { /* fall through to text/url */ }

  // Preferred: native share sheet with the image attached.
  if (file && navigator.canShare && navigator.canShare({ files: [file] })){
    try { await navigator.share({ files: [file], text, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; /* else fall through */ }
  }
  // Next: native share sheet with text only.
  if (navigator.share){
    try { await navigator.share({ title: 'StackFall', text, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; /* else fall through */ }
  }
  // Desktop / no share sheet: offer the card as a PNG download.
  if (file){
    try {
      const href = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = href; a.download = 'stackfall.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
      ui.flashShare('Saved card!');
      return;
    } catch (e) { /* fall through to text */ }
  }
  // Last resort: copy the text.
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
      ui.enableGlobalTab();   // reveal + default to the Global tab once online
    }
  } catch (e) { /* stay on local board */ }
}

// ---------- Stats strip (streak / daily best / difficulty best / countdown) ----------
function timeToNextUtcMidnight(){
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  const ms = Math.max(0, next - now.getTime());
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}`;
}
function updateStats(){
  const dailyStats = Storage.dailyStats();
  ui.renderStatsStrip({
    mode,
    difficulty,
    diffBest: Storage.bestForDifficulty(difficulty),
    daily: { best: dailyStats.best, streak: dailyStats.streak },
    countdown: mode === 'daily' ? timeToNextUtcMidnight() : '',
  });
}
// Live countdown: refresh once a second while the title/game-over panel is up in
// Daily mode so the "next board" clock ticks down.
setInterval(() => {
  if (mode === 'daily' && ui.overlay.classList.contains('show')) updateStats();
}, 1000);

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
applyHighContrast();    // sets the palette + backdrop (world 0)
updateStats();          // daily best / streak / difficulty best on the title
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
  runDifficulty = difficulty;
  Difficulty.set(difficulty);   // ensure the game reads the intended profile
  ui.setScore(0);
  ui.setCombo(0);
  ui.setPauseButtonVisible(true);
  background.setWorld(worldFor(0));
  game.reset(seed);
  const diffLabel = difficulty === 'hardcore' ? ' hardcore' : '';
  announce((forMode === 'daily' ? 'Daily' : 'Endless') + diffLabel + ' run started');
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
  updateStats();
  // Show the board for the newly selected competition so the toggle actually
  // changes what the player is comparing against, not just the seed.
  refreshRemoteBoard(mode === 'daily');
});

// Difficulty toggle (applies to the next run).
ui.difficultyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.difficultyBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  difficulty = difficulty === 'hardcore' ? 'normal' : 'hardcore';
  Difficulty.set(difficulty);
  Storage.setDifficulty(difficulty);
  ui.setDifficulty(difficulty);
  updateStats();
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

// ---------- Settings overlay ----------
function openSettings(){
  ui.syncSettings({
    highContrast: Storage.highContrast(),
    reducedMotion: Storage.reducedMotion(),
    haptics: Storage.haptics(),
    hapticsSupported: Haptics.supported,
  });
  ui.showSettings();
  game.paused = true;                       // freeze a live run behind the panel
  setModal(ui.settingsOverlay, ui.settingsClose);
}
function closeSettings(){
  ui.hideSettings();
  game.paused = paused;                      // restore prior pause state
  if (ui.overlay.classList.contains('show')) setModal(ui.panel, ui.startBtn);
  else if (paused) setModal(ui.pauseOverlay, ui.resumeBtn);
  else clearModal();
}
ui.settingsBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
ui.settingsClose.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.settingsClose.addEventListener('click', (e) => { e.stopPropagation(); closeSettings(); });
// Tapping the settings backdrop closes it.
ui.settingsOverlay.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  if (e.target === ui.settingsOverlay) closeSettings();
});

ui.setHc.addEventListener('change', () => {
  Storage.setHighContrast(ui.setHc.checked);
  applyHighContrast();
});
ui.setRm.addEventListener('change', () => {
  Storage.setReducedMotion(ui.setRm.checked);
  applyReducedMotion();
});
ui.setHaptics.addEventListener('change', () => {
  Storage.setHaptics(ui.setHaptics.checked);
  applyHaptics();
  if (ui.setHaptics.checked) Haptics.buzz(15);   // confirmation buzz
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
