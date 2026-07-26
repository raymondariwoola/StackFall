// Renders a shareable result card entirely on a <canvas> — no paid image
// service. Returns a PNG Blob the caller can hand to the Web Share API (as a
// file) or offer as a download. Fully self-contained and brand-styled.

const BRAND = {
  bgTop: '#12172B', bgBot: '#1b2140',
  ink: '#F5F3EC', dim: '#8A90AC',
  amber: '#E8A33D', cyan: '#5EE6D6', coral: '#FF6B6B',
};

function roundRect(ctx, x, y, w, h, r){
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function chip(ctx, x, y, label, color){
  ctx.font = '600 30px "IBM Plex Mono", monospace';
  const padX = 26, h = 60;
  const w = ctx.measureText(label).width + padX * 2;
  roundRect(ctx, x, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(245,243,236,0.06)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + padX, y + h / 2 + 1);
  return w;
}

function fitFont(ctx, text, maxWidth, maxSize, minSize, weight = 700, family = '"Space Grotesk", sans-serif'){
  let size = maxSize;
  while (size > minSize){
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 2;
  }
  return size;
}

function ellipsize(ctx, text, maxWidth){
  const value = String(text || 'Player');
  if (ctx.measureText(value).width <= maxWidth) return value;
  let shortened = value;
  while (shortened.length && ctx.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

function wrappedLines(ctx, text, maxWidth, maxLines = 3){
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words){
    const next = line ? `${line} ${word}` : word;
    if (!line || ctx.measureText(next).width <= maxWidth){
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === maxLines - 1) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  const consumed = lines.join(' ').split(/\s+/).filter(Boolean).length;
  if (consumed < words.length && lines.length){
    lines[lines.length - 1] = ellipsize(ctx, lines[lines.length - 1], maxWidth - 20);
  }
  return lines;
}

function duelScorePanel(ctx, { x, y, w, h, name, score, floors, color }){
  roundRect(ctx, x, y, w, h, 26);
  ctx.fillStyle = 'rgba(245,243,236,0.055)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(245,243,236,0.15)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = BRAND.dim;
  ctx.font = '500 28px "IBM Plex Mono", monospace';
  ctx.fillText(ellipsize(ctx, name, w - 52), x + w / 2, y + 49);

  fitFont(ctx, String(score), w - 48, 86, 54);
  ctx.fillStyle = color;
  ctx.fillText(String(score), x + w / 2, y + 142);

  ctx.fillStyle = BRAND.dim;
  ctx.font = '500 26px "IBM Plex Mono", monospace';
  ctx.fillText(`${floors} floors`, x + w / 2, y + h - 33);
}

// run: { score, floors, mode, difficulty, name, streak, date }
export async function buildShareCard(run){
  const S = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d');

  // Background gradient + soft top glow.
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, BRAND.bgTop);
  g.addColorStop(1, BRAND.bgBot);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const rg = ctx.createRadialGradient(S * 0.5, S * 0.28, 0, S * 0.5, S * 0.28, S * 0.7);
  rg.addColorStop(0, 'rgba(232,163,61,0.18)');
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, S, S);

  // Rounded inner border for a "card" feel.
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(245,243,236,0.14)';
  roundRect(ctx, 48, 48, S - 96, S - 96, 40);
  ctx.stroke();

  // A little stacked-blocks motif, top-center.
  const blocks = [
    { w: 300, c: BRAND.amber }, { w: 340, c: BRAND.cyan }, { w: 260, c: BRAND.coral },
  ];
  let by = 150;
  for (const b of blocks){
    roundRect(ctx, S / 2 - b.w / 2, by, b.w, 44, 8);
    ctx.fillStyle = b.c; ctx.fill();
    by += 54;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Eyebrow.
  ctx.fillStyle = BRAND.amber;
  ctx.font = '700 30px "IBM Plex Mono", monospace';
  ctx.fillText('S T A C K F A L L', S / 2, 400);

  // Big score.
  ctx.fillStyle = BRAND.ink;
  ctx.font = '700 240px "Space Grotesk", sans-serif';
  ctx.fillText(String(run.score | 0), S / 2, 640);
  ctx.fillStyle = BRAND.dim;
  ctx.font = '500 44px "Space Grotesk", sans-serif';
  ctx.fillText('POINTS', S / 2, 700);

  // Floors + streak line.
  ctx.fillStyle = BRAND.ink;
  ctx.font = '500 40px "IBM Plex Mono", monospace';
  const streak = run.streak ? `  ·  best streak ×${run.streak}` : '';
  ctx.fillText(`${run.floors | 0} floors${streak}`, S / 2, 770);

  // Mode + difficulty chips, centered as a row.
  const modeLabel = run.mode === 'daily' ? 'DAILY' : run.mode === 'practice' ? 'PRACTICE' : 'ENDLESS';
  const diffLabel = run.difficulty === 'hardcore' ? 'HARDCORE' : 'NORMAL';
  ctx.font = '600 30px "IBM Plex Mono", monospace';
  const gap = 20;
  const w1 = ctx.measureText(modeLabel).width + 52;
  const w2 = ctx.measureText(diffLabel).width + 52;
  const totalW = w1 + gap + w2;
  let cx = S / 2 - totalW / 2;
  const chipY = 830;
  cx += chip(ctx, cx, chipY, modeLabel, run.mode === 'daily' ? BRAND.cyan : BRAND.amber) + gap;
  chip(ctx, cx, chipY, diffLabel, run.difficulty === 'hardcore' ? BRAND.coral : BRAND.dim);

  // Player name + date footer.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = BRAND.ink;
  ctx.font = '600 40px "IBM Plex Mono", monospace';
  ctx.fillText(run.name || 'anon', S / 2, 960);
  ctx.fillStyle = BRAND.dim;
  ctx.font = '400 28px "IBM Plex Mono", monospace';
  ctx.fillText(run.date || '', S / 2, 1005);

  return await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
}

// result: { title, detail, tone, ownName, opponentName, ownProgress,
// opponentProgress, difficulty, round, kind }
export async function buildDuelShareCard(result){
  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const tone = result.tone === 'loss' ? 'loss' : result.tone === 'draw' ? 'draw' : 'win';
  const accent = tone === 'win' ? BRAND.cyan : tone === 'loss' ? BRAND.coral : BRAND.amber;
  const own = result.ownProgress || {};
  const opponent = result.opponentProgress || {};
  const ownScore = Math.max(0, Math.trunc(own.score || 0));
  const opponentScore = Math.max(0, Math.trunc(opponent.score || 0));
  const ownFloors = Math.max(0, Math.trunc(own.floors || 0));
  const opponentFloors = Math.max(0, Math.trunc(opponent.floors || 0));

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0B1120');
  bg.addColorStop(.52, BRAND.bgTop);
  bg.addColorStop(1, '#171D38');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W / 2, 330, 0, W / 2, 330, 620);
  glow.addColorStop(0, `${accent}2E`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  roundRect(ctx, 55, 55, W - 110, H - 110, 42);
  ctx.fillStyle = 'rgba(27,33,64,.78)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = `${accent}66`;
  ctx.stroke();

  // Mini tower motif.
  const blocks = [300, 250, 200];
  blocks.forEach((width, index) => {
    roundRect(ctx, W / 2 - width / 2 + index * 8, 120 + index * 38, width, 28, 7);
    ctx.fillStyle = index === 0 ? BRAND.amber : index === 1 ? BRAND.cyan : BRAND.coral;
    ctx.fill();
  });

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = BRAND.amber;
  ctx.font = '700 27px "IBM Plex Mono", monospace';
  ctx.fillText(result.kind === 'beat' ? 'B E A T   M Y   T O W E R' : 'T W O - P L A Y E R   D U E L', W / 2, 280);

  const title = String(result.title || 'Duel Complete');
  fitFont(ctx, title, 850, 88, 54);
  const titleLines = wrappedLines(ctx, title, 850, 2);
  ctx.fillStyle = BRAND.ink;
  titleLines.forEach((line, index) => ctx.fillText(line, W / 2, 385 + index * 88));

  const markY = titleLines.length > 1 ? 535 : 455;
  ctx.beginPath();
  ctx.arc(W / 2, markY, 47, 0, Math.PI * 2);
  ctx.fillStyle = `${accent}16`;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = accent;
  ctx.stroke();
  ctx.fillStyle = accent;
  ctx.font = '700 52px "Space Grotesk", sans-serif';
  ctx.fillText(tone === 'win' ? '★' : tone === 'loss' ? '×' : '=', W / 2, markY + 18);

  ctx.fillStyle = BRAND.dim;
  ctx.font = '500 29px "IBM Plex Mono", monospace';
  const detailLines = wrappedLines(ctx, result.detail, 830, 3);
  const detailStart = markY + 92;
  detailLines.forEach((line, index) => ctx.fillText(line, W / 2, detailStart + index * 42));

  const panelsY = Math.max(700, detailStart + detailLines.length * 42 + 40);
  duelScorePanel(ctx, {
    x: 105, y: panelsY, w: 390, h: 230,
    name: result.ownName || 'You', score: ownScore, floors: ownFloors,
    color: tone === 'loss' ? BRAND.ink : accent,
  });
  ctx.fillStyle = BRAND.amber;
  ctx.font = '700 28px "Space Grotesk", sans-serif';
  ctx.fillText('VS', W / 2, panelsY + 124);
  duelScorePanel(ctx, {
    x: 585, y: panelsY, w: 390, h: 230,
    name: result.opponentName || 'Opponent', score: opponentScore, floors: opponentFloors,
    color: tone === 'loss' ? accent : BRAND.ink,
  });

  const diff = result.difficulty === 'hardcore' ? 'HARDCORE' : 'NORMAL';
  const round = result.kind === 'beat' ? 'ASYNC CHALLENGE' : `ROUND ${Math.max(1, Math.trunc(result.round || 1))}`;
  ctx.font = '600 27px "IBM Plex Mono", monospace';
  const gap = 22;
  const w1 = ctx.measureText(diff).width + 52;
  const w2 = ctx.measureText(round).width + 52;
  let chipX = W / 2 - (w1 + gap + w2) / 2;
  chipX += chip(ctx, chipX, panelsY + 285, diff, result.difficulty === 'hardcore' ? BRAND.coral : BRAND.dim) + gap;
  chip(ctx, chipX, panelsY + 285, round, BRAND.amber);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = BRAND.ink;
  ctx.font = '700 38px "Space Grotesk", sans-serif';
  ctx.fillText('STACKFALL', W / 2, 1190);
  ctx.fillStyle = BRAND.dim;
  ctx.font = '400 25px "IBM Plex Mono", monospace';
  ctx.fillText('Build higher. Talk louder. Run it back.', W / 2, 1237);
  ctx.fillText('raymondariwoola.github.io/StackFall', W / 2, 1282);

  return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}
