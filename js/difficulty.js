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
    dropTimeSec: 0,         // per-drop shot clock in seconds (0 = no limit)
    hazardChance: 0,        // chance per floor of a spike hazard on the top block
    quakeChance: 0,         // chance a landing sets off a violent screen quake
    blackoutChance: 0,      // chance per floor of a lights-out blackout
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
    dropTimeSec: 5,         // shot clock: expiry force-drops the block where it swings
    hazardChance: 0.22,     // spikes on an edge of the top block (from floor 3)
    quakeChance: 0.18,      // surprise screen quake on landing
    blackoutChance: 0.12,   // 2.5s lights-out with brief glimpses (from floor 5)
  },
};

export const Difficulty = {
  current: DIFFICULTIES.normal,
  set(id){ this.current = DIFFICULTIES[id] || DIFFICULTIES.normal; return this.current; },
  get(){ return this.current; },
  isHardcore(){ return this.current.id === 'hardcore'; },
};
