// localStorage-backed persistence: best score, recent scores, mute pref.
// All reads are defensive so a corrupted value never breaks boot.

const BEST_KEY = 'stackfall_best';
const SCORES_KEY = 'stackfall_scores';
const MUTE_KEY = 'stackfall_muted';
const NAME_KEY = 'stackfall_name';

export const Storage = {
  best(){
    return parseInt(localStorage.getItem(BEST_KEY) || '0', 10) || 0;
  },
  scores(){
    try { return JSON.parse(localStorage.getItem(SCORES_KEY) || '[]'); }
    catch (e) { return []; }
  },
  addScore(s){
    const list = this.scores();
    list.push(s);
    // keep the tail bounded so storage never grows unbounded
    localStorage.setItem(SCORES_KEY, JSON.stringify(list.slice(-50)));
    if (s > this.best()) localStorage.setItem(BEST_KEY, String(s));
  },
  muted(){ return localStorage.getItem(MUTE_KEY) === '1'; },
  setMuted(m){ localStorage.setItem(MUTE_KEY, m ? '1' : '0'); },
  name(){ return localStorage.getItem(NAME_KEY) || ''; },
  setName(n){ localStorage.setItem(NAME_KEY, (n || '').slice(0, 12)); },
};
