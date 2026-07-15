// Local achievement milestones. Every test reads ONLY run stats (floors /
// perfect drops) — never the active palette — so the High Contrast setting
// (which swaps in a smaller world set) can't make any of them unreachable.
//
// World milestones are derived from WORLDS + CONFIG.WORLD_SIZE so they stay in
// sync if the world list or cadence changes.

import { CONFIG } from './config.js';
import { WORLDS } from './palettes.js';

const WORLD_ICONS = { Ocean: '🌊', Forest: '🌲', Dusk: '🌆', Neon: '🌌' };

// Reaching each world beyond the starting one (Dawn is where every run begins).
const worldAchievements = WORLDS.slice(1).map((w, i) => {
  const need = (i + 1) * CONFIG.WORLD_SIZE;
  return {
    id: 'world-' + w.name.toLowerCase(),
    icon: WORLD_ICONS[w.name] || '🌍',
    label: w.name,
    desc: `Reach the ${w.name} world (${need} floors)`,
    test: (s) => s.floors >= need,
  };
});

export const ACHIEVEMENTS = [
  { id: 'floors-10', icon: '🏗️', label: 'Skyline',       desc: 'Reach 10 floors',            test: (s) => s.floors >= 10 },
  { id: 'floors-25', icon: '🏙️', label: 'High Rise',     desc: 'Reach 25 floors',            test: (s) => s.floors >= 25 },
  { id: 'floors-50', icon: '🗼', label: 'Megastructure', desc: 'Reach 50 floors',            test: (s) => s.floors >= 50 },
  { id: 'perfect-5', icon: '🎯', label: 'Precision',     desc: '5 perfect drops in one run', test: (s) => s.perfects >= 5 },
  ...worldAchievements,
];

export function achievementById(id){
  return ACHIEVEMENTS.find((a) => a.id === id) || null;
}

// Evaluate every milestone against the current run stats and unlock any newly
// earned ones. `store` is the Storage module; returns the newly unlocked defs
// (usually empty) so the caller can queue toasts.
export function evaluateAchievements(stats, store){
  const earned = [];
  for (const a of ACHIEVEMENTS){
    if (store.hasAchievement(a.id)) continue;
    let ok = false;
    try { ok = !!a.test(stats); } catch (e) { ok = false; }
    if (ok && store.unlockAchievement(a.id)) earned.push(a);
  }
  return earned;
}
