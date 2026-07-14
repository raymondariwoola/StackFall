// Seedable RNG so the "daily board" is identical for everyone that day.
// (Cloudflare Worker can later hand down the same seed; the math matches.)

export function hashString(str){
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function dailySeedString(d = new Date()){
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}
export function dailySeed(d = new Date()){
  return hashString(dailySeedString(d));
}

export class RNG {
  constructor(seed){ this.reseed(seed); }
  reseed(seed){ this.seed = seed >>> 0; this._next = mulberry32(this.seed); }
  next(){ return this._next(); }
  range(min, max){ return min + (max - min) * this.next(); }
  bool(){ return this.next() < 0.5; }
}
