// Shared leaderboard rendering, used by BOTH the in-game panel summary
// (js/ui.js) and the standalone leaderboard page (js/leaderboard-page.js), so
// row markup and escaping can't drift between the two.

export function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Human label for a board: "Today's Hardcore" / "All-Time Normal".
export function boardLabel(daily, difficulty){
  return `${daily ? "Today's" : 'All-Time'} ${difficulty === 'hardcore' ? 'Hardcore' : 'Normal'}`;
}

// Score rows. Names are sanitized server-side; we escape again as
// defense-in-depth. `myName` highlights the player's own entries.
// `limit` caps the rows; `offset` keeps ranks correct when slicing.
export function renderScoreRows(scores, myName, { limit = 20, offset = 0 } = {}){
  const rows = (scores || []).slice(offset, offset + limit).map((e, i) => {
    const mine = myName && e.name === myName ? ' me' : '';
    return `<div class="lb-row${mine}"><span>#${offset + i + 1} ${escapeHtml(e.name || 'anon')}</span>` +
      `<span>${e.score | 0} pts</span></div>`;
  }).join('');
  return rows || '<div class="lb-row"><span>No scores yet</span><span>—</span></div>';
}

// Find the player's best rank on a board (1-based), or 0 if absent.
export function findRank(scores, myName){
  if (!myName || !Array.isArray(scores)) return 0;
  const i = scores.findIndex((e) => e && e.name === myName);
  return i === -1 ? 0 : i + 1;
}
