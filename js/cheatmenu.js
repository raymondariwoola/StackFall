// Secret cheat menu: a hidden trigger opens a passphrase gate (verified by the
// Worker), which unlocks a panel of toggles. Writes into the shared Cheats
// state that game.js reads. Runs are still submitted to the leaderboard.
//
// Trigger: tap the "StackFall" title 5× quickly, or press the ` (backquote) key.

import { Cheats } from './cheats.js';
import { verifyCheat } from './leaderboard.js';

export class CheatMenu {
  constructor({ game, onOpen, onClose }){
    this.game = game;
    this.onOpen = onOpen || (() => {});
    this.onClose = onClose || (() => {});

    this.overlay = document.getElementById('cheat-overlay');
    this.lockView = document.getElementById('cheat-lock');
    this.menuView = document.getElementById('cheat-menu');
    this.codeInput = document.getElementById('cheat-code');
    this.errorEl = document.getElementById('cheat-error');
    this.badge = document.getElementById('cheat-badge');
    // Secret trigger surfaces: the start/game-over title, and the Pause title —
    // the latter is the only way in mid-run on touch devices (there's no
    // Backquote key on a phone).
    this.titles = [
      document.querySelector('.panel h1'),
      document.getElementById('pause-title'),
    ].filter(Boolean);

    this._taps = 0;
    this._tapTimer = null;

    this._wire();
    this._attachTriggers();
    this.syncControls();
    this.updateBadge();
  }

  _attachTriggers(){
    // 5 quick taps on a title. stopPropagation so these taps never start a run
    // (start/game-over panel) or resume the game (pause overlay).
    this.titles.forEach((title) => {
      title.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this._taps++;
        clearTimeout(this._tapTimer);
        this._tapTimer = setTimeout(() => { this._taps = 0; }, 1500);
        if (this._taps >= 5){ this._taps = 0; this.open(); }
      });
    });
    // Desktop shortcut.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Backquote'){ e.preventDefault(); this.toggle(); }
    });
  }

  _wire(){
    // Swallow taps inside the overlay; a tap on the dim backdrop cancels.
    this.overlay.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.overlay.addEventListener('click', (e) => { if (e.target === this.overlay) this.close(); });

    document.getElementById('cheat-unlock').addEventListener('click', () => this._tryUnlock());
    document.getElementById('cheat-cancel').addEventListener('click', () => this.close());
    this.codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._tryUnlock(); });

    document.getElementById('cheat-resume').addEventListener('click', () => this.close());
    document.getElementById('cheat-exit').addEventListener('click', () => this.exit());

    // Boolean toggles.
    this.menuView.querySelectorAll('input[data-cheat]').forEach((el) => {
      el.addEventListener('change', () => {
        Cheats[el.dataset.cheat] = el.checked;
        this.updateBadge();
      });
    });
    // Multiplier / override selects.
    this.menuView.querySelectorAll('select[data-cheat-select]').forEach((el) => {
      el.addEventListener('change', () => {
        const key = el.dataset.cheatSelect;
        const v = el.value;
        Cheats[key] = (key === 'speedOverride') ? (v === '' ? null : parseFloat(v)) : parseFloat(v);
        this.updateBadge();
      });
    });
    // Quick actions. These taint the run even though they engage no toggle, so
    // the badge has to be refreshed or the player gets no signal that their
    // score is about to be refused by the board.
    this.menuView.querySelectorAll('button[data-cheat-action]').forEach((el) => {
      el.addEventListener('click', () => {
        if (el.dataset.cheatAction === 'floors') this.game.cheatAddFloors(10);
        else if (el.dataset.cheatAction === 'score') this.game.cheatAddScore(100);
        this.updateBadge();
      });
    });
  }

  async _tryUnlock(){
    const code = this.codeInput.value;
    if (!code){ this.errorEl.textContent = 'Enter the passphrase.'; return; }
    this.errorEl.textContent = 'Checking…';
    const ok = await verifyCheat(code);
    if (ok){
      Cheats.unlocked = true;
      this.codeInput.value = '';
      this.errorEl.textContent = '';
      this._showMenu();
    } else {
      this.errorEl.textContent = 'Incorrect passphrase.';
    }
  }

  open(){
    this.overlay.classList.add('show');
    this.onOpen();
    if (Cheats.unlocked){
      this._showMenu();
    } else {
      this._showLock();
      setTimeout(() => this.codeInput.focus(), 50);
    }
  }
  toggle(){ this.overlay.classList.contains('show') ? this.close() : this.open(); }
  close(){ this.overlay.classList.remove('show'); this.onClose(); }

  // Turn every cheat off but stay unlocked for the session.
  exit(){
    Cheats.reset();
    this.syncControls();
    this.updateBadge();
    this.close();
  }

  _showLock(){ this.lockView.hidden = false; this.menuView.hidden = true; }
  _showMenu(){
    this.lockView.hidden = true;
    this.menuView.hidden = false;
    Cheats.active = true;        // arm — individual toggles now take effect
    this.syncControls();
    this.updateBadge();
  }

  // Push the current Cheats state onto the controls (used after exit/reset).
  syncControls(){
    this.menuView.querySelectorAll('input[data-cheat]').forEach((el) => {
      el.checked = !!Cheats[el.dataset.cheat];
    });
    this.menuView.querySelectorAll('select[data-cheat-select]').forEach((el) => {
      const key = el.dataset.cheatSelect;
      el.value = (key === 'speedOverride')
        ? (Cheats.speedOverride == null ? '' : String(Cheats.speedOverride))
        : String(Cheats[key]);
    });
  }

  // Show the badge whenever the CURRENT RUN is compromised — either a cheat is
  // engaged, or a one-shot action (+floors/+score) already tainted it. Cheated
  // runs are refused by the board (BLOCK_CHEATED=1), so this must never be
  // silently wrong. Cleared automatically on the next run (game.reset).
  updateBadge(){
    const tainted = !!(this.game && this.game.cheated);
    this.badge.hidden = !(Cheats.active && (Cheats.anyEngaged() || tainted));
  }
}
