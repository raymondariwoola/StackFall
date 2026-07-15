// Reads game + background + effects state and paints a frame. No game logic
// lives here — it only knows how to draw what it's given.

import { CONFIG, topScreenY, movingY, blockH } from './config.js';
import { colorForFloor } from './palettes.js';
import { Difficulty } from './difficulty.js';

function roundRectPath(ctx, x, y, w, h, r){
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function roundRect(ctx, x, y, w, h, r, color){
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
}

export class Renderer {
  constructor(ctx){ this.ctx = ctx; }

  draw(game, background, effects, view){
    const ctx = this.ctx;
    const { W, H } = view;
    ctx.clearRect(0, 0, W, H);
    background.draw(ctx, W, H);

    const off = effects.shakeOffset();
    ctx.save();
    ctx.translate(off.x, off.y);

    const bh = blockH(H);
    const my = movingY(H);
    const ty = topScreenY(H);
    const gap = CONFIG.GAP, r = CONFIG.RADIUS;

    // Faint alignment guides from the top block's edges up to the swinger.
    // Hardcore hides them to make alignment read-by-eye only.
    if (game.running && game.moving && game.stack.length && Difficulty.get().guides){
      const top = game.stack[game.stack.length - 1];
      ctx.strokeStyle = 'rgba(245,243,236,0.10)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(top.x, my); ctx.lineTo(top.x, ty);
      ctx.moveTo(top.x + top.w, my); ctx.lineTo(top.x + top.w, ty);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Stack, top-down, stopping once we scroll off the bottom edge.
    for (let i = game.stack.length - 1; i >= 0; i--){
      const dist = (game.stack.length - 1) - i;
      let y = ty + dist * bh;
      if (y > H) break;
      const l = game.stack[i];
      let x = l.x, w = l.w, h = bh - gap;

      // Squash-and-settle on the freshly landed top block.
      if (dist === 0 && game.settle > 0){
        const s = game.settle;
        const sx = 1 + 0.10 * s, sy = 1 - 0.14 * s;
        const cx = x + w / 2;
        w *= sx; x = cx - w / 2;
        const nh = h * sy; y += (h - nh); h = nh;
      }

      roundRect(ctx, x, y, w, h, r, colorForFloor(l.floor));
      // Subtle top sheen for a bit of dimensionality.
      ctx.globalAlpha = 0.14;
      ctx.fillStyle = '#ffffff';
      roundRectPath(ctx, x, y, w, Math.min(6, h), r);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Spike hazard zone on the top block (hardcore): coral overlay + teeth.
    if (game.running && game.hazard && game.stack.length){
      const top = game.stack[game.stack.length - 1];
      const hz = game.hazard;
      const hx = hz.side === 'left' ? top.x : top.x + top.w - hz.w;
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = '#FF4757';
      ctx.fillRect(hx, ty, hz.w, bh - gap);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#FF6B6B';
      const teeth = Math.max(2, Math.floor(hz.w / 10));
      const tw = hz.w / teeth;
      ctx.beginPath();
      for (let i = 0; i < teeth; i++){
        const x0 = hx + i * tw;
        ctx.moveTo(x0, ty);
        ctx.lineTo(x0 + tw / 2, ty - 7);
        ctx.lineTo(x0 + tw, ty);
      }
      ctx.fill();
    }

    // Debris, particles, rings, and floating text live in world space.
    effects.drawWorld(ctx);

    // The swinging block, with a glow in its own color. On hardcore "invisible"
    // floors it flickers: a faint ghost most of the time with brief full blinks,
    // so it stays technically readable but demands timing and memory.
    if (game.running && game.moving){
      const c = colorForFloor(game.moving.floor);
      let alpha = 1, glow = 24;
      if (game.moving.invisible){
        const blink = Math.floor(game.t * 2.5) % 5 === 0;
        alpha = blink ? 0.9 : 0.06;
        glow = blink ? 24 : 0;
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = c;
      ctx.shadowBlur = glow;
      roundRect(ctx, game.moving.x, my, game.moving.w, bh - gap, r, c);
      ctx.restore();
    }

    // Hardcore shot clock: a shrinking bar above the swing lane. Drawn at a
    // fixed center position (not under the block) so it never gives away the
    // location of an "invisible" floor.
    if (game.running && game.moving && game.dropTimeLimit > 0){
      const frac = Math.max(0, game.dropTimeLeft / game.dropTimeLimit);
      const urgent = game.dropTimeLeft < 1.2;
      const bw = 120 * frac;
      ctx.globalAlpha = urgent ? 0.5 + 0.5 * Math.abs(Math.sin(game.t * 10)) : 0.8;
      ctx.fillStyle = urgent ? '#FF4757' : (frac < 0.5 ? '#E8A33D' : '#5EE6D6');
      ctx.fillRect(W / 2 - bw / 2, my - 14, bw, 3);
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // Hardcore lights-out: dim the playfield to near-black. Sighted players get
    // brief soft glimpses (~1.3 Hz with gradual ramps — well under strobe/
    // photosensitivity thresholds); reduced-motion players get a steady,
    // flicker-free dim instead.
    if (game.blackout > 0){
      const dur = game.blackoutDur || 1;
      const ramp = Math.min(1, Math.min((dur - game.blackout) / 0.25, game.blackout / 0.4));
      let a = 0.82;
      if (effects.reduceMotion){
        a = 0.72;
      } else {
        const ph = (game.t * 1.3) % 1;
        if (ph < 0.14) a = 0.4 + 2.6 * ph;   // soft glimpse window
      }
      ctx.fillStyle = `rgba(6,9,20,${(a * ramp).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Full-screen flash sits above the shake transform.
    effects.drawOverlay(ctx, W, H);

    this._ruler(view, game, bh);
  }

  _ruler(view, game, bh){
    const ctx = this.ctx;
    const { W, H } = view;
    const x = W - 26;
    ctx.strokeStyle = 'rgba(245,243,236,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();

    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'left';
    const ty = topScreenY(H);
    for (let i = game.stack.length - 1; i >= 0; i--){
      const dist = (game.stack.length - 1) - i;
      const y = ty + dist * bh;
      if (y > H) break;
      const floor = game.stack[i].floor;
      if (floor % 5 === 0){
        ctx.strokeStyle = 'rgba(245,243,236,0.3)';
        ctx.beginPath(); ctx.moveTo(x - 6, y); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = 'rgba(245,243,236,0.45)';
        ctx.fillText(String(floor), x + 4, y + 3);
      } else {
        ctx.strokeStyle = 'rgba(245,243,236,0.16)';
        ctx.beginPath(); ctx.moveTo(x - 3, y); ctx.lineTo(x, y); ctx.stroke();
      }
    }
  }
}
