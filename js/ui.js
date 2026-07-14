// All DOM/HUD wiring. Keeps the canvas layer free of document fiddling.

import { Storage } from './storage.js';

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

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
    this.statsStrip = document.getElementById('stats-strip');
    this.settingsBtn = document.getElementById('settings-btn');
    this.settingsOverlay = document.getElementById('settings-overlay');
    this.settingsClose = document.getElementById('settings-close');
    this.setHc = document.getElementById('set-hc');
    this.setRm = document.getElementById('set-rm');
    this.setHaptics = document.getElementById('set-haptics');
    this.setHapticsRow = document.getElementById('set-haptics-row');

    // Board tabs: Best (local) · History (personal runs) · Global (remote).
    this.currentTab = 'best';
    this._remote = { scores: [], myName: '', scope: 'all' };
    this.lbTabs.querySelectorAll('.lb-tab').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.selectTab(btn.dataset.tab); });
    });

    // Name field: persist as you type, and don't let taps fall through to
    // the "tap anywhere to start" handler on the wrap.
    this.nameInput.value = Storage.name();
    this.nameInput.addEventListener('input', () => Storage.setName(this.nameInput.value.trim()));
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

  showGameOver(score, floors){
    const best = Storage.best();
    const isBest = score > 0 && score >= best;
    this.eyebrow.textContent = isBest ? 'New Record' : 'Run Complete';
    this.h1.textContent = score + ' pts';
    this.sub.textContent = `${floors} floors · ${isBest ? 'New personal best!' : 'Best ' + best + ' pts'}`;
    this.startBtn.textContent = 'Retry';
    this.shareBtn.textContent = 'Share Score';
    this.shareBtn.hidden = false;
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
    if (this.currentTab === 'global') return this._renderGlobal();
    return this._renderBest();
  }

  // Store the latest remote standings; render now if the Global tab is active.
  renderRemoteScores(scores, myName, scope = 'all'){
    this._remote = { scores: scores || [], myName: myName || '', scope };
    if (this.currentTab === 'global') this._renderGlobal();
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
          const tags = `${r.mode === 'daily' ? 'Daily' : 'Endless'} · ${hc ? 'Hardcore' : 'Normal'} · ${date}`;
          return `<div class="lb-row${hc ? ' hardcore' : ''}"><span>${r.score} pts<div class="meta">${tags}</div></span><span>${r.floors}f</span></div>`;
        }).join('')
      : '<div class="lb-row"><span>No runs yet</span><span>—</span></div>';
  }

  // Global: remote top scores with names (escaped as defense-in-depth).
  _renderGlobal(){
    const { scores, myName } = this._remote;
    const rows = (scores || []).slice(0, 20).map((e, i) => {
      const mine = myName && e.name === myName ? ' me' : '';
      return `<div class="lb-row${mine}"><span>#${i + 1} ${escapeHtml(e.name || 'anon')}</span><span>${e.score | 0} pts</span></div>`;
    }).join('');
    this.lbList.innerHTML = rows || '<div class="lb-row"><span>No scores yet</span><span>—</span></div>';
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
  setMode(mode){ this.modeBtn.textContent = mode === 'daily' ? 'Daily Board' : 'Endless'; }
  setDifficulty(difficulty){
    const hc = difficulty === 'hardcore';
    this.difficultyBtn.textContent = hc ? 'Hardcore' : 'Normal';
    this.difficultyBtn.classList.toggle('hardcore', hc);
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

  // Loading state while a Daily seed is being fetched: disable Start so a run
  // can't begin (or be spammed) before the seed resolves, and show progress.
  setStarting(loading){
    if (loading){
      this._startLabel = this.startBtn.textContent;
      this.startBtn.textContent = 'Loading…';
    } else if (this._startLabel != null){
      this.startBtn.textContent = this._startLabel;
      this._startLabel = null;
    }
    this.startBtn.disabled = !!loading;
    this.startBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
  }
}
