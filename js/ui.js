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
    this.startBtn = document.getElementById('start-btn');
    this.modeBtn = document.getElementById('mode-btn');
    this.soundBtn = document.getElementById('sound-btn');
    this.hint = document.getElementById('restart-hint');
    this.lbList = document.getElementById('lb-list');
    this.lbTitle = document.querySelector('.lb-title');
    this.nameInput = document.getElementById('name-input');
    this.eyebrow = document.querySelector('.eyebrow');
    this.h1 = document.querySelector('.panel h1');
    this.sub = document.querySelector('.panel .sub');

    // Name field: persist as you type, and don't let taps fall through to
    // the "tap anywhere to start" handler on the wrap.
    this.nameInput.value = Storage.name();
    this.nameInput.addEventListener('input', () => Storage.setName(this.nameInput.value.trim()));
    this.nameInput.addEventListener('pointerdown', (e) => e.stopPropagation());

    this.refreshBest();
    this.renderLeaderboard();
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
    this.refreshBest();
    this.renderLeaderboard();
    this.overlay.classList.add('show');
    this.hint.classList.add('show');
  }

  hideOverlay(){
    this.overlay.classList.remove('show');
    this.hint.classList.remove('show');
  }

  // Local (offline) board: this device's best runs.
  renderLeaderboard(){
    if (this.lbTitle) this.lbTitle.textContent = 'Your Best Runs';
    const list = Storage.scores().slice().sort((a, b) => b - a).slice(0, 5);
    this.lbList.innerHTML = list.length
      ? list.map((s, i) => `<div class="lb-row"><span>#${i + 1}</span><span>${s} pts</span></div>`).join('')
      : '<div class="lb-row"><span>No runs yet</span><span>—</span></div>';
  }

  // Remote (Worker) board: global top scores with names. Names are already
  // sanitized server-side; we escape again here as defense-in-depth.
  renderRemoteScores(scores, myName){
    if (this.lbTitle) this.lbTitle.textContent = 'Global Top 20';
    const rows = (scores || []).slice(0, 20).map((e, i) => {
      const mine = myName && e.name === myName ? ' me' : '';
      return `<div class="lb-row${mine}"><span>#${i + 1} ${escapeHtml(e.name || 'anon')}</span><span>${e.score | 0} pts</span></div>`;
    }).join('');
    this.lbList.innerHTML = rows || '<div class="lb-row"><span>No scores yet</span><span>—</span></div>';
  }

  setSoundIcon(muted){ this.soundBtn.textContent = muted ? '🔇' : '🔊'; }
  setMode(mode){ this.modeBtn.textContent = mode === 'daily' ? 'Daily Board' : 'Endless'; }
}
