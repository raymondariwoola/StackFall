// Pure helpers at the boundary between local StackFall gameplay and the Duel
// protocol. Keeping this module DOM-free makes progress/result behavior easy to
// verify without changing the responsive, local physics loop.

export const EMPTY_DUEL_PROGRESS = Object.freeze({
  score: 0,
  floors: 0,
  perfects: 0,
  maxCombo: 0,
  combo: 0,
  widthRatio: 0,
  cheated: false,
});

function finiteRatio(value){
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function duelProgress(source = {}){
  return {
    score: Math.max(0, Math.trunc(source.score || 0)),
    floors: Math.max(0, Math.trunc(source.floors || 0)),
    perfects: Math.max(0, Math.trunc(source.perfects || 0)),
    maxCombo: Math.max(0, Math.trunc(source.maxCombo || 0)),
    combo: Math.max(0, Math.trunc(source.combo || 0)),
    widthRatio: finiteRatio(source.widthRatio),
    cheated: source.cheated === true,
  };
}

// Cheat state is a local-only part of the owner's private game session in
// friend modes. The opponent still receives the resulting score/progress, but
// never a protocol flag or special result reason that announces cheat use.
export function privateMultiplayerProgress(source = {}){
  return { ...duelProgress(source), cheated: false };
}

export function progressFromGame(game){
  const top = game && game.stack && game.stack.length ? game.stack[game.stack.length - 1] : null;
  return duelProgress({
    score: game && game.score,
    floors: game && game.floors,
    perfects: game && game.perfects,
    maxCombo: game && game.maxCombo,
    combo: game && game.combo,
    widthRatio: top && game.baseW > 0 ? top.w / game.baseW : 0,
    cheated: game && game.cheated,
  });
}

export function opponentSeat(seat){ return seat === 'host' ? 'guest' : 'host'; }

export function hasSecuredWin(own, opponent, opponentFinished){
  return !!(opponentFinished && own && opponent && own.score > opponent.score);
}

function competitiveTaunt({ won, opponentName, ownScore, opponentScore }){
  const margin = Math.abs(ownScore - opponentScore);
  const winningScore = Math.max(ownScore, opponentScore, 1);
  const marginRatio = margin / winningScore;

  if (margin <= 2 || marginRatio < .1){
    return won
      ? { title: 'Clutch Victory!', detail: `${opponentName} was one clean drop from stealing that. Breathe.` }
      : { title: 'Painfully Close', detail: `${opponentName} barely escaped. One cleaner drop and they were finished.` };
  }
  if (margin <= 8 || marginRatio < .3){
    return won
      ? { title: 'Easy Work.', detail: `A comfortable win. ${opponentName} can blame lag if it helps them sleep.` }
      : { title: 'Outplayed.', detail: `${opponentName} beat you cleanly. Start preparing better excuses.` };
  }
  if (marginRatio < .6){
    return won
      ? { title: 'You Cooked Them', detail: `${opponentName} just became the tutorial. That rematch button is pure optimism.` }
      : { title: 'You Got Cooked', detail: `${opponentName} used you as a warm-up. Even the tower looked embarrassed.` };
  }
  return won
    ? { title: 'Absolute Demolition', detail: `${opponentName}'s score needs a search party. Maybe offer them Practice mode.` }
    : { title: 'Public Demolition', detail: `${opponentName} erased your tower and your bragging rights. Practice mode is right there.` };
}

export function resultModel(room, seat){
  const result = room && room.result || {};
  const winner = result.winner;
  const own = room && room.seats && room.seats[seat];
  const otherId = opponentSeat(seat);
  const other = room && room.seats && room.seats[otherId];
  const won = winner === seat;
  const draw = winner == null;
  const reason = result.reason || 'score';
  const opponentName = other && other.name || 'Your opponent';
  const ownProgress = duelProgress(own && own.progress);
  const opponentProgress = duelProgress(other && other.progress);
  const competitiveCopy = competitiveTaunt({
    won,
    opponentName,
    ownScore: ownProgress.score,
    opponentScore: opponentProgress.score,
  });
  let title = draw ? 'Dead Even' : competitiveCopy.title;
  let detail = draw ? 'A perfect deadlock. Neither of you gets bragging rights.' : competitiveCopy.detail;

  if (reason === 'left'){
    title = won ? 'You Win!' : 'Good Duel';
    detail = won ? 'Your opponent forfeited the round.' : 'You forfeited the round.';
  } else if (reason === 'disconnect'){
    title = won ? 'You Win!' : 'Connection Lost';
    detail = won ? 'Your opponent did not reconnect in time.' : 'Your reconnect window expired.';
  } else if (reason === 'cheated'){
    title = won ? 'You Win!' : 'Round Forfeited';
    detail = won ? 'Your opponent was disqualified.' : 'This round was forfeited because cheats were detected.';
  } else if (reason === 'both_disconnected'){
    title = 'Round Abandoned';
    detail = 'Neither player reconnected in time.';
  } else if (reason === 'draw'){
    detail = 'Score, floors, perfects, and best combo all matched. Settle it with a rematch.';
  }

  return {
    title,
    detail,
    tone: draw ? 'draw' : won ? 'win' : 'loss',
    ownName: own && own.name || 'You',
    opponentName,
    ownProgress,
    opponentProgress,
    ownRematch: !!(own && own.rematch),
    opponentRematch: !!(other && other.rematch),
  };
}

export function countdownValue(startAt, serverOffset = 0, now = Date.now()){
  const remaining = startAt - (now + serverOffset);
  if (remaining <= 0) return 'GO!';
  return String(Math.max(1, Math.ceil(remaining / 1000)));
}

export function estimateServerOffset(serverTime, sentAt, receivedAt){
  if (![serverTime, sentAt, receivedAt].every(Number.isFinite) || receivedAt < sentAt) return 0;
  return serverTime - ((sentAt + receivedAt) / 2);
}
