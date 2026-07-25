// Owns the settings selected for the next run and the immutable snapshot used
// by the active run. Keeping these separate prevents title-screen changes from
// relabelling or resubmitting a run that has already started.

export const RUN_MODES = Object.freeze({
  ENDLESS: 'endless',
  DAILY: 'daily',
  PRACTICE: 'practice',
  DUEL: 'duel',
  BEAT: 'beat',
});

export const RUN_DIFFICULTIES = Object.freeze({
  NORMAL: 'normal',
  HARDCORE: 'hardcore',
});

const SELECTABLE_MODES = Object.freeze([
  RUN_MODES.ENDLESS,
  RUN_MODES.DAILY,
  RUN_MODES.PRACTICE,
]);

function normalizeMode(mode){
  return Object.values(RUN_MODES).includes(mode) ? mode : RUN_MODES.ENDLESS;
}

function normalizeDifficulty(difficulty){
  return difficulty === RUN_DIFFICULTIES.HARDCORE
    ? RUN_DIFFICULTIES.HARDCORE
    : RUN_DIFFICULTIES.NORMAL;
}

function freezeDuel(duel){
  if (!duel || typeof duel !== 'object') return null;
  return Object.freeze({ ...duel });
}

export class RunContext {
  constructor({ mode = RUN_MODES.ENDLESS, difficulty = RUN_DIFFICULTIES.NORMAL } = {}){
    this._selection = Object.freeze({
      mode: SELECTABLE_MODES.includes(mode) ? mode : RUN_MODES.ENDLESS,
      difficulty: normalizeDifficulty(difficulty),
    });
    this._active = null;
  }

  get selection(){ return this._selection; }
  get active(){ return this._active; }

  setMode(mode){
    const next = SELECTABLE_MODES.includes(mode) ? mode : RUN_MODES.ENDLESS;
    this._selection = Object.freeze({ ...this._selection, mode: next });
    return this._selection;
  }

  cycleMode(){
    const i = SELECTABLE_MODES.indexOf(this._selection.mode);
    return this.setMode(SELECTABLE_MODES[(i + 1) % SELECTABLE_MODES.length]);
  }

  setDifficulty(difficulty){
    this._selection = Object.freeze({
      ...this._selection,
      difficulty: normalizeDifficulty(difficulty),
    });
    return this._selection;
  }

  // Duel passes explicit mode/difficulty metadata; normal starts capture the
  // current title-screen selection. The returned object is safe to retain in
  // async callbacks because neither it nor its duel metadata can be mutated.
  begin(seed, overrides = {}){
    const mode = normalizeMode(overrides.mode == null ? this._selection.mode : overrides.mode);
    const difficulty = normalizeDifficulty(
      overrides.difficulty == null ? this._selection.difficulty : overrides.difficulty,
    );
    const normalizedSeed = Number(seed) >>> 0;
    this._active = Object.freeze({
      mode,
      difficulty,
      seed: normalizedSeed || 1,
      duel: mode === RUN_MODES.DUEL || mode === RUN_MODES.BEAT ? freezeDuel(overrides.duel) : null,
    });
    return this._active;
  }

  complete(){
    const completed = this._active;
    this._active = null;
    return completed;
  }
}
