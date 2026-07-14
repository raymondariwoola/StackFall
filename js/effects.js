// All the juice: particle bursts, falling debris, floating score pops,
// expanding rings, screen flash and camera shake. Pure state + draw;
// the game feeds it events, the renderer asks it to paint.

export class Effects {
  constructor(){
    this.particles = [];
    this.debris = [];
    this.texts = [];
    this.rings = [];
    this.flash = 0;
    this.flashColor = '#ffffff';
    this.shake = 0;
  }

  reset(){
    this.particles.length = 0;
    this.debris.length = 0;
    this.texts.length = 0;
    this.rings.length = 0;
    this.flash = 0;
    this.shake = 0;
  }

  burst(x, y, color, count = 16){
    for (let i = 0; i < count; i++){
      const a = Math.random() * Math.PI * 2;
      const s = 60 + Math.random() * 180;
      this.particles.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s - 40,
        life: 0.5 + Math.random() * 0.4, t: 0,
        color, r: 2 + Math.random() * 2,
      });
    }
  }

  ring(x, y, color){
    this.rings.push({ x, y, r: 6, life: 0.5, t: 0, color });
  }

  addDebris(x, y, w, h, color, vx = 0){
    this.debris.push({
      x, y, w, h, color,
      vx: vx + (Math.random() - 0.5) * 60,
      vy: -40 - Math.random() * 60,
      rot: 0, vrot: (Math.random() - 0.5) * 6,
    });
  }

  popText(x, y, text, color){
    this.texts.push({ x, y, text, color, life: 0.9, t: 0, vy: -60 });
  }

  flashScreen(a = 0.25, color = '#ffffff'){
    this.flash = Math.max(this.flash, a);
    this.flashColor = color;
  }

  shakeIt(t = 0.12){ this.shake = Math.max(this.shake, t); }

  update(dt, H){
    for (const p of this.particles){ p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.t += dt; }
    this.particles = this.particles.filter(p => p.t < p.life);

    for (const d of this.debris){ d.vy += 900 * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.rot += d.vrot * dt; d.vx *= 0.99; }
    this.debris = this.debris.filter(d => d.y < H + 160);

    for (const t of this.texts){ t.y += t.vy * dt; t.vy *= 0.92; t.t += dt; }
    this.texts = this.texts.filter(t => t.t < t.life);

    for (const r of this.rings){ r.t += dt; r.r += 240 * dt; }
    this.rings = this.rings.filter(r => r.t < r.life);

    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 1.6);
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);
  }

  shakeOffset(){
    if (this.shake <= 0) return { x: 0, y: 0 };
    const m = this.shake / 0.12;
    return { x: (Math.random() - 0.5) * 12 * m, y: (Math.random() - 0.5) * 8 * m };
  }

  // Painted inside the shaken world transform.
  drawWorld(ctx){
    for (const d of this.debris){
      ctx.save();
      ctx.translate(d.x + d.w / 2, d.y + d.h / 2);
      ctx.rotate(d.rot);
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = d.color;
      ctx.fillRect(-d.w / 2, -d.h / 2, d.w, d.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    for (const r of this.rings){
      const a = 1 - r.t / r.life;
      ctx.globalAlpha = a * 0.6;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    for (const p of this.particles){
      const a = 1 - p.t / p.life;
      ctx.globalAlpha = a;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;

    ctx.textAlign = 'center';
    for (const t of this.texts){
      const a = 1 - t.t / t.life;
      ctx.globalAlpha = a;
      ctx.fillStyle = t.color;
      ctx.font = '700 22px "Space Grotesk", sans-serif';
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  // Painted in raw screen space (no shake) — full-viewport flash.
  drawOverlay(ctx, W, H){
    if (this.flash > 0){
      ctx.globalAlpha = this.flash;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }
}
