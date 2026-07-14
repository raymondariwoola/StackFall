// Living backdrop: a vertical gradient that smoothly lerps toward the
// current world's colors, a soft top glow, and slow parallax shapes that
// drift with the "camera" as the tower climbs.

import { WORLDS } from './palettes.js';

function hexToRgb(h){
  h = h.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function mix(a, b, t){ return a + (b - a) * t; }
function rgbStr(c){ return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }

export class Background {
  constructor(){
    this.shapes = [];
    this.cameraY = 0;
    const w0 = WORLDS[0];
    this.top = hexToRgb(w0.top);
    this.bot = hexToRgb(w0.bot);
    this.glow = hexToRgb(w0.glow);
    this.tTop = this.top.slice();
    this.tBot = this.bot.slice();
    this.tGlow = this.glow.slice();
    this.W = 0; this.H = 0;
  }

  init(W, H){
    this.W = W; this.H = H;
    this.shapes.length = 0;
    const n = 18;
    for (let i = 0; i < n; i++){
      this.shapes.push({
        x: Math.random() * W,
        y: Math.random() * H,
        size: 20 + Math.random() * 80,
        depth: 0.2 + Math.random() * 0.8,          // parallax factor
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 0.3,
        kind: Math.random() < 0.5 ? 'diamond' : 'ring',
      });
    }
  }

  setWorld(world){
    this.tTop = hexToRgb(world.top);
    this.tBot = hexToRgb(world.bot);
    this.tGlow = hexToRgb(world.glow);
  }

  update(dt, cameraY, W, H){
    this.W = W; this.H = H;
    this.cameraY += (cameraY - this.cameraY) * Math.min(1, dt * 3);
    const k = Math.min(1, dt * 1.4);
    for (let i = 0; i < 3; i++){
      this.top[i]  = mix(this.top[i],  this.tTop[i],  k);
      this.bot[i]  = mix(this.bot[i],  this.tBot[i],  k);
      this.glow[i] = mix(this.glow[i], this.tGlow[i], k);
    }
    for (const s of this.shapes) s.rot += s.vrot * dt;
  }

  draw(ctx, W, H){
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, rgbStr(this.top));
    g.addColorStop(1, rgbStr(this.bot));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    const rg = ctx.createRadialGradient(W * 0.5, H * 0.22, 0, W * 0.5, H * 0.22, Math.max(W, H) * 0.6);
    rg.addColorStop(0, `rgba(${this.glow[0] | 0},${this.glow[1] | 0},${this.glow[2] | 0},0.16)`);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);

    const span = H + 160;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgbStr(this.glow);
    for (const s of this.shapes){
      const yy = (((s.y + this.cameraY * s.depth * 0.15) % span) + span) % span - 80;
      ctx.save();
      ctx.translate(s.x, yy);
      ctx.rotate(s.rot);
      ctx.globalAlpha = 0.06 + s.depth * 0.05;
      if (s.kind === 'diamond'){
        const r = s.size * s.depth;
        ctx.beginPath();
        ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0);
        ctx.closePath(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.arc(0, 0, s.size * s.depth * 0.6, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}
