// Difficulty profiles. Each profile scales the gameplay tunables that game.js
// and renderer.js read through `Difficulty.get()`. "normal" reproduces the
// original balance; "hardcore" is faster, thinner, tighter, higher-scoring, and
// adds deterministic trickery (invisible floors + swing "gusts") so a Daily run
// stays identical for everyone that day. The cheat menu works in every mode.

export const DIFFICULTIES = {
  normal: {
    id: 'normal',
    label: 'Normal',
    baseWidthRatio: 0.62,   // starting block width / viewport width
    speedStep: 0.014,       // swing-speed growth per floor
    maxSpeedMult: 2.8,
    perfectPx: 8,           // alignment slop that still counts as Perfect
    perfectRegenPx: 7,      // width regained on a Perfect
    scoreMult: 1,           // difficulty score reward
    guides: true,           // faint drop-alignment guides
    invisibleEvery: 0,      // 0 = the swinging block is always visible
    gust: 0,                // swing-speed jitter amplitude (0 = steady)
  },
  hardcore: {
    id: 'hardcore',
    label: 'Hardcore',
    baseWidthRatio: 0.46,   // noticeably thinner tower
    speedStep: 0.024,       // ramps faster…
    maxSpeedMult: 3.8,      // …to a higher ceiling
    perfectPx: 5,           // tighter Perfect window
    perfectRegenPx: 4,      // regrows less on a Perfect
    scoreMult: 2,           // double points for the extra risk
    guides: false,          // no alignment guides
    invisibleEvery: 4,      // every 4th swinging block flickers near-invisible
    gust: 0.35,             // per-floor swing-speed variance (deterministic via seed)
  },
};

export const Difficulty = {
  current: DIFFICULTIES.normal,
  set(id){ this.current = DIFFICULTIES[id] || DIFFICULTIES.normal; return this.current; },
  get(){ return this.current; },
  isHardcore(){ return this.current.id === 'hardcore'; },
};
