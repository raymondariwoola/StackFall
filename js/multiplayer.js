import {
  DUEL_SOCKET_PROTOCOL,
  duelTicketProtocol,
  DUEL_PROTOCOL_VERSION,
  SERVER_MESSAGE_TYPES,
  cleanDuelName,
  formatRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from '../shared/duel-protocol.js';

const SESSION_PREFIX = 'stackfall_duel_';
const RECONNECT_DELAYS = Object.freeze([500, 1000, 2000, 4000, 8000, 10000]);

export class MultiplayerError extends Error {
  constructor(code, status = 0){
    super(code || 'network_error');
    this.name = 'MultiplayerError';
    this.code = code || 'network_error';
    this.status = status;
  }
}

function safeSessionGet(store, key){
  try { return store && store.getItem(key); } catch (e) { return null; }
}

function safeSessionSet(store, key, value){
  try { if (store) store.setItem(key, value); } catch (e) { /* session-only fallback below */ }
}

function safeSessionRemove(store, key){
  try { if (store) store.removeItem(key); } catch (e) { /* already unavailable */ }
}

export function challengeCodeFromUrl(value){
  try {
    const url = new URL(String(value || ''), 'https://stackfall.local/');
    const raw = url.searchParams.get('duel');
    if (!raw) return null;
    const code = normalizeRoomCode(raw);
    return isValidRoomCode(code) ? formatRoomCode(code) : '';
  } catch (e) {
    return '';
  }
}

export function buildChallengeUrl(value, code){
  const normalized = normalizeRoomCode(code);
  if (!isValidRoomCode(normalized)) throw new MultiplayerError('bad_code');
  const url = new URL(String(value));
  url.hash = '';
  url.search = '';
  url.searchParams.set('duel', formatRoomCode(normalized));
  return url.toString();
}

export function withoutChallengeUrl(value){
  const url = new URL(String(value));
  url.searchParams.delete('duel');
  url.hash = '';
  return url.toString();
}

export function resolveMultiplayerWorkerUrl(defaultUrl, locationLike = globalThis.location){
  const hostname = locationLike && locationLike.hostname;
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'){
    // The dedicated Duel dev server proxies /matches on the page's own origin,
    // which avoids browser/extension cross-port policies during E2E testing.
    if (String(locationLike.port || '') === '8137') return String(locationLike.origin || '').replace(/\/$/, '');
    return `${locationLike.protocol || 'http:'}//${hostname === '::1' ? '[::1]' : hostname}:8788`;
  }
  return String(defaultUrl || '').replace(/\/$/, '');
}

function socketUrl(baseUrl, code){
  const url = new URL(`${baseUrl}/matches/${encodeURIComponent(code)}/socket`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

export class MultiplayerClient {
  constructor({
    baseUrl,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
    sessionStore = globalThis.sessionStorage,
    setTimer = null,
    clearTimer = null,
    heartbeatMs = 15_000,
  } = {}){
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    // Browser-native fetch is receiver-sensitive in some engines. Bind it to
    // the global object so calling it through this client cannot become an
    // "Illegal invocation" before the request leaves the page.
    this.fetchImpl = fetchImpl ? fetchImpl.bind(globalThis) : null;
    this.WebSocketImpl = WebSocketImpl;
    this.sessionStore = sessionStore;
    // Window timer methods throw "Illegal invocation" in some browsers when
    // detached and later called as object properties. Wrap rather than retain
    // the native function reference.
    this.setTimer = setTimer || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimer = clearTimer || ((timer) => globalThis.clearTimeout(timer));
    this.heartbeatMs = Math.max(0, Number(heartbeatMs) || 0);
    this.listeners = new Map();
    this.memorySessions = new Map();
    this.socket = null;
    this.code = '';
    this.room = null;
    this.connection = 'idle';
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.generation = 0;
    this.manualClose = false;
  }

  on(type, listener){
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.listeners.get(type)?.delete(listener);
  }

  _emit(type, detail = {}){
    for (const listener of this.listeners.get(type) || []) listener(detail);
  }

  _setConnection(connection, detail = {}){
    this.connection = connection;
    this._emit('connection', { connection, ...detail });
  }

  _sessionKey(code){ return SESSION_PREFIX + normalizeRoomCode(code); }

  session(code){
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) return null;
    if (this.memorySessions.has(normalized)) return { ...this.memorySessions.get(normalized) };
    const raw = safeSessionGet(this.sessionStore, this._sessionKey(normalized));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (value && value.code === formatRoomCode(normalized) &&
          (value.seat === 'host' || value.seat === 'guest') &&
          /^[a-f0-9]{48}$/.test(value.token || '')) {
        const session = { ...value, nextSeq: Math.max(0, Number(value.nextSeq) || 0) };
        this.memorySessions.set(normalized, session);
        return { ...session };
      }
    } catch (e) { /* discard corrupt session */ }
    this.clearSession(normalized);
    return null;
  }

  _saveSession(session){
    const normalized = normalizeRoomCode(session.code);
    const value = { ...session, code: formatRoomCode(normalized) };
    this.memorySessions.set(normalized, value);
    safeSessionSet(this.sessionStore, this._sessionKey(normalized), JSON.stringify(value));
    return { ...value };
  }

  clearSession(code){
    const normalized = normalizeRoomCode(code);
    this.memorySessions.delete(normalized);
    safeSessionRemove(this.sessionStore, this._sessionKey(normalized));
  }

  async _request(path, options = {}){
    if (!this.baseUrl || !this.fetchImpl) throw new MultiplayerError('multiplayer_unconfigured');
    let response;
    try { response = await this.fetchImpl(this.baseUrl + path, options); }
    catch (e) { throw new MultiplayerError('offline'); }
    let data = null;
    try { data = await response.json(); } catch (e) { /* non-JSON gateway failure */ }
    if (!response.ok || !data || data.ok === false){
      throw new MultiplayerError((data && data.error) || 'network_error', response.status);
    }
    return data;
  }

  async create({ name, difficulty }){
    const cleanName = cleanDuelName(name);
    if (!cleanName) throw new MultiplayerError('bad_name');
    const data = await this._request('/matches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName, difficulty }),
    });
    const session = this._saveSession({
      code: data.code, seat: 'host', token: data.hostToken, nextSeq: 0,
    });
    this.code = session.code;
    this.room = data.room;
    return { room: data.room, session };
  }

  async join({ code, name }){
    const normalized = normalizeRoomCode(code);
    const cleanName = cleanDuelName(name);
    if (!isValidRoomCode(normalized)) throw new MultiplayerError('bad_code');
    if (!cleanName) throw new MultiplayerError('bad_name');
    const formatted = formatRoomCode(normalized);
    const data = await this._request(`/matches/${formatted}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName }),
    });
    const session = this._saveSession({
      code: formatted, seat: 'guest', token: data.playerToken, nextSeq: 0,
    });
    this.code = session.code;
    this.room = data.room;
    return { room: data.room, session };
  }

  async read(code){
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) throw new MultiplayerError('bad_code');
    const data = await this._request(`/matches/${formatRoomCode(normalized)}`);
    this.room = data.room;
    return data.room;
  }

  async recover(code){
    const room = await this.read(code);
    const session = this.session(code);
    if (session) await this.connect(session.code);
    return { room, session };
  }

  async connect(code = this.code){
    const session = this.session(code);
    if (!session) throw new MultiplayerError('session_missing');
    if (!this.WebSocketImpl) throw new MultiplayerError('websocket_unavailable');
    const generation = ++this.generation;
    this.manualClose = false;
    this.code = session.code;
    this._cancelReconnect();
    this._setConnection(this.reconnectAttempt ? 'reconnecting' : 'connecting', {
      attempt: this.reconnectAttempt,
    });

    const ticketData = await this._request(`/matches/${session.code}/socket-ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.token}` },
    });
    if (generation !== this.generation) return null;

    const socket = new this.WebSocketImpl(socketUrl(this.baseUrl, session.code), [
      DUEL_SOCKET_PROTOCOL,
      duelTicketProtocol(ticketData.ticket),
    ]);
    this.socket = socket;
    return await new Promise((resolve, reject) => {
      let settled = false;
      socket.addEventListener('open', () => {
        if (socket !== this.socket || generation !== this.generation) return;
        settled = true;
        this.reconnectAttempt = 0;
        this._scheduleHeartbeat();
        this._setConnection('connected');
        resolve(socket);
      }, { once: true });
      socket.addEventListener('message', (event) => this._handleMessage(socket, event.data));
      socket.addEventListener('close', (event) => {
        if (socket !== this.socket || generation !== this.generation) return;
        this._stopHeartbeat();
        this.socket = null;
        this._emit('close', { code: event.code, reason: event.reason || '' });
        if (!settled){
          settled = true;
          reject(new MultiplayerError('socket_failed'));
        }
        if (!this.manualClose) this._scheduleReconnect();
      });
      socket.addEventListener('error', () => {
        if (!settled){
          settled = true;
          reject(new MultiplayerError('socket_failed'));
        }
      }, { once: true });
    });
  }

  _handleMessage(socket, raw){
    if (socket !== this.socket) return;
    let message;
    try { message = JSON.parse(String(raw)); } catch (e) { return; }
    if (!message || message.v !== DUEL_PROTOCOL_VERSION ||
        !SERVER_MESSAGE_TYPES.includes(message.type) ||
        !message.payload || typeof message.payload !== 'object') return;

    if (message.payload.room) this.room = message.payload.room;
    if (message.type === 'error' && message.payload.code === 'socket_replaced'){
      this.manualClose = true;
      this._setConnection('replaced');
    }
    if (message.type === 'error' && message.payload.code === 'multiplayer_disabled'){
      this.manualClose = true;
      this._stopHeartbeat();
      this._setConnection('disabled');
    }
    if (message.type === 'expired'){
      this.clearSession(this.code);
      this.manualClose = true;
    }
    this._emit('message', message);
    this._emit(message.type, message.payload);
  }

  send(type, payload = {}){
    if (!this.socket || this.socket.readyState !== 1) throw new MultiplayerError('not_connected');
    const session = this.session(this.code);
    if (!session) throw new MultiplayerError('session_missing');
    const seq = session.nextSeq;
    this.socket.send(JSON.stringify({ v: DUEL_PROTOCOL_VERSION, type, seq, payload }));
    this._saveSession({ ...session, nextSeq: seq + 1 });
    return seq;
  }

  ready(){ return this.send('ready'); }
  progress(payload){ return this.send('progress', payload); }
  finish(payload){ return this.send('finish', payload); }
  rematch(){ return this.send('rematch_vote'); }
  forfeit(){ return this.send('leave'); }

  async leave(){
    const code = this.code;
    const session = this.session(code);
    let acknowledge = Promise.resolve();
    if (this.socket && this.socket.readyState === 1 && session){
      acknowledge = new Promise((resolve) => {
        let finished = false;
        let timer = null;
        const done = () => {
          if (finished) return;
          finished = true;
          if (timer != null) this.clearTimer(timer);
          offPresence();
          offResult();
          resolve();
        };
        const accepts = (payload) => {
          const room = payload && payload.room;
          if (!room) return;
          if (room.state === 'cancelled' || room.state === 'forfeit' || room.state === 'finished') done();
          else if (session.seat === 'guest' && room.seats && !room.seats.guest) done();
        };
        const offPresence = this.on('presence', accepts);
        const offResult = this.on('result', accepts);
        timer = this.setTimer(done, 750);
      });
    }
    try { this.send('leave'); } catch (e) { /* a disconnected leave expires naturally */ }
    await acknowledge;
    this.disconnect();
    this.clearSession(code);
    this.room = null;
    this.code = '';
  }

  disconnect(){
    this.manualClose = true;
    this.generation++;
    this._cancelReconnect();
    this._stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    try { if (socket && socket.readyState < 2) socket.close(1000, 'client closed'); } catch (e) { /* closed */ }
    this._setConnection('idle');
  }

  retry(){
    this.reconnectAttempt = 0;
    this._cancelReconnect();
    return this.connect(this.code);
  }

  _scheduleReconnect(){
    if (!this.code || !this.session(this.code) || this.manualClose) return;
    const index = Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1);
    const delay = RECONNECT_DELAYS[index];
    this.reconnectAttempt++;
    this._setConnection('reconnecting', { attempt: this.reconnectAttempt, delay });
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.connect(this.code).catch((error) => {
        this._emit('transport_error', { error });
        this._scheduleReconnect();
      });
    }, delay);
  }

  _cancelReconnect(){
    if (this.reconnectTimer != null) this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  _scheduleHeartbeat(){
    this._stopHeartbeat();
    if (!this.heartbeatMs || this.manualClose) return;
    this.heartbeatTimer = this.setTimer(() => {
      this.heartbeatTimer = null;
      if (this.socket && this.socket.readyState === 1){
        try { this.send('heartbeat'); } catch (e) { /* reconnect owns recovery */ }
      }
      if (!this.manualClose) this._scheduleHeartbeat();
    }, this.heartbeatMs);
    // Node tests should not be held open by a browser-only keepalive timer.
    this.heartbeatTimer && this.heartbeatTimer.unref?.();
  }

  _stopHeartbeat(){
    if (this.heartbeatTimer != null) this.clearTimer(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
