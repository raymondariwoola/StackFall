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
import { buildDuelShareCard, buildShareCard } from './sharecard.js';
import { evaluateAchievements } from './achievements.js';
import { RunContext, RUN_MODES } from './run-context.js';
import { DuelUI, duelErrorText } from './duel-ui.js';
import {
  EMPTY_DUEL_PROGRESS,
  countdownValue,
  duelProgress,
  estimateServerOffset,
  hasSecuredWin,
  opponentSeat,
  privateMultiplayerProgress,
  progressFromGame,
  resultModel,
} from './duel-gameplay.js';
import {
  MultiplayerClient,
  buildChallengeUrl,
  challengeCodeFromUrl,
  resolveMultiplayerWorkerUrl,
  withoutChallengeUrl,
} from './multiplayer.js';
import {
  BeatChallengeClient,
  beatCodeFromUrl,
  buildBeatUrl,
  withoutBeatUrl,
} from './beat-challenge.js';

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const view = { W: 0, H: 0, DPR: 1 };

const effects = new Effects();
const audio = new AudioEngine();
const background = new Background();
const renderer = new Renderer(ctx);
const ui = new UI();
const duelUI = new DuelUI();
const multiplayer = new MultiplayerClient({
  baseUrl: resolveMultiplayerWorkerUrl(WORKER_URL, location),
});
const beatChallenge = new BeatChallengeClient({
  baseUrl: resolveMultiplayerWorkerUrl(WORKER_URL, location),
});
const rng = new RNG((Date.now() >>> 0) || 1);

const runContext = new RunContext({ difficulty: Storage.difficulty() });
let overlayTimer = null;
let lastRun = { score: 0, floors: 0, ...runContext.selection, streak: 0 };
let startToken = 0;        // monotonic id: only the latest start() may reset
let starting = false;      // true while a Daily seed is being fetched
let paused = false;        // our pause (button/visibility), distinct from cheat pause

audio.setMuted(Storage.muted());
ui.setSoundIcon(Storage.muted());
ui.setMode(runContext.selection.mode);
Difficulty.set(runContext.selection.difficulty);
ui.setDifficulty(runContext.selection.difficulty);

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

// ---------- Account-free Duel invitation + lobby ----------
// Phase 2 stops at the synchronized countdown handoff. Phase 3 consumes that
// handoff to launch the seeded game and report live progress.
let duelOpen = false;
let leavingDuel = false;
let pendingChallenge = challengeCodeFromUrl(location.href);
let pendingBeatChallenge = beatCodeFromUrl(location.href);
let duelRetry = null;
let duelRound = null;
let duelServerOffset = 0;
let duelClockProbeAt = 0;
let duelClockSynced = false;
let duelStartTimer = null;
let duelCountdownTimer = null;

function clearDuelTimers(){
  clearTimeout(duelStartTimer);
  clearInterval(duelCountdownTimer);
  duelStartTimer = null;
  duelCountdownTimer = null;
}

function probeDuelClock(){
  duelClockProbeAt = Date.now();
  multiplayer.send('heartbeat');
}

function friendRoom(){
  return duelRound?.kind === 'beat' ? beatChallenge.challenge : multiplayer.room;
}

function duelOpponent(room = friendRoom(), session = duelSession()){
  const other = session && opponentSeat(session.seat);
  return other && room && room.seats ? room.seats[other] : null;
}

function setDuelControls(active){
  document.documentElement.classList.toggle('duel-active', active);
  ui.settingsBtn.hidden = active;
  ui.setPauseButtonVisible(false);
  if (active){
    cheatMenu.close();
    ui.hidePause();
    ui.hideSettings();
    paused = false;
  }
}

function renderDuelHud(ownProgress = duelRound && duelRound.progress || EMPTY_DUEL_PROGRESS){
  if (!duelRound) return;
  const room = friendRoom();
  const opponent = duelOpponent(room);
  duelUI.showHud({
    own: ownProgress,
    opponent: opponent && opponent.progress || duelRound.opponentProgress || EMPTY_DUEL_PROGRESS,
    opponentName: opponent && opponent.name || 'Opponent',
    connection: duelRound.kind === 'beat' ? 'connected' : multiplayer.connection,
    ownFinished: duelRound.finished,
    opponentFinished: !!(opponent && opponent.finished) || duelRound.opponentFinished,
  });
  duelUI.forfeitBtn.textContent = duelRound.kind === 'beat' ? 'Exit' : 'Forfeit';
}

function recordDuelRun(progress){
  if (!duelRound || duelRound.recorded) return;
  duelRound.recorded = true;
  Storage.addRun({
    score: progress.score,
    floors: progress.floors,
    mode: duelRound.kind === 'beat' ? RUN_MODES.BEAT : RUN_MODES.DUEL,
    difficulty: duelRound.difficulty,
    streak: progress.maxCombo,
  });
  updateStats();
}

function prepareDuelRound(payload, suppliedSession = null){
  const session = suppliedSession || duelSession();
  if (!session) return;
  clearDuelTimers();
  if (!duelClockSynced && Number.isFinite(payload.serverTime)){
    // Fallback for an unusually delayed/missing heartbeat response. The normal
    // path below uses the request midpoint and removes almost all clock skew.
    duelServerOffset = payload.serverTime - Date.now();
  }
  const opponent = payload.opponent || duelOpponent(friendRoom(), session);
  duelRound = {
    kind: payload.kind === 'beat' ? 'beat' : 'live',
    code: payload.code || (payload.kind === 'beat' ? beatChallenge.code : multiplayer.code),
    seat: session.seat,
    round: payload.round,
    seed: payload.seed,
    startAt: payload.startAt,
    difficulty: payload.difficulty === 'hardcore' ? 'hardcore' : 'normal',
    progress: { ...EMPTY_DUEL_PROGRESS },
    opponentProgress: duelProgress(opponent?.progress || {}),
    opponentFinished: false,
    started: false,
    finished: false,
    finishSent: false,
    recorded: false,
    winSecured: false,
  };
  setDuelControls(true);
  duelOpen = false;
  duelUI.hide();
  ui.hideOverlay();
  clearModal();

  const updateCountdown = () => duelUI.showCountdown(
    countdownValue(duelRound.startAt, duelServerOffset),
  );
  updateCountdown();
  duelCountdownTimer = setInterval(updateCountdown, 100);
  const delay = Math.max(0, payload.startAt - (Date.now() + duelServerOffset));
  duelStartTimer = setTimeout(startPreparedDuel, delay);
  announce(`Round ${payload.round}. Duel countdown started.`);
}

function startPreparedDuel(){
  if (!duelRound || duelRound.started) return;
  clearDuelTimers();
  duelRound.started = true;
  duelUI.hideCountdown();
  audio.init();
  audio.resume();
  runContext.complete();
  const activeRun = runContext.begin(duelRound.seed, {
    mode: duelRound.kind === 'beat' ? RUN_MODES.BEAT : RUN_MODES.DUEL,
    difficulty: duelRound.difficulty,
    duel: { code: duelRound.code, seat: duelRound.seat, round: duelRound.round },
  });
  Difficulty.set(activeRun.difficulty);
  cheatMenu.syncControls();
  cheatMenu.updateBadge();
  ui.setScore(0);
  ui.setCombo(0);
  ui.setPracticeBadge(false);
  ui.setSubmitResult(null);
  background.setWorld(worldFor(0));
  game.reset(activeRun.seed);
  renderDuelHud();
  announce(`Go. Round ${duelRound.round} started.`);
}

function finishDuelLocally(progress){
  if (!duelRound || duelRound.finished) return;
  duelRound.finished = true;
  duelRound.progress = duelProgress(progress);
  recordDuelRun(duelRound.progress);
  renderDuelHud();
  sendDuelFinish();
}

function sendDuelFinish(){
  if (!duelRound || !duelRound.finished || duelRound.finishSent) return;
  if (duelRound.kind === 'beat'){
    duelRound.finishSent = true;
    beatChallenge.finish(duelRound.progress).then((challenge) => {
      if (!duelRound || duelRound.code !== challenge.code) return;
      if (challenge.state === 'finished') showDuelResult(challenge);
      else showBeatChallengeReady(challenge);
    }).catch((error) => {
      if (!duelRound) return;
      duelRound.finishSent = false;
      setDuelControls(false);
      duelUI.hideHud();
      showDuelError(error, 'Retry Result', sendDuelFinish);
    });
    return;
  }
  try {
    multiplayer.finish(duelRound.progress);
    duelRound.finishSent = true;
  } catch (error){
    announce('Finished locally. Reconnecting to report your result.');
  }
}

function showDuelResult(room){
  const session = duelSession();
  if (!session) return;
  clearDuelTimers();
  if (duelRound && !duelRound.recorded) recordDuelRun(duelRound.progress);
  if (game.running) game.running = false;
  runContext.complete();
  duelUI.hideCountdown();
  duelUI.hideHud();
  setDuelControls(false);
  showDuelLayer();
  const model = duelUI.showResult(room, session);
  focusDuel(room.kind === 'beat' ? duelUI.resultExitBtn : duelUI.rematchBtn);
  announce(`${model.title} ${model.detail}`);
}

function resetDuelToTitle(){
  clearDuelTimers();
  duelRound = null;
  duelUI.hideCountdown();
  duelUI.hideHud();
  setDuelControls(false);
  runContext.complete();
  game.buildDemo();
  ui.showStart();
  ui.setScore(0);
  ui.setCombo(0);
  updateStats();
}

function duelSession(){
  if (duelRound?.kind === 'beat'){
    const code = beatChallenge.code || beatCodeFromUrl(location.href);
    return code ? beatChallenge.session(code) : null;
  }
  const code = multiplayer.code || challengeCodeFromUrl(location.href);
  return code ? multiplayer.session(code) : null;
}

function focusDuel(preferred = duelUI.closeBtn){
  setModal(duelUI.panel, preferred);
}

function showDuelLayer({ push = false } = {}){
  duelOpen = true;
  ui.overlay.setAttribute('aria-hidden', 'true');
  if (push && !history.state?.stackfallDuel){
    history.pushState({ ...(history.state || {}), stackfallDuel: true }, '', location.href);
  }
}

function closeDuelLayer(){
  duelOpen = false;
  duelRetry = null;
  duelUI.hide();
  multiplayer.disconnect();
  ui.overlay.removeAttribute('aria-hidden');
  if (ui.overlay.classList.contains('show')) setModal(ui.panel, ui.startBtn);
  else clearModal();
}

function returnFromDuelError(){
  if (history.state?.stackfallDuel) history.back();
  else closeDuelLayer();
}

function returnFromBeatChallenge(){
  closeDuelLayer();
  history.replaceState(
    { ...(history.state || {}), stackfallDuel: false },
    '',
    withoutBeatUrl(location.href),
  );
}

function putDuelInUrl(code){
  const url = buildChallengeUrl(location.href, code);
  history.replaceState({ ...(history.state || {}), stackfallDuel: true }, '', url);
  return url;
}

function putBeatInUrl(code){
  const url = buildBeatUrl(location.href, code);
  history.replaceState({ ...(history.state || {}), stackfallDuel: true }, '', url);
  return url;
}

function openJoinDuel(code = '', { push = true, error = '', kind = 'live' } = {}){
  showDuelLayer({ push });
  duelUI.showJoin({ code, name: Storage.name(), error, kind });
  focusDuel(code ? duelUI.nameInput : duelUI.codeInput);
}

function startBeatChallenge(challenge, session){
  beatChallenge.challenge = challenge;
  beatChallenge.code = challenge.code;
  prepareDuelRound({
    kind: 'beat',
    code: challenge.code,
    round: 1,
    seed: challenge.seed,
    startAt: Date.now() + 2000,
    difficulty: challenge.difficulty,
    opponent: session.seat === 'guest' ? challenge.seats.host : challenge.seats.guest,
  }, session);
}

function showBeatChallengeReady(challenge = beatChallenge.challenge){
  const session = challenge && beatChallenge.session(challenge.code);
  if (!challenge || !session) return;
  resetDuelToTitle();
  showDuelLayer();
  duelUI.showBeatReady(challenge, session);
  focusDuel(session.seat === 'host' && challenge.state === 'open' ? duelUI.shareBtn : duelUI.leaveBtn);
  announce(challenge.state === 'open' ? 'Challenge ready to share.' : 'Challenge status updated.');
}

function showCompletedBeat(challenge, session){
  resetDuelToTitle();
  showDuelLayer();
  const model = duelUI.showResult(challenge, session);
  focusDuel(duelUI.resultExitBtn);
  announce(`${model.title} ${model.detail}`);
}

function showDuelError(error, action = 'Try Again', retry = null){
  const code = error && error.code || error || 'network_error';
  duelRetry = retry;
  showDuelLayer();
  duelUI.showError(code, { action });
  focusDuel(duelUI.errorAction);
  announce(duelErrorText(code));
}

function showCurrentLobby(room = multiplayer.room, connection = multiplayer.connection){
  const session = duelSession();
  if (!room || !session) return;
  duelUI.showLobby(room, session, connection);
  focusDuel(duelUI.readyBtn.disabled ? duelUI.closeBtn : duelUI.readyBtn);
}

async function connectLobby(code){
  try {
    await multiplayer.connect(code);
    if (duelOpen) showCurrentLobby();
    else multiplayer.disconnect();
  } catch (error){
    if (duelOpen) showDuelError(error, 'Reconnect');
    else multiplayer.disconnect();
  }
}

async function createChallenge(){
  const name = Storage.name().trim();
  if (!name){
    ui.updateNameGate();
    ui.nameInput.focus();
    announce('Enter your name before creating a challenge.');
    return;
  }
  showDuelLayer({ push: true });
  duelUI.showBusy('Creating a private two-player room…');
  focusDuel(duelUI.closeBtn);
  try {
    const { room, session } = await multiplayer.create({
      name,
      difficulty: runContext.selection.difficulty,
    });
    if (!duelOpen){ multiplayer.disconnect(); return; }
    putDuelInUrl(session.code);
    duelUI.showLobby(room, session, 'connecting');
    await connectLobby(session.code);
  } catch (error){
    if (duelOpen) showDuelError(error, 'Try Again', createChallenge);
  }
}

async function createBeatChallenge(){
  const name = Storage.name().trim();
  if (!name){
    ui.updateNameGate();
    ui.nameInput.focus();
    announce('Enter your name before setting a challenge tower.');
    return;
  }
  showDuelLayer({ push: true });
  duelUI.showBusy('Choosing a private tower seed…');
  focusDuel(duelUI.closeBtn);
  try {
    const { challenge, session } = await beatChallenge.create({
      name, difficulty: runContext.selection.difficulty,
    });
    if (!duelOpen) return;
    putBeatInUrl(session.code);
    startBeatChallenge(challenge, session);
  } catch (error){
    if (duelOpen) showDuelError(error, 'Try Again', createBeatChallenge);
  }
}

async function joinChallenge({ code, name, kind = 'live' }){
  if (kind === 'beat') return joinBeatChallenge({ code, name });
  duelUI.showBusy('Claiming the open seat…');
  focusDuel(duelUI.closeBtn);
  try {
    const { room, session } = await multiplayer.join({ code, name });
    if (!duelOpen){ multiplayer.disconnect(); return; }
    putDuelInUrl(session.code);
    duelUI.showLobby(room, session, 'connecting');
    await connectLobby(session.code);
  } catch (error){
    const action = error && (error.code === 'room_full' || error.code === 'room_not_found')
      ? 'Enter Another Code'
      : 'Try Again';
    if (duelOpen) showDuelError(error, action);
  }
}

async function joinBeatChallenge({ code, name }){
  duelUI.showBusy('Claiming your one challenge run…');
  focusDuel(duelUI.closeBtn);
  try {
    const { challenge, session } = await beatChallenge.join({ code, name });
    if (!duelOpen) return;
    putBeatInUrl(session.code);
    startBeatChallenge(challenge, session);
  } catch (error){
    const action = error && ['challenge_claimed', 'challenge_not_found'].includes(error.code)
      ? 'Back to Title' : 'Try Again';
    if (duelOpen) showDuelError(error, action, action === 'Back to Title' ? returnFromDuelError : null);
  }
}

async function recoverChallenge(code, { normalizeHistory = true } = {}){
  showDuelLayer();
  if (normalizeHistory && !history.state?.stackfallDuel){
    const duelUrl = buildChallengeUrl(location.href, code);
    history.replaceState({ ...(history.state || {}), stackfallDuel: false }, '', withoutChallengeUrl(location.href));
    history.pushState({ stackfallDuel: true }, '', duelUrl);
  }
  duelUI.showBusy('Opening your challenge…');
  focusDuel(duelUI.closeBtn);
  try {
    const { room, session } = await multiplayer.recover(code);
    if (!duelOpen){ multiplayer.disconnect(); return; }
    if (room.state === 'cancelled') showDuelError('room_cancelled', 'Back to Title');
    else if (session) showCurrentLobby(room);
    else if (room.seats && room.seats.guest) showDuelError('room_full', 'Enter Another Code');
    else openJoinDuel(code, { push: false });
  } catch (error){
    if (error && error.code === 'unauthorized') multiplayer.clearSession(code);
    if (duelOpen){
      showDuelError(error, error && error.code === 'offline' ? 'Retry Connection' : 'Enter Another Code');
    }
  }
}

async function recoverBeatChallenge(code, { normalizeHistory = true } = {}){
  showDuelLayer();
  if (normalizeHistory && !history.state?.stackfallDuel){
    const challengeUrl = buildBeatUrl(location.href, code);
    history.replaceState({ ...(history.state || {}), stackfallDuel: false }, '', withoutBeatUrl(location.href));
    history.pushState({ stackfallDuel: true }, '', challengeUrl);
  }
  duelUI.showBusy('Opening the saved tower…');
  focusDuel(duelUI.closeBtn);
  try {
    const { challenge, session } = await beatChallenge.recover(code);
    if (!duelOpen) return;
    if (challenge.state === 'finished'){
      if (session) showCompletedBeat(challenge, session);
      else showDuelError('challenge_claimed', 'Back to Title', returnFromDuelError);
    } else if (!session){
      if (challenge.state === 'open') openJoinDuel(code, { push: false, kind: 'beat' });
      else showDuelError(challenge.state === 'host_playing' ? 'challenge_not_ready' : 'challenge_claimed', 'Back to Title', returnFromDuelError);
    } else if ((session.seat === 'host' && challenge.state === 'host_playing') ||
              (session.seat === 'guest' && challenge.state === 'guest_playing')){
      startBeatChallenge(challenge, session);
    } else {
      showBeatChallengeReady(challenge);
    }
  } catch (error){
    if (error && error.code === 'unauthorized') beatChallenge.clearSession(code);
    if (duelOpen) showDuelError(error, error?.code === 'offline' ? 'Retry Connection' : 'Back to Title',
      error?.code === 'offline' ? () => recoverBeatChallenge(code, { normalizeHistory: false }) : returnFromDuelError);
  }
}

async function copyDuelText(value, button){
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(value);
    duelUI.flash(button, 'Copied ✓');
  } catch (error){
    // Older WebViews and some privacy modes deny the asynchronous Clipboard
    // API even after a tap. Keep a synchronous selection fallback before the
    // final manual prompt so Copy remains a one-tap action on those devices.
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { /* manual fallback below */ }
    field.remove();
    if (copied) duelUI.flash(button, 'Copied ✓');
    else window.prompt('Copy this invite:', value);
  }
}

function challengeLink(){
  if (duelUI.room?.kind === 'beat'){
    const code = beatChallenge.code || beatChallenge.challenge.code;
    return buildBeatUrl(location.href, code);
  }
  const code = multiplayer.code || (multiplayer.room && multiplayer.room.code);
  return buildChallengeUrl(location.href, code);
}

async function shareChallenge(){
  const room = duelUI.room?.kind === 'beat' ? duelUI.room : multiplayer.room;
  if (!room) return;
  const url = challengeLink();
  const difficulty = room.difficulty === 'hardcore' ? 'Hardcore' : 'Normal';
  const text = room.kind === 'beat'
    ? `I set a ${difficulty} StackFall tower. You have 7 days to beat my score: ${room.seats.host.progress.score} pts. Challenge code: ${room.code}`
    : `I challenge you to a ${difficulty} StackFall duel. Join my game: ${room.code}`;
  if (navigator.share){
    try {
      await navigator.share({ title: room.kind === 'beat' ? 'Beat My Tower' : 'StackFall Duel', text, url });
      return;
    } catch (error){
      if (error && error.name === 'AbortError') return;
    }
  }
  await copyDuelText(`${text} ${url}`, duelUI.shareBtn);
}

function duelResultCardData(){
  const room = duelUI.room;
  const session = duelUI.session || duelSession();
  if (!room || !session) return null;
  return {
    ...resultModel(room, session.seat),
    difficulty: room.difficulty === 'hardcore' ? 'hardcore' : 'normal',
    round: room.round || 1,
    kind: room.kind === 'beat' ? 'beat' : 'live',
  };
}

async function duelResultFile(){
  const card = duelResultCardData();
  if (!card) return null;
  try { await document.fonts?.ready; } catch (error){ /* fallback fonts are fine */ }
  const blob = await buildDuelShareCard(card);
  if (!blob) return null;
  const code = String(duelUI.room?.code || 'result').replace(/[^a-z0-9-]/gi, '').toLowerCase();
  return { card, file: new File([blob], `stackfall-duel-${code || 'result'}.png`, { type: 'image/png' }) };
}

function saveDuelFile(file, button = duelUI.resultSaveBtn){
  const href = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = file.name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 4000);
  duelUI.flash(button, 'Image Saved ✓');
}

function beginDuelCardAction(button){
  const label = button.textContent;
  button.textContent = 'Creating…';
  button.disabled = true;
  return () => {
    button.textContent = label;
    button.disabled = false;
  };
}

async function saveDuelResult(){
  const restoreButton = beginDuelCardAction(duelUI.resultSaveBtn);
  try {
    const result = await duelResultFile();
    if (!result) throw new Error('card unavailable');
    restoreButton();
    saveDuelFile(result.file);
  } catch (error){
    restoreButton();
    duelUI.flash(duelUI.resultSaveBtn, 'Could Not Save');
  }
}

async function shareDuelResult(){
  const restoreButton = beginDuelCardAction(duelUI.resultShareBtn);
  try {
    const result = await duelResultFile();
    if (!result) throw new Error('card unavailable');
    const { card, file } = result;
    const text = `${card.title} — ${card.ownName} ${card.ownProgress.score} vs ${card.opponentName} ${card.opponentProgress.score} in StackFall.`;
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';

    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })){
      try {
        await navigator.share({ title: 'StackFall Duel Result', text, url: url.href, files: [file] });
        restoreButton();
        duelUI.flash(duelUI.resultShareBtn, 'Shared ✓');
        return;
      } catch (error){
        if (error && error.name === 'AbortError'){
          restoreButton();
          return;
        }
      }
    }

    // Browsers without file sharing still get the actual PNG rather than a
    // misleading text-only share. It can be attached to email/WhatsApp or
    // saved to the device from the browser's download UI.
    restoreButton();
    saveDuelFile(file, duelUI.resultShareBtn);
  } catch (error){
    restoreButton();
    const card = duelResultCardData();
    const fallback = card
      ? `${card.title} — ${card.ownName} ${card.ownProgress.score} vs ${card.opponentName} ${card.opponentProgress.score} in StackFall.`
      : 'StackFall Duel complete.';
    try {
      await navigator.clipboard.writeText(fallback);
      duelUI.flash(duelUI.resultShareBtn, 'Result Copied ✓');
    } catch (clipboardError){
      duelUI.flash(duelUI.resultShareBtn, 'Share Unavailable');
    }
  }
}

duelUI.setCallbacks({
  close: () => {
    if (duelRound){
      if (duelRound.kind === 'beat'){
        duelUI.callbacks.forfeit?.();
        return;
      }
      if (multiplayer.room && ['finished', 'forfeit'].includes(multiplayer.room.state)){
        duelUI.callbacks.resultExit?.();
        return;
      }
      multiplayer.forfeit();
      return;
    }
    if (history.state?.stackfallDuel) history.back();
    else closeDuelLayer();
  },
  join: joinChallenge,
  ready: () => {
    try {
      probeDuelClock();
      multiplayer.ready();
      const session = duelSession();
      if (session && multiplayer.room && multiplayer.room.seats[session.seat]){
        multiplayer.room.seats[session.seat].ready = true;
        showCurrentLobby();
      }
    } catch (error){ showDuelError(error, 'Reconnect'); }
  },
  share: shareChallenge,
  shareResult: shareDuelResult,
  saveResult: saveDuelResult,
  copyLink: () => copyDuelText(challengeLink(), duelUI.copyLinkBtn),
  copyCode: () => copyDuelText((duelUI.room || multiplayer.room).code, duelUI.copyCodeBtn),
  leave: async () => {
    if (duelUI.room?.kind === 'beat'){
      returnFromBeatChallenge();
      return;
    }
    leavingDuel = true;
    try {
      await multiplayer.leave();
      if (history.state?.stackfallDuel) history.back();
      else closeDuelLayer();
      announce('You left the duel.');
    } finally {
      leavingDuel = false;
    }
  },
  forfeit: async () => {
    if (!duelRound) return;
    if (duelRound.kind === 'beat'){
      const session = duelSession();
      duelUI.forfeitBtn.disabled = true;
      try {
        if (session?.seat === 'host') await beatChallenge.cancel();
      } catch (error){ /* unfinished challenges expire automatically */ }
      resetDuelToTitle();
      returnFromBeatChallenge();
      return;
    }
    duelUI.forfeitBtn.disabled = true;
    duelUI.liveState.textContent = 'FORFEITING';
    try { multiplayer.forfeit(); }
    catch (error){
      duelUI.forfeitBtn.disabled = false;
      renderDuelHud();
    }
  },
  rematch: () => {
    if (duelUI.room?.kind === 'beat') return;
    if (!multiplayer.room || !duelSession()) return;
    try {
      probeDuelClock();
      multiplayer.rematch();
      const seat = duelSession().seat;
      multiplayer.room.seats[seat].rematch = true;
      duelUI.showResult(multiplayer.room, duelSession());
    } catch (error){ showDuelError(error, 'Reconnect'); }
  },
  resultExit: async () => {
    const exitingBeat = duelUI.room?.kind === 'beat';
    leavingDuel = true;
    try {
      if (!exitingBeat) await multiplayer.leave();
    }
    finally {
      leavingDuel = false;
      resetDuelToTitle();
      if (exitingBeat) returnFromBeatChallenge();
      else if (history.state?.stackfallDuel) history.back();
      else closeDuelLayer();
    }
  },
  retry: () => {
    if (duelRetry){
      const retry = duelRetry;
      duelRetry = null;
      retry();
      return;
    }
    if (duelUI.errorCode === 'room_cancelled'){
      if (history.state?.stackfallDuel) history.back();
      else closeDuelLayer();
      return;
    }
    if (duelUI.errorCode.startsWith('challenge_') || duelUI.errorCode === 'cheated_challenge'){
      const code = beatChallenge.code || beatCodeFromUrl(location.href) || '';
      if (code) recoverBeatChallenge(code, { normalizeHistory: false });
      else returnFromDuelError();
      return;
    }
    if (['bad_code', 'room_full', 'room_not_found', 'room_started'].includes(duelUI.errorCode)){
      openJoinDuel('', { push: false });
      return;
    }
    const code = multiplayer.code || challengeCodeFromUrl(location.href) || '';
    const session = code && multiplayer.session(code);
    if (session) recoverChallenge(code, { normalizeHistory: false });
    else openJoinDuel('', { push: false });
  },
});

for (const type of ['snapshot', 'player_joined', 'presence']){
  multiplayer.on(type, (payload) => {
    if (!payload.room) return;
    if (payload.room.state === 'cancelled'){
      multiplayer.clearSession(payload.room.code);
      if (!leavingDuel && duelOpen) showDuelError('room_cancelled', 'Back to Title');
    } else if (duelRound && ['finished', 'forfeit'].includes(payload.room.state)){
      showDuelResult(payload.room);
    } else if (duelRound && (payload.room.state === 'countdown' || payload.room.state === 'playing')){
      const own = payload.room.seats && payload.room.seats[duelRound.seat];
      if (own && own.finished) duelRound.finishSent = true;
      else if (type === 'snapshot' && duelRound.finished){
        duelRound.finishSent = false;
        sendDuelFinish();
      }
      const opponent = duelOpponent(payload.room);
      duelRound.opponentProgress = duelProgress(opponent && opponent.progress);
      duelRound.opponentFinished = !!(opponent && opponent.finished);
      renderDuelHud();
    } else if (duelOpen) {
      showCurrentLobby(payload.room);
    }
  });
}
multiplayer.on('countdown', (payload) => {
  if (!multiplayer.room) return;
  const room = {
    ...multiplayer.room,
    state: 'countdown',
    seed: payload.seed,
    startAt: payload.startAt,
    round: payload.round,
    seats: {
      host: {
        ...multiplayer.room.seats.host, ready: true, progress: { ...EMPTY_DUEL_PROGRESS },
        finished: false, forfeited: false, rematch: false,
      },
      guest: {
        ...multiplayer.room.seats.guest, ready: true, progress: { ...EMPTY_DUEL_PROGRESS },
        finished: false, forfeited: false, rematch: false,
      },
    },
    result: null,
  };
  multiplayer.room = room;
  prepareDuelRound(payload);
});
multiplayer.on('presence', (payload) => {
  if (!duelClockProbeAt || !Number.isFinite(payload.serverTime)) return;
  const receivedAt = Date.now();
  duelServerOffset = estimateServerOffset(payload.serverTime, duelClockProbeAt, receivedAt);
  duelClockProbeAt = 0;
  duelClockSynced = true;
});
multiplayer.on('opponent_progress', (payload) => {
  if (!duelRound) return;
  duelRound.opponentProgress = duelProgress(payload.progress);
  const opponent = duelOpponent();
  if (opponent) opponent.progress = duelRound.opponentProgress;
  renderDuelHud();
  if (hasSecuredWin(duelRound.progress, duelRound.opponentProgress, duelRound.opponentFinished) && !duelRound.winSecured){
    duelRound.winSecured = true;
    announce('Win secured. Your score is already beyond your opponent’s final score.');
  }
});
multiplayer.on('opponent_finished', (payload) => {
  if (!duelRound) return;
  duelRound.opponentFinished = true;
  duelRound.opponentProgress = duelProgress(payload.progress);
  const opponent = duelOpponent();
  if (opponent){ opponent.progress = duelRound.opponentProgress; opponent.finished = true; }
  renderDuelHud();
  announce('Your opponent finished their tower.');
  if (hasSecuredWin(duelRound.progress, duelRound.opponentProgress, true) && !duelRound.winSecured){
    duelRound.winSecured = true;
    announce('Win secured. Your score is already beyond their final score.');
  }
});
multiplayer.on('result', (payload) => {
  if (!payload.room || leavingDuel) return;
  showDuelResult(payload.room);
});
multiplayer.on('expired', () => {
  if (duelRound){
    resetDuelToTitle();
    showDuelError('room_not_found', 'Back to Title', returnFromDuelError);
  } else if (duelOpen) showDuelError('room_not_found', 'Enter Another Code');
});
multiplayer.on('error', (payload) => {
  if (duelRound){
    if (payload.code === 'multiplayer_disabled'){
      resetDuelToTitle();
      showDuelError(payload.code, 'Back to Title', returnFromDuelError);
    } else if (!['duplicate_sequence', 'not_playing'].includes(payload.code)) {
      announce(`Duel update: ${duelErrorText(payload.code)}`);
    }
  } else if (duelOpen) showDuelError(payload.code, payload.code === 'socket_replaced' ? 'Enter Another Code' : 'Try Again');
});
multiplayer.on('transport_error', ({ error }) => {
  if (duelRound) renderDuelHud();
  else if (duelOpen && multiplayer.connection !== 'reconnecting') showDuelError(error, 'Reconnect');
});
multiplayer.on('connection', ({ connection }) => {
  if (duelRound){
    renderDuelHud();
    if (connection === 'connected') sendDuelFinish();
  }
  else if (duelOpen && multiplayer.room && duelSession()) duelUI.setConnection(connection);
});

window.addEventListener('popstate', () => {
  if (duelRound){
    if (duelRound.kind === 'beat'){
      duelUI.callbacks.forfeit?.();
      return;
    }
    if (multiplayer.room && ['finished', 'forfeit'].includes(multiplayer.room.state)){
      duelUI.callbacks.resultExit?.();
      return;
    }
    try { multiplayer.forfeit(); } catch (error) { /* disconnect grace remains the fallback */ }
    return;
  }
  if (history.state?.stackfallDuel){
    const beatCode = beatCodeFromUrl(location.href);
    if (beatCode){ recoverBeatChallenge(beatCode, { normalizeHistory: false }); return; }
    const code = challengeCodeFromUrl(location.href);
    if (code) recoverChallenge(code, { normalizeHistory: false });
    else openJoinDuel('', { push: false });
  } else if (duelOpen){
    closeDuelLayer();
  }
});
window.addEventListener('online', () => {
  if (duelOpen && duelSession() && multiplayer.connection !== 'connected'){
    multiplayer.retry().catch((error) => showDuelError(error, 'Reconnect'));
  }
});

const game = new Game({
  view, effects, audio, haptics: Haptics, rng,
  callbacks: {
    onProgress: (progress) => {
      if (!duelRound || !duelRound.started || duelRound.finished) return;
      duelRound.progress = privateMultiplayerProgress(progress);
      renderDuelHud(duelRound.progress);
      if (duelRound.kind !== 'beat'){
        try { multiplayer.progress(duelRound.progress); } catch (error) { /* final payload catches up after reconnect */ }
      }
      if (hasSecuredWin(duelRound.progress, duelRound.opponentProgress, duelRound.opponentFinished) && !duelRound.winSecured){
        duelRound.winSecured = true;
        announce('Win secured. Keep stacking for your final score.');
      }
    },
    onScore: (s, combo) => { ui.setScore(s); ui.setCombo(combo); ui.pulseScore(); checkAchievements(); },
    onWorld: (world) => { background.setWorld(world); },
    onGameOver: (score, floors, cheated, maxCombo) => {
      if (runContext.active && [RUN_MODES.DUEL, RUN_MODES.BEAT].includes(runContext.active.mode)){
        const friendMode = runContext.active.mode;
        runContext.complete();
        finishDuelLocally(privateMultiplayerProgress(progressFromGame(game)));
        paused = false;
        ui.hidePause();
        ui.setPauseButtonVisible(false);
        announce(friendMode === RUN_MODES.BEAT
          ? `Tower set. ${score} points, ${floors} floors. Saving the challenge.`
          : `Tower finished. ${score} points, ${floors} floors. Waiting for the duel result.`);
        return;
      }
      // Capture the mode/difficulty the run was actually played in — the toggles
      // may change afterwards, so the captured values (not the live ones) are
      // authoritative for submission, board refresh, history, and share.
      const completedRun = runContext.complete() || runContext.selection;
      const playedMode = completedRun.mode;
      const playedDifficulty = completedRun.difficulty;
      const streak = maxCombo || 0;
      const practice = playedMode === 'practice';
      lastRun = { score, floors, mode: playedMode, difficulty: playedDifficulty, streak };

      // Read the previous record BEFORE recording, so we can tell whether this
      // run actually beat it (drives the "new personal best" celebration).
      const prevModeBest = practice ? 0 : Storage.bestForMode(playedMode);
      const isNewBest = !practice && score > 0 && score > prevModeBest;

      // Practice submits nothing and sets no record — only a labelled history
      // entry so the player can still see what they did.
      Storage.addRun({ score, floors, mode: playedMode, difficulty: playedDifficulty, streak });
      if (!practice){
        Storage.addScore(score);
        if (playedMode === 'daily') Storage.recordDaily(dailySeedString(), score);
      }
      updateStats();

      // A run can't end while paused, but clear the state defensively.
      paused = false;
      ui.hidePause();
      ui.setPauseButtonVisible(false);
      ui.setPracticeBadge(false);

      const isDaily = playedMode === 'daily';
      const submittedAs = Storage.name() || 'anon';   // the gate guarantees a real name
      let submittedRank = null;
      ui.setSubmitResult(practice ? null : { state: 'pending', name: submittedAs });
      if (!practice){
        // Submit to the matching board (no-ops until WORKER_URL is set), then
        // refresh the panel with the latest standings. The `cheated` flag lets
        // the Worker keep cheated runs off the board (see BLOCK_CHEATED).
        // The Worker returns our rank on that board — reuse it for the summary.
        submitScore(submittedAs, score, cheated, isDaily, playedDifficulty)
          .then((res) => {
            setHealth('online');
            submittedRank = res.rank || null;
            // Tell the player the truth — a refused score must never render as
            // "Submitted ✓".
            ui.setSubmitResult(res.recorded
              ? { state: 'ok', name: submittedAs, rank: res.rank }
              : { state: 'refused', reason: res.error });
            refreshRemoteBoard(isDaily, playedDifficulty, submittedRank);
          })
          .catch(() => {
            setHealth('offline');
            ui.setSubmitResult({ state: 'offline' });
          });
      }
      clearTimeout(overlayTimer);
      announce(practice
        ? `Practice run over. ${score} points, ${floors} floors. Not recorded.`
        : `Game over. ${score} points, ${floors} floors.${isNewBest ? ' New personal best!' : ''}`);

      // Let the tower collapse play out before the panel slides in.
      overlayTimer = setTimeout(() => {
        ui.showGameOver(score, floors, {
          newBest: isNewBest, mode: playedMode, practice,
          modeBest: prevModeBest, submittedAs: practice ? null : submittedAs,
        });
        if (isNewBest) celebrateBest();
        setModal(ui.panel, ui.startBtn);
        if (!practice) refreshRemoteBoard(isDaily, playedDifficulty, submittedRank);
      }, 700);
    },
  },
});

// Secret cheat menu. Opening it pauses the swinging block; closing restores the
// prior pause state (so it doesn't un-pause a deliberately paused game).
const cheatMenu = new CheatMenu({
  game,
  onOpen: () => {
    ui.protectNameFromCredentialAutofill();
    game.paused = true;
  },
  onClose: () => {
    ui.restoreNameAfterCredentialAutofill();
    game.paused = paused;
  },
  canOpen: () => !duelOpen,
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
// `daily`/`diff` pick the board. Practice has no board of its own, so it shows
// the all-time board for the selected difficulty.
async function refreshRemoteBoard(
  daily = runContext.selection.mode === RUN_MODES.DAILY,
  diff = runContext.selection.difficulty,
  rank = null,
){
  if (!WORKER_URL) return;
  try {
    const data = await fetchLeaderboard(daily, diff);
    if (data && Array.isArray(data.scores)){
      ui.renderRemoteScores(data.scores, Storage.name(), {
        daily, difficulty: data.difficulty || diff, rank,
      });
      ui.enableGlobalTab();   // reveal + default to the Global tab once online
      setHealth('online');
    }
  } catch (e) {
    // Stay on the local board — play and local scores continue unaffected.
    setHealth('offline');
  }
}

// ---------- Achievements ----------
// Evaluated from live run stats. Practice is consequence-free, so it never
// unlocks anything (matching "practice records nothing").
function checkAchievements(){
  if (runContext.active && runContext.active.mode === RUN_MODES.PRACTICE) return;
  const earned = evaluateAchievements({ floors: game.floors, perfects: game.perfects }, Storage);
  if (!earned.length) return;
  for (const a of earned){
    ui.showAchievement(a);
    announce(`Achievement unlocked: ${a.label}. ${a.desc}.`);
  }
  audio.milestone();
  if (ui.currentTab === 'awards') ui.renderBoard();
}

// A short canvas + audio celebration when a run beats that mode's record.
// (flashScreen is gated by reduced-motion inside Effects; particles are not.)
function celebrateBest(){
  audio.milestone();
  Haptics.buzz([0, 30, 40, 30]);
  const cx = view.W / 2, cy = view.H * 0.42;
  effects.burst(cx, cy, '#E8A33D', 26);
  effects.ring(cx, cy, '#5EE6D6');
  effects.popText(cx, cy - 30, 'NEW BEST!', '#E8A33D');
  effects.flashScreen(0.16, '#E8A33D');
}

// ---------- Worker health ----------
// Derived from the fetches the game already makes — no polling loop, so this
// costs zero extra Worker reads. Local play/scores are unaffected either way.
let health = null;   // null = unknown / no Worker, 'online' | 'offline'
function setHealth(next){
  if (!WORKER_URL || health === next) return;
  health = next;
  ui.setHealth(next);
  ui.setOfflineBanner(next === 'offline');
  if (next === 'offline') announce('Worker unavailable. Playing locally; scores saved on this device.');
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
  const { mode, difficulty } = runContext.selection;
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
  if (runContext.selection.mode === RUN_MODES.DAILY && ui.overlay.classList.contains('show')) updateStats();
}, 1000);

let bgW = 0, bgH = 0;
function resize(){
  const DPR = Math.min(window.devicePixelRatio || 1, CONFIG.DPR_CAP);
  const W = window.innerWidth, H = window.innerHeight;
  // Mobile browsers fire resize on every URL-bar show/hide. Reallocating the
  // canvas backing store for a no-op change is pure jank.
  if (W === view.W && H === view.H && DPR === view.DPR) return;

  const oldW = view.W;
  if (oldW > 0 && W !== oldW) game.resizeWidth(oldW, W);

  view.DPR = DPR;
  view.W = W;
  view.H = H;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // Re-seeding the parallax field randomizes every shape, which reads as a
  // visible "jump". Only do it on a real size change (rotation / resize), not
  // for the ~60-100px the URL bar moves.
  if (Math.abs(W - bgW) > 8 || Math.abs(H - bgH) > 100){
    background.init(W, H);
    bgW = W; bgH = H;
  }
}

// ---------- First-run tutorial ----------
function dismissTutorial(){
  Storage.setTutorialSeen();
  ui.hideTutorial();
  if (pendingChallenge !== null || pendingBeatChallenge !== null){
    openPendingFriendChallenge();
    return;
  }
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
  if (pendingChallenge !== null || pendingBeatChallenge !== null) queueMicrotask(openPendingFriendChallenge);
}

function openPendingFriendChallenge(){
  if (pendingBeatChallenge !== null){
    const code = pendingBeatChallenge;
    pendingBeatChallenge = null;
    if (code === ''){
      if (!history.state?.stackfallDuel){
        const invalidUrl = location.href;
        history.replaceState({ ...(history.state || {}), stackfallDuel: false }, '', withoutBeatUrl(location.href));
        history.pushState({ stackfallDuel: true }, '', invalidUrl);
      }
      showDuelError('bad_code', 'Back to Title', returnFromDuelError);
    } else if (code) recoverBeatChallenge(code);
    return;
  }
  const code = pendingChallenge;
  pendingChallenge = null;
  if (code === ''){
    if (!history.state?.stackfallDuel){
      const invalidUrl = location.href;
      history.replaceState({ ...(history.state || {}), stackfallDuel: false }, '', withoutChallengeUrl(location.href));
      history.pushState({ stackfallDuel: true }, '', invalidUrl);
    }
    showDuelError('bad_code', 'Enter a Code');
    return;
  }
  if (code) recoverChallenge(code);
}

async function seedForMode(forMode){
  if (forMode === 'daily') return await fetchDailySeed();
  return (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
}

async function start(){
  // Ignore taps that arrive while a Daily seed is still loading — the in-flight
  // start already owns this attempt (and will time out and fall back if slow).
  if (starting) return;
  // A name is required for anything that can reach a leaderboard. Practice is
  // exempt, so a first-time player can still try the game with zero friction.
  if (ui.nameBlocked()){
    ui.updateNameGate();
    ui.nameInput.focus();
    announce('Enter a name to play, or switch mode to Practice.');
    return;
  }
  audio.init();
  audio.resume();
  clearTimeout(overlayTimer);

  // Capture the mode for THIS run up front; the toggle may change afterwards.
  const selectedRun = runContext.selection;
  const forMode = selectedRun.mode;
  const forDifficulty = selectedRun.difficulty;
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

  // Leaving all overlays for live gameplay — clear any pause and focus trap,
  // and drop focus from the launching button so keyboard drops aren't swallowed.
  paused = false;
  ui.hidePause();
  clearModal();
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur){
    document.activeElement.blur();
  }

  const activeRun = runContext.begin(seed, { mode: forMode, difficulty: forDifficulty });
  Difficulty.set(activeRun.difficulty);   // ensure the game reads the captured profile
  ui.setScore(0);
  ui.setCombo(0);
  ui.setPauseButtonVisible(true);
  ui.setPracticeBadge(forMode === 'practice');   // explicit, persistent label
  ui.setSubmitResult(null);                      // clear the previous run's outcome
  background.setWorld(worldFor(0));
  game.reset(activeRun.seed);
  cheatMenu.updateBadge();   // reset() clears `cheated` — drop a stale badge
  const diffLabel = activeRun.difficulty === 'hardcore' ? ' hardcore' : '';
  const modeLabel = forMode === 'daily' ? 'Daily' : forMode === 'practice' ? 'Practice' : 'Endless';
  announce(modeLabel + diffLabel + ' run started' + (forMode === 'practice' ? ' — nothing will be recorded' : ''));
}

// ---------- Pause ----------
function pauseGame(){
  if (duelRound && duelRound.started) return;
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
  if (document.hidden && !duelRound) pauseGame();
});

// ---------- Input ----------
function primeAudio(){ audio.init(); audio.resume(); }

// Short UI feedback sound for button presses / toggles (respects mute).
function uiSound(kind){
  audio.init(); audio.resume();
  if (kind === 'toggle') audio.toggle(); else audio.blip();
}

function onTap(e){
  if (e.cancelable) e.preventDefault();
  if (paused){
    primeAudio();
    resumeGame();
  } else if (game.running){
    primeAudio();
    game.drop();
  }
  // When an overlay is up we deliberately do NOTHING here: a run can only be
  // started from the Start / Retry button, so a stray tap (e.g. reaching for
  // Share) can't launch a new game by accident.
}
document.getElementById('game-wrap').addEventListener('pointerdown', onTap, { passive: false });

// Tapping the pause overlay (backdrop or panel) resumes; the Resume button has
// its own handler below. stopPropagation so the drop handler never also fires.
ui.pauseOverlay.addEventListener('pointerdown', (e) => { e.stopPropagation(); resumeGame(); });

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'Enter'){
    // During a live run, Space/Enter ALWAYS drops — never let a lingering button
    // focus (e.g. the Start button that launched the run) swallow the keypress.
    if (game.running && !paused){ e.preventDefault(); primeAudio(); game.drop(); return; }
    if (paused){ e.preventDefault(); primeAudio(); resumeGame(); return; }
    // Overlay up: let the focused Start / Retry button activate natively (that
    // IS the CTA). Don't start from here, and don't preventDefault, so the
    // button's own keyboard activation still fires.
    return;
  }
  if (e.code === 'KeyP' && game.running){
    if (duelRound) return;
    // P toggles pause during a run — a keyboard alternative to the button.
    e.preventDefault();
    paused ? resumeGame() : pauseGame();
  }
});

// Give the board tabs a click sound too (they're wired inside UI).
ui.setClickSound(() => uiSound('blip'));

// Start button: own handler so it doesn't double-fire with the wrap.
ui.startBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.startBtn.addEventListener('click', (e) => { e.stopPropagation(); uiSound('blip'); start(); });

// Duel entry points stay separate from single-player Start so an accidental tap
// can never create a room or consume an invitation.
ui.challengeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.challengeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  uiSound('blip');
  createChallenge();
});
ui.joinDuelBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.joinDuelBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  uiSound('blip');
  openJoinDuel();
});
ui.beatBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.beatBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  uiSound('blip');
  createBeatChallenge();
});

// Share button (game-over only).
ui.shareBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.shareBtn.addEventListener('click', (e) => { e.stopPropagation(); uiSound('blip'); shareRun(); });

// Mode toggle (applies to the next run).
ui.modeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.modeBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  uiSound('toggle');
  // Cycle Endless → Daily → Practice → Endless.
  const selected = runContext.cycleMode();
  ui.setMode(selected.mode);
  updateStats();
  // Show the board for the newly selected competition so the toggle actually
  // changes what the player is comparing against, not just the seed.
  // Practice has no board of its own — show the all-time one.
  refreshRemoteBoard(selected.mode === RUN_MODES.DAILY, selected.difficulty);
});

// Difficulty toggle (applies to the next run).
ui.difficultyBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.difficultyBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  uiSound('toggle');
  const difficulty = runContext.selection.difficulty === 'hardcore' ? 'normal' : 'hardcore';
  const selected = runContext.setDifficulty(difficulty);
  Difficulty.set(selected.difficulty);
  Storage.setDifficulty(selected.difficulty);
  ui.setDifficulty(selected.difficulty);
  updateStats();
  // Normal and Hardcore are separate boards — show the one you're playing.
  refreshRemoteBoard(selected.mode === RUN_MODES.DAILY, selected.difficulty);
});

// Sound toggle (usable mid-run).
ui.soundBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.soundBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const m = !Storage.muted();
  Storage.setMuted(m);
  audio.setMuted(m);
  ui.setSoundIcon(m);
  if (!m){ audio.init(); audio.resume(); audio.blip(); }   // confirm on unmute
});

// Pause / resume buttons.
ui.pauseBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.pauseBtn.addEventListener('click', (e) => { e.stopPropagation(); uiSound('blip'); pauseGame(); });
ui.resumeBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.resumeBtn.addEventListener('click', (e) => { e.stopPropagation(); uiSound('blip'); resumeGame(); });

// First-run tutorial dismissal — remembered locally so it only shows once.
ui.tutorialBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.tutorialBtn.addEventListener('click', (e) => { e.stopPropagation(); uiSound('blip'); dismissTutorial(); });
ui.tutorialOverlay.addEventListener('pointerdown', (e) => e.stopPropagation());

// ---------- Settings overlay ----------
function openSettings(){
  if (duelRound) return;
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
ui.settingsBtn.addEventListener('click', (e) => { e.stopPropagation(); uiSound('blip'); openSettings(); });
ui.settingsClose.addEventListener('pointerdown', (e) => e.stopPropagation());
ui.settingsClose.addEventListener('click', (e) => { e.stopPropagation(); uiSound('blip'); closeSettings(); });
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
