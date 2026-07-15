// Standalone leaderboard page. Deliberately tiny: no canvas, no game loop —
// it only reads the Worker boards. Filter state lives in the URL
// (?scope=daily&difficulty=hardcore) so any board is shareable/deep-linkable.

import { fetchLeaderboard, WORKER_URL } from './leaderboard.js';
import { Storage } from './storage.js';
import { renderScoreRows, boardLabel, findRank } from './board.js';

const el = {
  heading: document.getElementById('lb-heading'),
  sub: document.getElementById('lb-sub'),
  status: document.getElementById('lb-status'),
  list: document.getElementById('lb-full'),
  scopeSeg: document.getElementById('scope-seg'),
  diffSeg: document.getElementById('diff-seg'),
  health: document.getElementById('lb-health'),
  healthText: document.getElementById('lb-health-text'),
  back: document.getElementById('back-link'),
};

// ---------- state (mirrored to the URL) ----------
function readParams(){
  const p = new URLSearchParams(location.search);
  const scope = p.get('scope') === 'daily' ? 'daily' : 'all';
  const difficulty = p.get('difficulty') === 'hardcore' ? 'hardcore' : 'normal';
  return { scope, difficulty };
}
let { scope, difficulty } = readParams();
let reqToken = 0;   // only the latest fetch may render

function writeParams(push){
  const p = new URLSearchParams();
  if (scope === 'daily') p.set('scope', 'daily');
  if (difficulty === 'hardcore') p.set('difficulty', 'hardcore');
  const url = location.pathname + (p.toString() ? '?' + p.toString() : '');
  if (push) history.pushState({ scope, difficulty }, '', url);
  else history.replaceState({ scope, difficulty }, '', url);
}

function syncSegments(){
  el.scopeSeg.querySelectorAll('[data-scope]').forEach((b) => {
    const on = b.dataset.scope === scope;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  el.diffSeg.querySelectorAll('[data-difficulty]').forEach((b) => {
    const on = b.dataset.difficulty === difficulty;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  el.heading.textContent = boardLabel(scope === 'daily', difficulty);
}

function setHealth(state){
  if (!WORKER_URL){ el.health.hidden = true; return; }
  el.health.hidden = false;
  el.health.classList.toggle('online', state === 'online');
  el.health.classList.toggle('offline', state === 'offline');
  el.healthText.textContent = state === 'offline' ? 'Offline' : 'Online';
}

async function load(){
  syncSegments();
  const myToken = ++reqToken;

  if (!WORKER_URL){
    el.status.hidden = false;
    el.status.textContent = 'No leaderboard configured — StackFall is running offline.';
    el.list.innerHTML = '';
    return;
  }

  el.status.hidden = false;
  el.status.textContent = 'Loading…';
  el.list.innerHTML = '';

  try {
    const data = await fetchLeaderboard(scope === 'daily', difficulty);
    if (myToken !== reqToken) return;   // a newer filter change superseded us
    const scores = (data && Array.isArray(data.scores)) ? data.scores : [];
    const me = Storage.name();
    el.list.innerHTML = renderScoreRows(scores, me, { limit: 20 });

    const rank = findRank(scores, me);
    el.status.hidden = !rank;
    if (rank) el.status.textContent = `You're #${rank} on this board.`;
    el.sub.textContent = scores.length
      ? `Top ${Math.min(20, scores.length)} · Normal and Hardcore are ranked separately.`
      : 'No scores on this board yet — be the first.';
    setHealth('online');
  } catch (e) {
    if (myToken !== reqToken) return;
    el.status.hidden = false;
    el.status.textContent = 'Offline — the leaderboard is unavailable right now. Your local scores are safe.';
    el.list.innerHTML = '';
    setHealth('offline');
  }
}

// ---------- wiring ----------
el.scopeSeg.addEventListener('click', (e) => {
  const b = e.target.closest('[data-scope]');
  if (!b || b.dataset.scope === scope) return;
  scope = b.dataset.scope;
  writeParams(true);
  load();
});
el.diffSeg.addEventListener('click', (e) => {
  const b = e.target.closest('[data-difficulty]');
  if (!b || b.dataset.difficulty === difficulty) return;
  difficulty = b.dataset.difficulty;
  writeParams(true);
  load();
});
// Keep Back/Forward working with the filter state.
window.addEventListener('popstate', () => {
  ({ scope, difficulty } = readParams());
  load();
});

writeParams(false);
load();
