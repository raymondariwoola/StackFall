import {
  cleanDuelName,
  formatRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
} from '../shared/duel-protocol.js';
import { MultiplayerError } from './multiplayer.js';

const PREFIX = 'stackfall_beat_';

function get(store, key){ try { return store && store.getItem(key); } catch (error){ return null; } }
function set(store, key, value){ try { store && store.setItem(key, value); } catch (error){} }
function remove(store, key){ try { store && store.removeItem(key); } catch (error){} }

export function beatCodeFromUrl(value){
  try {
    const raw = new URL(String(value || ''), 'https://stackfall.local/').searchParams.get('beat');
    if (!raw) return null;
    const code = normalizeRoomCode(raw);
    return isValidRoomCode(code) ? formatRoomCode(code) : '';
  } catch (error){ return ''; }
}

export function buildBeatUrl(value, code){
  const normalized = normalizeRoomCode(code);
  if (!isValidRoomCode(normalized)) throw new MultiplayerError('bad_code');
  const url = new URL(String(value));
  url.search = '';
  url.hash = '';
  url.searchParams.set('beat', formatRoomCode(normalized));
  return url.toString();
}

export function withoutBeatUrl(value){
  const url = new URL(String(value));
  url.searchParams.delete('beat');
  url.hash = '';
  return url.toString();
}

export class BeatChallengeClient {
  constructor({ baseUrl, fetchImpl = globalThis.fetch, sessionStore = globalThis.sessionStorage } = {}){
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.fetchImpl = fetchImpl ? fetchImpl.bind(globalThis) : null;
    this.sessionStore = sessionStore;
    this.memory = new Map();
    this.challenge = null;
    this.code = '';
  }

  _key(code){ return PREFIX + normalizeRoomCode(code); }

  session(code){
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) return null;
    if (this.memory.has(normalized)) return { ...this.memory.get(normalized) };
    const raw = get(this.sessionStore, this._key(normalized));
    if (!raw) return null;
    try {
      const value = JSON.parse(raw);
      if (value.code === formatRoomCode(normalized) && ['host', 'guest'].includes(value.seat) &&
          /^[a-f0-9]{48}$/.test(value.token || '')){
        this.memory.set(normalized, value);
        return { ...value };
      }
    } catch (error){}
    this.clearSession(normalized);
    return null;
  }

  _save(value){
    const normalized = normalizeRoomCode(value.code);
    const session = { ...value, code: formatRoomCode(normalized) };
    this.memory.set(normalized, session);
    set(this.sessionStore, this._key(normalized), JSON.stringify(session));
    return { ...session };
  }

  clearSession(code){
    const normalized = normalizeRoomCode(code);
    this.memory.delete(normalized);
    remove(this.sessionStore, this._key(normalized));
  }

  async _request(path, options = {}){
    if (!this.baseUrl || !this.fetchImpl) throw new MultiplayerError('multiplayer_unconfigured');
    let response;
    try { response = await this.fetchImpl(this.baseUrl + path, options); }
    catch (error){ throw new MultiplayerError('offline'); }
    let data;
    try { data = await response.json(); } catch (error){}
    if (!response.ok || !data || data.ok === false){
      throw new MultiplayerError(data && data.error || 'network_error', response.status);
    }
    return data;
  }

  async create({ name, difficulty }){
    const cleanName = cleanDuelName(name);
    if (!cleanName) throw new MultiplayerError('bad_name');
    const data = await this._request('/challenges', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName, difficulty }),
    });
    const session = this._save({ code: data.code, seat: 'host', token: data.hostToken });
    this.code = session.code;
    this.challenge = data.challenge;
    return { challenge: data.challenge, session };
  }

  async read(code){
    const normalized = normalizeRoomCode(code);
    if (!isValidRoomCode(normalized)) throw new MultiplayerError('bad_code');
    const formatted = formatRoomCode(normalized);
    const data = await this._request(`/challenges/${formatted}`);
    this.code = formatted;
    this.challenge = data.challenge;
    return data.challenge;
  }

  async recover(code){
    const challenge = await this.read(code);
    return { challenge, session: this.session(code) };
  }

  async join({ code, name }){
    const normalized = normalizeRoomCode(code);
    const cleanName = cleanDuelName(name);
    if (!isValidRoomCode(normalized)) throw new MultiplayerError('bad_code');
    if (!cleanName) throw new MultiplayerError('bad_name');
    const formatted = formatRoomCode(normalized);
    const data = await this._request(`/challenges/${formatted}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName }),
    });
    const session = this._save({ code: formatted, seat: 'guest', token: data.guestToken });
    this.code = formatted;
    this.challenge = data.challenge;
    return { challenge: data.challenge, session };
  }

  async finish(progress){
    const session = this.session(this.code);
    if (!session) throw new MultiplayerError('session_missing');
    const data = await this._request(`/challenges/${session.code}/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify(progress),
    });
    this.challenge = data.challenge;
    return data.challenge;
  }

  async cancel(){
    const session = this.session(this.code);
    if (!session || session.seat !== 'host') throw new MultiplayerError('unauthorized');
    await this._request(`/challenges/${session.code}/cancel`, {
      method: 'POST', headers: { Authorization: `Bearer ${session.token}` },
    });
    this.clearSession(session.code);
    this.challenge = null;
    this.code = '';
  }
}
