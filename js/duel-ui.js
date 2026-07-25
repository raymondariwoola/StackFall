import { cleanDuelName, formatRoomCode, isValidRoomCode, normalizeRoomCode } from '../shared/duel-protocol.js';

export const DUEL_ERROR_COPY = Object.freeze({
  bad_code: 'That challenge code is not valid. Check all eight characters and try again.',
  room_not_found: 'That challenge has expired or no longer exists.',
  room_full: 'This challenge already has two players.',
  room_started: 'This duel has already started.',
  room_cancelled: 'The host cancelled this challenge.',
  multiplayer_disabled: 'Duel mode is temporarily unavailable. Single-player still works.',
  multiplayer_unconfigured: 'Duel mode is not configured on this version of StackFall.',
  origin_forbidden: 'This copy of StackFall is not allowed to join online duels.',
  session_missing: 'This tab no longer has its private seat key. Open the invite again to rejoin.',
  unauthorized: 'This tab no longer owns that seat. Open the invite again to continue.',
  not_connected: 'The live room is reconnecting. Try again in a moment.',
  websocket_unavailable: 'This browser does not support the live room connection.',
  socket_replaced: 'This seat was opened in another tab. Continue there or reconnect here.',
  replaced: 'This seat is active in another tab.',
  offline: 'You appear to be offline. Reconnect and try again.',
  socket_failed: 'The live room connection failed. Check your connection and retry.',
  network_error: 'The room service did not respond. Please try again.',
});

export function duelErrorText(code){
  return DUEL_ERROR_COPY[code] || 'Something interrupted the challenge. Please try again.';
}

export function roomLobbyModel(room, session, connection = 'connected'){
  const seat = session && session.seat;
  const own = seat && room && room.seats ? room.seats[seat] : null;
  const guestPresent = !!(room && room.seats && room.seats.guest);
  const waiting = room && room.state === 'waiting';
  return {
    code: formatRoomCode(room && room.code),
    difficulty: room && room.difficulty === 'hardcore' ? 'Hardcore' : 'Normal',
    seat,
    connected: connection === 'connected',
    canReady: !!(waiting && own && guestPresent && !own.ready && connection === 'connected'),
    readyLabel: own && own.ready ? 'Ready ✓' : guestPresent ? "I'm Ready" : 'Waiting for Friend',
    status: connection === 'reconnecting'
      ? 'Connection lost — reclaiming your seat…'
      : connection === 'connecting'
        ? 'Connecting to the live room…'
        : room && room.state === 'countdown'
          ? 'Both players are ready. Duel starting…'
          : room && room.state === 'playing'
            ? 'The synchronized countdown completed. Keep this lobby open.'
          : guestPresent
            ? 'Both players are here. Ready up when you are set.'
            : 'Room created. Send the link or code to your friend.',
  };
}

function setPlayer(row, nameNode, stateNode, seat){
  const present = !!seat;
  nameNode.textContent = present ? seat.name : 'Waiting…';
  stateNode.textContent = !present ? 'Open seat' : seat.ready ? 'Ready' : seat.connected ? 'Connected' : 'Reconnecting';
  row.classList.toggle('ready', !!(seat && seat.ready));
  row.classList.toggle('open', !present);
}

export class DuelUI {
  constructor(root = document.getElementById('duel-overlay')){
    this.root = root;
    this.panel = root.querySelector('.duel-panel');
    this.title = root.querySelector('#duel-title');
    this.status = root.querySelector('#duel-status');
    this.closeBtn = root.querySelector('#duel-close');
    this.joinView = root.querySelector('#duel-join-view');
    this.nameInput = root.querySelector('#duel-name');
    this.codeInput = root.querySelector('#duel-code');
    this.formError = root.querySelector('#duel-form-error');
    this.joinSubmit = root.querySelector('#duel-join-submit');
    this.lobbyView = root.querySelector('#duel-lobby-view');
    this.roomCode = root.querySelector('#duel-room-code');
    this.difficulty = root.querySelector('#duel-difficulty');
    this.hostRow = root.querySelector('#duel-host-row');
    this.hostName = root.querySelector('#duel-host-name');
    this.hostState = root.querySelector('#duel-host-state');
    this.guestRow = root.querySelector('#duel-guest-row');
    this.guestName = root.querySelector('#duel-guest-name');
    this.guestState = root.querySelector('#duel-guest-state');
    this.shareActions = root.querySelector('#duel-share-actions');
    this.shareBtn = root.querySelector('#duel-share');
    this.copyLinkBtn = root.querySelector('#duel-copy-link');
    this.copyCodeBtn = root.querySelector('#duel-copy-code');
    this.readyBtn = root.querySelector('#duel-ready');
    this.lobbyNote = root.querySelector('#duel-lobby-note');
    this.leaveBtn = root.querySelector('#duel-leave');
    this.errorView = root.querySelector('#duel-error-view');
    this.errorCopy = root.querySelector('#duel-error-copy');
    this.errorAction = root.querySelector('#duel-error-action');
    this.busy = root.querySelector('#duel-busy');
    this.callbacks = {};
    this.room = null;
    this.session = null;
    this.errorCode = '';

    this.codeInput.addEventListener('input', () => {
      this.codeInput.value = formatRoomCode(normalizeRoomCode(this.codeInput.value));
      this.formError.textContent = '';
    });
    this.nameInput.addEventListener('input', () => { this.formError.textContent = ''; });
    this.joinView.addEventListener('submit', (event) => {
      event.preventDefault();
      const code = formatRoomCode(normalizeRoomCode(this.codeInput.value));
      const name = cleanDuelName(this.nameInput.value);
      if (!name){ this.formError.textContent = 'Enter a name for this duel.'; this.nameInput.focus(); return; }
      if (!isValidRoomCode(code)){ this.formError.textContent = duelErrorText('bad_code'); this.codeInput.focus(); return; }
      this.callbacks.join?.({ code, name });
    });
    this.closeBtn.addEventListener('click', () => this.callbacks.close?.());
    this.shareBtn.addEventListener('click', () => this.callbacks.share?.());
    this.copyLinkBtn.addEventListener('click', () => this.callbacks.copyLink?.());
    this.copyCodeBtn.addEventListener('click', () => this.callbacks.copyCode?.());
    this.readyBtn.addEventListener('click', () => this.callbacks.ready?.());
    this.leaveBtn.addEventListener('click', () => this.callbacks.leave?.());
    this.errorAction.addEventListener('click', () => this.callbacks.retry?.());
    this.root.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      if (event.target === this.root) this.callbacks.close?.();
    });
  }

  setCallbacks(callbacks){ this.callbacks = callbacks || {}; }

  _view(name){
    this.joinView.hidden = name !== 'join';
    this.lobbyView.hidden = name !== 'lobby';
    this.errorView.hidden = name !== 'error';
    this.busy.hidden = name !== 'busy';
  }

  show(){
    this.root.classList.add('show');
    this.root.setAttribute('aria-hidden', 'false');
  }

  hide(){
    this.root.classList.remove('show');
    this.root.setAttribute('aria-hidden', 'true');
  }

  showJoin({ code = '', name = '', error = '' } = {}){
    this._view('join');
    this.title.textContent = code ? 'Join This Duel' : 'Join a Duel';
    this.status.textContent = code ? 'You were invited. Add your name to claim the open seat.' : 'Enter the eight-character code your friend shared.';
    this.nameInput.value = cleanDuelName(name);
    this.codeInput.value = formatRoomCode(normalizeRoomCode(code));
    this.formError.textContent = error ? duelErrorText(error) : '';
    this.show();
  }

  showBusy(message = 'Connecting to the room…'){
    this._view('busy');
    this.title.textContent = 'One moment';
    this.status.textContent = message;
    this.show();
  }

  showLobby(room, session, connection = 'connected'){
    this.room = room;
    this.session = session;
    const model = roomLobbyModel(room, session, connection);
    this._view('lobby');
    this.title.textContent = session && session.seat === 'host' ? 'Your Challenge' : 'Duel Lobby';
    this.status.textContent = model.status;
    this.roomCode.textContent = model.code;
    this.difficulty.textContent = `${model.difficulty} · shared seed`;
    setPlayer(this.hostRow, this.hostName, this.hostState, room.seats.host);
    setPlayer(this.guestRow, this.guestName, this.guestState, room.seats.guest);
    this.shareActions.hidden = session && session.seat !== 'host';
    this.readyBtn.textContent = model.readyLabel;
    this.readyBtn.disabled = !model.canReady;
    this.lobbyNote.textContent = room.state === 'countdown' || room.state === 'playing'
      ? 'Live Duel gameplay will connect to this handoff in the next phase.'
      : 'The duel starts when both players are ready.';
    this.show();
  }

  setConnection(connection){
    if (this.room && this.session) this.showLobby(this.room, this.session, connection);
  }

  showError(code, { action = 'Try Again' } = {}){
    this.errorCode = code;
    this._view('error');
    this.title.textContent = code === 'room_full'
      ? 'Room Full'
      : code === 'room_not_found' || code === 'room_cancelled'
        ? 'Challenge Ended'
        : 'Could Not Join';
    this.status.textContent = 'Your single-player game is still available.';
    this.errorCopy.textContent = duelErrorText(code);
    this.errorAction.textContent = action;
    this.show();
  }

  flash(button, text){
    const previous = button.textContent;
    button.textContent = text;
    button.disabled = true;
    clearTimeout(button._duelFlashTimer);
    button._duelFlashTimer = setTimeout(() => {
      button.textContent = previous;
      button.disabled = false;
    }, 1400);
  }
}
