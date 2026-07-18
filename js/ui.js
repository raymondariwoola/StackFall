// All DOM/HUD wiring. Keeps the canvas layer free of document fiddling.

import { Storage } from './storage.js';
import { ACHIEVEMENTS } from './achievements.js';
import { escapeHtml, renderScoreRows, boardLabel, findRank } from './board.js';

export class UI {
  constructor(){
    this.score = document.getElementById('score');
    this.combo = document.getElementById('combo');
    this.bestChip = document.getElementById('best-chip');
    this.overlay = document.getElementById('overlay');
    this.panel = document.querySelector('#overlay .panel');
    this.startBtn = document.getElementById('start-btn');
    this.modeBtn = document.getElementById('mode-btn');
    this.shareBtn = document.getElementById('share-btn');
    this.soundBtn = document.getElementById('sound-btn');
    this.pauseBtn = document.getElementById('pause-btn');
    this.pauseOverlay = document.getElementById('pause-overlay');
    this.resumeBtn = document.getElementById('resume-btn');
    this.tutorialOverlay = document.getElementById('tutorial-overlay');
    this.tutorialBtn = document.getElementById('tutorial-btn');
    this.hint = document.getElementById('restart-hint');
    this.lbList = document.getElementById('lb-list');
    this.lbTabs = document.getElementById('lb-tabs');
    this.nameInput = document.getElementById('name-input');
    this.eyebrow = document.querySelector('.eyebrow');
    this.h1 = document.querySelector('.panel h1');
    this.sub = document.querySelector('.panel .sub');

    // New: difficulty toggle, daily/difficulty stats strip, settings.
    this.difficultyBtn = document.getElementById('difficulty-btn');
    this.modeDesc = document.getElementById('mode-desc');
    this.statsStrip = document.getElementById('stats-strip');
    this.practiceBadge = document.getElementById('practice-badge');
    this.offlineBanner = document.getElementById('offline-banner');
    this.toast = document.getElementById('toast');
    this.health = document.getElementById('health');
    this.healthText = document.getElementById('health-text');
    this.nameHint = document.getElementById('name-hint');
    this.submittedAs = document.getElementById('submitted-as');
    this.fullBoardLink = document.getElementById('full-board-link');
    this._click = () => {};   // click-sound hook, injected by main.js
    this._toastQueue = [];
    this._toastBusy = false;
    this.settingsBtn = document.getElementById('settings-btn');
    this.settingsOverlay = document.getElementById('settings-overlay');
    this.settingsClose = document.getElementById('settings-close');
    this.setHc = document.getElementById('set-hc');
    this.setRm = document.getElementById('set-rm');
    this.setHaptics = document.getElementById('set-haptics');
    this.setHapticsRow = document.getElementById('set-haptics-row');

    // Board tabs: Best (local) · History (personal runs) · Global (remote).
    this.currentTab = 'best';
    this._remote = { scores: [], myName: '', daily: false, difficulty: 'normal', rank: 0 };
    this._mode = 'endless';
    this._difficulty = 'normal';
    this.lbTabs.querySelectorAll('.lb-tab').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => { e.stopPropagation(); this._click(); this.selectTab(btn.dataset.tab); });
    });

    // Name field: persist as you type, and don't let taps fall through to
    // the "tap anywhere to start" handler on the wrap.
    this.nameInput.value = Storage.name();
    this.nameInput.addEventListener('input', () => {
      Storage.setName(this.nameInput.value.trim());
      this.updateNameGate();
    });
    this.nameInput.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.refreshBest();
    this.renderBoard();
  }

  refreshBest(){ this.bestChip.textContent = 'Best: ' + Storage.best(); }
  setScore(s){ this.score.textContent = String(s); }

  setCombo(combo){
    if (combo >= 2){
      this.combo.textContent = 'Combo ×' + combo;
      this.combo.classList.add('show');
    } else {
      this.combo.classList.remove('show');
    }
  }

  // Retrigger the score bounce animation.
  pulseScore(){
    this.score.classList.remove('pop');
    void this.score.offsetWidth;
    this.score.classList.add('pop');
  }

  showStart(){
    this.eyebrow.textContent = 'Precision Build';
    this.h1.textContent = 'StackFall';
    this.sub.textContent = 'Tap to drop each floor. Land it clean.';
    this.startBtn.textContent = 'Start';
    this.shareBtn.hidden = true;
    this.overlay.classList.add('show');
    this.hint.classList.remove('show');
  }

  // opts: { newBest, mode, practice, modeBest }
  showGameOver(score, floors, opts = {}){
    const practice = !!opts.practice;
    const newBest = !!opts.newBest;

    // Retrigger the celebration animations by removing the classes first.
    this.eyebrow.classList.remove('newbest');
    this.h1.classList.remove('newbest');
    void this.eyebrow.offsetWidth;

    if (practice){
      this.eyebrow.textContent = 'Practice Run';
      this.sub.textContent = `${floors} floors · not submitted or recorded`;
    } else if (newBest){
      this.eyebrow.textContent = '★ New Personal Best';
      this.sub.textContent = `${floors} floors · your best ${opts.mode === 'daily' ? 'Daily' : 'Endless'} run yet!`;
      this.eyebrow.classList.add('newbest');
      this.h1.classList.add('newbest');
    } else {
      const modeBest = opts.modeBest || 0;
      this.eyebrow.textContent = 'Run Complete';
      this.sub.textContent = `${floors} floors · ${modeBest > 0 ? 'Best ' + modeBest + ' pts' : 'Set your first record!'}`;
    }
    this.h1.textContent = score + ' pts';
    this.startBtn.textContent = 'Retry';
    this.shareBtn.textContent = 'Share Score';
    // Nothing to share for a practice run — it isn't recorded anywhere.
    this.shareBtn.hidden = practice;

    // Render whatever the submit actually did. The state is owned by
    // setSubmitResult() (set the moment the run ends, updated when the Worker
    // answers) so this can't race the 700ms collapse delay and overwrite a real
    // outcome with an optimistic one.
    if (!practice) this.nameInput.setAttribute('aria-label', 'Player name for your next run');
    this._renderSubmitResult();
    this.updateNameGate();
    this.refreshBest();
    this.renderBoard();
    this.overlay.classList.add('show');
    this.hint.classList.add('show');
  }

  // Briefly change the share button label (e.g. "Copied!").
  flashShare(msg){
    this.shareBtn.textContent = msg;
    clearTimeout(this._shareT);
    this._shareT = setTimeout(() => { this.shareBtn.textContent = 'Share Score'; }, 1400);
  }

  hideOverlay(){
    this.overlay.classList.remove('show');
    this.hint.classList.remove('show');
  }

  // ---------- Tabbed board ----------
  // Reveal the Global tab once a Worker is configured, and make it the default.
  enableGlobalTab(){
    const tab = this.lbTabs.querySelector('[data-tab="global"]');
    if (tab && tab.hidden){ tab.hidden = false; this.selectTab('global'); }
  }

  selectTab(tab){
    this.currentTab = tab;
    this.lbTabs.querySelectorAll('.lb-tab').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    this.renderBoard();
  }

  renderBoard(){
    if (this.currentTab === 'history') return this._renderHistory();
    if (this.currentTab === 'awards') return this._renderAwards();
    if (this.currentTab === 'global') return this._renderGlobal();
    return this._renderBest();
  }

  // Awards: every milestone, unlocked ones highlighted, locked ones dimmed so
  // players can see what's still out there.
  _renderAwards(){
    const unlocked = Storage.achievements();
    this.lbList.innerHTML = ACHIEVEMENTS.map((a) => {
      const got = unlocked.indexOf(a.id) !== -1;
      return `<div class="aw-row${got ? '' : ' locked'}">` +
        `<span class="aw-ico">${got ? a.icon : '🔒'}</span>` +
        `<span class="aw-txt"><span class="aw-label">${escapeHtml(a.label)}</span>` +
        `<div class="aw-desc">${escapeHtml(a.desc)}</div></span></div>`;
    }).join('');
  }

  // Store the latest remote standings; render now if the Global tab is active.
  // meta: { daily, difficulty, rank }
  renderRemoteScores(scores, myName, meta = {}){
    const daily = !!meta.daily;
    const difficulty = meta.difficulty === 'hardcore' ? 'hardcore' : 'normal';
    const sameBoardAndPlayer =
      this._remote.daily === daily &&
      this._remote.difficulty === difficulty &&
      this._remote.myName === (myName || '');
    const visibleRank = findRank(scores, myName);

    this._remote = {
      scores: scores || [],
      myName: myName || '',
      daily,
      difficulty,
      // A POST can provide a rank beyond the fetched top 20. Retain that rank
      // only while refreshing the same player's same board; otherwise derive
      // it from the new standings so a rank cannot leak between competitions.
      rank: meta.rank != null
        ? meta.rank
        : (visibleRank || (sameBoardAndPlayer ? this._remote.rank : 0)),
    };
    this.setFullBoardLink(this._remote.daily, this._remote.difficulty);
    if (this.currentTab === 'global') this._renderGlobal();
  }

  // Point the panel link at the matching board on the standalone page.
  setFullBoardLink(daily, difficulty){
    if (!this.fullBoardLink) return;
    const q = new URLSearchParams();
    if (daily) q.set('scope', 'daily');
    if (difficulty === 'hardcore') q.set('difficulty', 'hardcore');
    this.fullBoardLink.href = 'leaderboard.html' + (q.toString() ? '?' + q.toString() : '');
    this.fullBoardLink.hidden = false;
  }

  // Best: this device's top scores (works fully offline).
  _renderBest(){
    const list = Storage.scores().slice().sort((a, b) => b - a).slice(0, 8);
    this.lbList.innerHTML = list.length
      ? list.map((s, i) => `<div class="lb-row"><span>#${i + 1}</span><span>${s} pts</span></div>`).join('')
      : '<div class="lb-row"><span>No runs yet</span><span>—</span></div>';
  }

  // History: recent personal runs with mode, difficulty, and date.
  _renderHistory(){
    const runs = Storage.runs().slice(0, 8);
    this.lbList.innerHTML = runs.length
      ? runs.map((r) => {
          const when = new Date(r.ts || Date.now());
          const date = `${when.getMonth() + 1}/${when.getDate()}`;
          const hc = r.difficulty === 'hardcore';
          const modeLabel = r.mode === 'daily' ? 'Daily' : r.mode === 'practice' ? 'Practice' : 'Endless';
          const tags = `${modeLabel} · ${hc ? 'Hardcore' : 'Normal'} · ${date}`;
          return `<div class="lb-row${hc ? ' hardcore' : ''}"><span>${r.score} pts<div class="meta">${tags}</div></span><span>${r.floors}f</span></div>`;
        }).join('')
      : '<div class="lb-row"><span>No runs yet</span><span>—</span></div>';
  }

  // Global: a COMPACT summary only — your rank + the top 3 — so the panel stays
  // readable and the retry loop is preserved. The full, filterable board lives
  // on leaderboard.html (linked below the list).
  _renderGlobal(){
    const { scores, myName, daily, difficulty, rank } = this._remote;
    const head = rank
      ? `<div class="rank-line">You're #${rank} on ${boardLabel(daily, difficulty)}</div>`
      : `<div class="rank-line">${boardLabel(daily, difficulty)}</div>`;
    this.lbList.innerHTML = head + renderScoreRows(scores, myName, { limit: 3 });
  }

  // ---------- Stats strip (streak / daily best / difficulty best / countdown) ----------
  // `info`: { mode, difficulty, daily:{best,streak}, diffBest, countdown }
  renderStatsStrip(info){
    const chips = [];
    if (info.diffBest > 0){
      const label = info.difficulty === 'hardcore' ? 'Hardcore best' : 'Normal best';
      chips.push(`<span class="stat-chip">${label} <strong>${info.diffBest}</strong></span>`);
    }
    if (info.mode === 'daily'){
      if (info.daily.streak > 0) chips.push(`<span class="stat-chip streak">🔥 Streak <strong>${info.daily.streak}</strong></span>`);
      if (info.daily.best > 0) chips.push(`<span class="stat-chip">Daily best <strong>${info.daily.best}</strong></span>`);
      if (info.countdown) chips.push(`<span class="stat-chip count">Next board <strong>${info.countdown}</strong></span>`);
    }
    this.statsStrip.innerHTML = chips.join('');
    this.statsStrip.hidden = chips.length === 0;
  }

  setSoundIcon(muted){ this.soundBtn.textContent = muted ? '🔇' : '🔊'; }
  setClickSound(fn){ this._click = fn || (() => {}); }

  // The toggle buttons read "Label · Value ⇄" so it's obvious they switch.
  // Mode cycles Endless → Daily → Practice.
  setMode(mode){
    this._mode = mode;
    const val = mode === 'daily' ? 'Daily' : mode === 'practice' ? 'Practice' : 'Endless';
    this.modeBtn.innerHTML =
      `<span class="tg-label">Mode</span><span class="tg-val">${val}</span><span class="tg-ico" aria-hidden="true">⇄</span>`;
    this.modeBtn.setAttribute('aria-label', `Game mode: ${val}. Activate to switch.`);
    this.modeBtn.classList.toggle('practice', mode === 'practice');
    this._updateDesc();
    this.updateNameGate();   // Practice lifts the name requirement
  }
  setDifficulty(difficulty){
    this._difficulty = difficulty;
    const hc = difficulty === 'hardcore';
    this.difficultyBtn.innerHTML =
      `<span class="tg-label">Level</span><span class="tg-val">${hc ? 'Hardcore' : 'Normal'}</span><span class="tg-ico" aria-hidden="true">⇄</span>`;
    this.difficultyBtn.classList.toggle('hardcore', hc);
    this.difficultyBtn.setAttribute('aria-label', `Difficulty: ${hc ? 'Hardcore' : 'Normal'}. Activate to switch.`);
    this._updateDesc();
  }

  // One line under the toggles describing the selected mode, plus what
  // Hardcore adds when it's on.
  _updateDesc(){
    if (!this.modeDesc) return;
    const m = this._mode === 'daily'
      ? 'Daily: one shared tower everyone plays today. Resets at UTC midnight.'
      : this._mode === 'practice'
        ? 'Practice: warm up freely. Nothing is submitted, scored, or recorded.'
        : 'Endless: play any time. Your best goes on the all-time board.';
    const d = this._difficulty === 'hardcore'
      ? ' Hardcore: shot clock, spikes, quakes & blackouts — 2× points.'
      : '';
    this.modeDesc.textContent = m + d;
  }

  // ---------- Submit result ----------
  // A submitted score can be refused (cheated run, rate limit, validation) and
  // the response still be a perfectly happy HTTP 200. The player must be told,
  // or scores appear to vanish. `r` is null | {state:'pending'|'ok'|'refused'|'offline', …}
  setSubmitResult(r){
    this._submitResult = r || null;
    this._renderSubmitResult();
  }
  _renderSubmitResult(){
    const el = this.submittedAs;
    const r = this._submitResult;
    if (!el) return;
    if (!r){ el.hidden = true; return; }
    el.hidden = false;
    el.classList.remove('refused');

    if (r.state === 'pending'){
      el.innerHTML = `Submitting as <strong>${escapeHtml(r.name || '')}</strong>…`;
      return;
    }
    if (r.state === 'ok'){
      const rank = r.rank ? ` · rank <strong>#${r.rank}</strong>` : '';
      el.innerHTML = `Submitted as <strong>${escapeHtml(r.name || '')}</strong> ✓${rank}` +
        ` — editing below renames your next run`;
      return;
    }
    el.classList.add('refused');
    if (r.state === 'offline'){
      el.innerHTML = `<strong>Not submitted</strong> — you're offline. Your local best is still saved.`;
      return;
    }
    const why = {
      cheated: 'cheats were used on this run',
      rate_limited: 'too many submissions just now — try again in a minute',
      bad_score: 'the score failed server validation',
      bad_signature: 'the submission failed verification',
      bad_json: 'the submission was malformed',
      too_large: 'the submission was too large',
      server_error: 'the leaderboard had an error',
    }[r.reason] || 'the leaderboard refused it';
    el.innerHTML = `<strong>Not recorded</strong> — ${why}.`;
  }

  // ---------- Practice / health / offline ----------
  setPracticeBadge(on){ this.practiceBadge.hidden = !on; }

  // `state`: 'online' | 'offline' | null (hide — e.g. no Worker configured).
  setHealth(state){
    if (!state){ this.health.hidden = true; return; }
    const offline = state === 'offline';
    this.health.hidden = false;
    this.health.classList.toggle('online', !offline);
    this.health.classList.toggle('offline', offline);
    this.healthText.textContent = offline ? 'Offline — local only' : 'Online';
  }
  setOfflineBanner(on){ this.offlineBanner.hidden = !on; }

  // ---------- Achievement toasts (queued so simultaneous unlocks don't stack) ----------
  showAchievement(a){
    this._toastQueue.push(a);
    this._drainToasts();
  }
  _drainToasts(){
    if (this._toastBusy || !this._toastQueue.length) return;
    this._toastBusy = true;
    const a = this._toastQueue.shift();
    this.toast.innerHTML =
      `<span class="t-ico">${a.icon}</span>` +
      `<span><span class="t-label">${escapeHtml(a.label)}</span>` +
      `<div class="t-desc">${escapeHtml(a.desc)}</div></span>`;
    this.toast.hidden = false;
    // next frame so the transition runs from the hidden state
    requestAnimationFrame(() => this.toast.classList.add('show'));
    setTimeout(() => {
      this.toast.classList.remove('show');
      setTimeout(() => {
        this.toast.hidden = true;
        this._toastBusy = false;
        this._drainToasts();
      }, 260);
    }, 2200);
  }

  // ---------- Settings overlay ----------
  showSettings(){ this.settingsOverlay.classList.add('show'); }
  hideSettings(){ this.settingsOverlay.classList.remove('show'); }
  syncSettings(s){
    this.setHc.checked = !!s.highContrast;
    this.setRm.checked = !!s.reducedMotion;
    this.setHaptics.checked = !!s.haptics;
    // Hide the haptics toggle where vibration isn't supported.
    this.setHapticsRow.hidden = !s.hapticsSupported;
  }

  // Pause button is only meaningful during an active run.
  setPauseButtonVisible(v){ this.pauseBtn.hidden = !v; }

  showPause(){ this.pauseOverlay.classList.add('show'); }
  hidePause(){ this.pauseOverlay.classList.remove('show'); }

  showTutorial(){ this.tutorialOverlay.classList.add('show'); }
  hideTutorial(){ this.tutorialOverlay.classList.remove('show'); }

  // ---------- Name gate ----------
  // A name is required for any run that can reach a leaderboard. Practice is
  // the deliberate no-friction escape hatch: it submits nothing, so it needs
  // no name and a curious first-time player can still just tap and play.
  nameBlocked(){
    return !Storage.name().trim() && this._mode !== 'practice';
  }
  updateNameGate(){
    const blocked = this.nameBlocked();
    // Don't fight the Daily "Loading…" disable — setStarting re-applies us after.
    if (this._startLabel == null) this.startBtn.disabled = blocked;
    this.nameInput.classList.toggle('needed', blocked);
    this.nameHint.textContent = blocked ? 'Enter a name to play — or switch Mode to Practice.' : '';
  }

  // Loading state while a Daily seed is being fetched: disable Start so a run
  // can't begin (or be spammed) before the seed resolves, and show progress.
  setStarting(loading){
    if (loading){
      this._startLabel = this.startBtn.textContent;
      this.startBtn.textContent = 'Loading…';
      this.startBtn.disabled = true;
    } else {
      if (this._startLabel != null){
        this.startBtn.textContent = this._startLabel;
        this._startLabel = null;
      }
      this.updateNameGate();   // re-apply the gate rather than blindly enabling
    }
    this.startBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
  }
}
