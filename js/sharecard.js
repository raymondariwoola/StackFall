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
