// localStorage-backed persistence: best score, recent scores, mute pref.
// Every read/write goes through safe helpers with an in-memory fallback, so
// private-browsing limits, disabled storage, quota exhaustion, or a browser
// security policy can never throw and break boot or a completed run.

const BEST_KEY = 'stackfall_best';
const SCORES_KEY = 'stackfall_scores';
const MUTE_KEY = 'stackfall_muted';
const NAME_KEY = 'stackfall_name';

// In-memory shadow used whenever localStorage is unavailable or throws. The
// game stays fully playable for the session; only cross-session persistence
// is lost.
const mem = new Map();

function safeGet(key){
  try {
    const v = localStorage.getItem(key);
    return v != null ? v : (mem.has(key) ? mem.get(key) : null);
  } catch (e) {
    return mem.has(key) ? mem.get(key) : null;
  }
}

function safeSet(key, value){
  // Always keep the in-memory copy so reads succeed even if the write below
  // throws (e.g. quota exceeded in private mode).
  mem.set(key, value);
  try { localStorage.setItem(key, value); } catch (e) { /* keep the in-memory value */ }
}

// Coerce stored scores into a clean array of finite, non-negative integers so a
// corrupted or hand-edited value can never break sorting or rendering.
function sanitizeScores(list){
  if (!Array.isArray(list)) return [];
  return list
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.floor(n));
}

export const Storage = {
  best(){
    return parseInt(safeGet(BEST_KEY) || '0', 10) || 0;
  },
  scores(){
    try { return sanitizeScores(JSON.parse(safeGet(SCORES_KEY) || '[]')); }
    catch (e) { return []; }
  },
  addScore(s){
    const score = Number(s);
    if (!Number.isFinite(score) || score < 0) return;
    const list = this.scores();
    list.push(Math.floor(score));
    // keep the tail bounded so storage never grows unbounded
    safeSet(SCORES_KEY, JSON.stringify(list.slice(-50)));
    if (score > this.best()) safeSet(BEST_KEY, String(Math.floor(score)));
  },
  muted(){ return safeGet(MUTE_KEY) === '1'; },
  setMuted(m){ safeSet(MUTE_KEY, m ? '1' : '0'); },
  name(){ return safeGet(NAME_KEY) || ''; },
  setName(n){ safeSet(NAME_KEY, (n || '').slice(0, 12)); },
};
