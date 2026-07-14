// Central tunables + layout helpers.
// Everything gameplay-related lives here so balancing is a one-file job.

export const CONFIG = {
  BLOCK_H_RATIO: 0.052,   // block height as fraction of viewport height
  BLOCK_H_MIN: 30,
  MOVING_Y_RATIO: 0.30,   // vertical position of the swinging block
  PERFECT_PX: 8,          // slop allowed to still count as a perfect landing
  BASE_SPEED_RATIO: 0.55, // base horizontal speed as fraction of width / sec
  SPEED_STEP: 0.014,      // speed multiplier growth per floor
  MAX_SPEED_MULT: 2.8,
  BASE_WIDTH_RATIO: 0.62, // starting block width as fraction of width
  MIN_WIDTH: 4,           // tower dies if a floor gets thinner than this
  PERFECT_REGEN_PX: 7,    // width regained on a perfect landing (up to base)
  WORLD_SIZE: 10,         // floors between palette shifts
  DPR_CAP: 2.5,
  GAP: 3,                 // vertical gap between stacked blocks
  RADIUS: 6,              // block corner radius
};

export function blockH(H){ return Math.max(CONFIG.BLOCK_H_MIN, H * CONFIG.BLOCK_H_RATIO); }
export function movingY(H){ return H * CONFIG.MOVING_Y_RATIO; }
export function topScreenY(H){ return movingY(H) + blockH(H); }
export function baseSpeed(W){ return W * CONFIG.BASE_SPEED_RATIO; }
