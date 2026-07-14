// localStorage-backed persistence: best score, recent scores, mute pref.
// Every read/write goes through safe helpers with an in-memory fallback, so
// private-browsing limits, disabled storage, quota exhaustion, or a browser
// security policy can never throw and break boot or a completed run.

const BEST_KEY = 'stackfall_best';
const SCORES_KEY = 'stackfall_scores';
const MUTE_KEY = 'stackfall_muted';
const NAME_KEY = 'stackfall_name';
const TUTORIAL_KEY = 'stackfall_tutorial_seen';
const RUNS_KEY = 'stackfall_runs';            // bounded personal run history
const BESTDIFF_KEY = 'stackfall_best_diff';   // { normal, hardcore } best scores
const DAILY_KEY = 'stackfall_daily';          // { best, streak, lastDay }
const DIFFICULTY_KEY = 'stackfall_difficulty';
const HC_KEY = 'stackfall_high_contrast';
const RM_KEY = 'stackfall_reduced_motion';
const HAPTICS_KEY = 'stackfall_haptics';

const RUNS_MAX = 30;                            // history entries kept locally

// day-string helpers (YYYY-MM-DD, UTC) for streak math.
function dayAfter(s){
  const t = Date.parse(s + 'T00:00:00Z');
  if (Number.isNaN(t)) return '';
  return new Date(t + 86400000).toISOString().slice(0, 10);
}

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
  tutorialSeen(){ return safeGet(TUTORIAL_KEY) === '1'; },
  setTutorialSeen(){ safeSet(TUTORIAL_KEY, '1'); },

  // ---------- Personal run history ----------
  runs(){
    try { const v = JSON.parse(safeGet(RUNS_KEY) || '[]'); return Array.isArray(v) ? v : []; }
    catch (e) { return []; }
  },
  // record: { score, floors, mode, difficulty, streak }
  addRun(record){
    const score = Math.max(0, Math.floor(Number(record.score) || 0));
    const run = {
      score,
      floors: Math.max(0, Math.floor(Number(record.floors) || 0)),
      mode: record.mode === 'daily' ? 'daily' : 'endless',
      difficulty: record.difficulty === 'hardcore' ? 'hardcore' : 'normal',
      streak: Math.max(0, Math.floor(Number(record.streak) || 0)),
      ts: Date.now(),
    };
    const list = this.runs();
    list.unshift(run);
    safeSet(RUNS_KEY, JSON.stringify(list.slice(0, RUNS_MAX)));

    // Track best score per difficulty.
    const bd = this.bestByDifficulty();
    if (score > (bd[run.difficulty] || 0)){
      bd[run.difficulty] = score;
      safeSet(BESTDIFF_KEY, JSON.stringify(bd));
    }
    return run;
  },
  bestByDifficulty(){
    try { const v = JSON.parse(safeGet(BESTDIFF_KEY) || '{}'); return (v && typeof v === 'object') ? v : {}; }
    catch (e) { return {}; }
  },
  bestForDifficulty(d){
    const n = Number(this.bestByDifficulty()[d === 'hardcore' ? 'hardcore' : 'normal']);
    return Number.isFinite(n) ? n : 0;
  },

  // ---------- Daily stats (best / streak) ----------
  dailyStats(){
    try {
      const v = JSON.parse(safeGet(DAILY_KEY) || '{}') || {};
      return {
        best: Math.max(0, Math.floor(Number(v.best) || 0)),
        streak: Math.max(0, Math.floor(Number(v.streak) || 0)),
        lastDay: typeof v.lastDay === 'string' ? v.lastDay : '',
      };
    } catch (e) { return { best: 0, streak: 0, lastDay: '' }; }
  },
  // Update on a completed daily run. `day` is the run's UTC day string.
  recordDaily(day, score){
    const s = this.dailyStats();
    let streak;
    if (s.lastDay === day) streak = s.streak || 1;          // already played today
    else if (dayAfter(s.lastDay) === day) streak = s.streak + 1;  // consecutive day
    else streak = 1;                                        // gap (or first ever)
    const next = { best: Math.max(s.best, Math.floor(Number(score) || 0)), streak, lastDay: day };
    safeSet(DAILY_KEY, JSON.stringify(next));
    return next;
  },

  // ---------- Settings ----------
  difficulty(){ return safeGet(DIFFICULTY_KEY) === 'hardcore' ? 'hardcore' : 'normal'; },
  setDifficulty(d){ safeSet(DIFFICULTY_KEY, d === 'hardcore' ? 'hardcore' : 'normal'); },
  highContrast(){ return safeGet(HC_KEY) === '1'; },
  setHighContrast(v){ safeSet(HC_KEY, v ? '1' : '0'); },
  reducedMotion(){ return safeGet(RM_KEY) === '1'; },
  setReducedMotion(v){ safeSet(RM_KEY, v ? '1' : '0'); },
  haptics(){ const v = safeGet(HAPTICS_KEY); return v == null ? true : v === '1'; },
  setHaptics(v){ safeSet(HAPTICS_KEY, v ? '1' : '0'); },
};
