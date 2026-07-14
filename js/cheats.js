// Shared cheat state. The game reads these flags (only while `active`), the
// cheat menu writes them. Unlock is validated against the Worker passphrase.
//
// Note: even with cheats on, runs are still submitted to the leaderboard —
// that's an intentional product decision, not an oversight.

export const Cheats = {
  unlocked: false,       // passphrase accepted this session
  active: false,         // cheat mode currently ON

  // toggles
  autoPerfect: false,    // every drop snaps to a perfect landing
  easyPerfect: false,    // enormous "perfect" tolerance
  noShrink: false,       // blocks never lose width on a sloppy drop
  invincible: false,     // a total miss won't end the run

  // multipliers / overrides
  timeScale: 1,          // 1 = normal, <1 = slow motion
  scoreMult: 1,          // points multiplier
  speedOverride: null,   // null = normal ramp; number = fixed speed multiplier

  // Turn cheat mode off and clear every effect (keeps `unlocked` for the session).
  reset(){
    this.active = false;
    this.autoPerfect = false;
    this.easyPerfect = false;
    this.noShrink = false;
    this.invincible = false;
    this.timeScale = 1;
    this.scoreMult = 1;
    this.speedOverride = null;
  },

  // Convenience getters that fold in the master `active` switch.
  ts(){ return this.active ? this.timeScale : 1; },
  mult(){ return this.active ? this.scoreMult : 1; },
  on(flag){ return this.active && this[flag]; },

  // True when at least one cheat is actually doing something (drives the badge).
  anyEngaged(){
    return this.autoPerfect || this.easyPerfect || this.noShrink || this.invincible ||
           this.timeScale !== 1 || this.scoreMult !== 1 || this.speedOverride != null;
  },
};
