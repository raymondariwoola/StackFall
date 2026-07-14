// All DOM/HUD wiring. Keeps the canvas layer free of document fiddling.

import { Storage } from './storage.js';

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
    this.eyebrow = document.querySelector('.eyebrow');
    this.h1 = document.querySelector('.panel h1');
    this.sub = document.querySelector('.panel .sub');

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

  renderLeaderboard(){
    const list = Storage.scores().slice().sort((a, b) => b - a).slice(0, 5);
    this.lbList.innerHTML = list.length
      ? list.map((s, i) => `<div class="lb-row"><span>#${i + 1}</span><span>${s} pts</span></div>`).join('')
      : '<div class="lb-row"><span>No runs yet</span><span>—</span></div>';
  }

  setSoundIcon(muted){ this.soundBtn.textContent = muted ? '🔇' : '🔊'; }
  setMode(mode){ this.modeBtn.textContent = mode === 'daily' ? 'Daily Board' : 'Endless'; }
}
