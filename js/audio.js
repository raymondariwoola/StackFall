// Procedural sound via Web Audio — no asset files, tiny footprint.
// The signature touch: perfect landings play a pitch that climbs with the
// combo, the classic "keep the streak going" hook from the genre.

export class AudioEngine {
  constructor(){
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this._noise = null;
  }

  // Must be called from a user gesture on mobile.
  init(){
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    this._noise = this._makeNoise();
  }
  resume(){
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  setMuted(m){
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  _makeNoise(){
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * 0.4);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  _tone(freq, dur, { type = 'sine', vol = 0.3, glideTo = null, delay = 0 } = {}){
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx, t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  _thud(vol = 0.4){
    if (!this.ctx || this.muted || !this._noise) return;
    const ctx = this.ctx, t0 = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this._noise;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start(t0); src.stop(t0 + 0.2);
  }

  drop(){ this._tone(180, 0.09, { type: 'triangle', vol: 0.16, glideTo: 120 }); }
  cut(){ this._thud(0.32); this._tone(90, 0.12, { type: 'square', vol: 0.10, glideTo: 60 }); }

  perfect(combo){
    // Climb a semitone per combo step (caps so it never gets shrill).
    const semis = Math.min(combo, 20);
    const freq = 330 * Math.pow(2, semis / 12);
    this._tone(freq, 0.14, { type: 'sine', vol: 0.26 });
    this._tone(freq * 1.5, 0.10, { type: 'sine', vol: 0.12, delay: 0.02 });
  }

  milestone(){
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      this._tone(f, 0.16, { type: 'triangle', vol: 0.18, delay: i * 0.07 }));
  }

  gameOver(){
    this._tone(300, 0.5, { type: 'sawtooth', vol: 0.20, glideTo: 80 });
    this._thud(0.4);
  }
}
