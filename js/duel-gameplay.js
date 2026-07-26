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

export function resultModel(room, seat){
  const result = room && room.result || {};
  const winner = result.winner;
  const own = room && room.seats && room.seats[seat];
  const otherId = opponentSeat(seat);
  const other = room && room.seats && room.seats[otherId];
  const won = winner === seat;
  const draw = winner == null;
  const reason = result.reason || 'score';
  let title = draw ? 'Draw Game' : won ? 'You Win!' : 'Good Duel';
  let detail = draw
    ? 'You built matching towers.'
    : won
      ? `You edged out ${other && other.name || 'your opponent'}.`
      : `${other && other.name || 'Your opponent'} takes this round.`;

  if (reason === 'left') detail = won ? 'Your opponent forfeited the round.' : 'You forfeited the round.';
  else if (reason === 'disconnect') detail = won ? 'Your opponent did not reconnect in time.' : 'Your reconnect window expired.';
  else if (reason === 'cheated') detail = won ? 'Your opponent was disqualified.' : 'This round was forfeited because cheats were detected.';
  else if (reason === 'both_disconnected') detail = 'Neither player reconnected in time.';
  else if (reason === 'draw') detail = 'Score, floors, perfects, and best combo all matched.';

  return {
    title,
    detail,
    tone: draw ? 'draw' : won ? 'win' : 'loss',
    ownName: own && own.name || 'You',
    opponentName: other && other.name || 'Opponent',
    ownProgress: duelProgress(own && own.progress),
    opponentProgress: duelProgress(other && other.progress),
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
