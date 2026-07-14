// Curated worlds. Each world defines block colors plus a background
// gradient (top/bot) and a glow accent so the whole scene shifts together.

import { CONFIG } from './config.js';

export const WORLDS = [
  { name: 'Dawn',   blocks: ['#FF6B6B','#FF9457','#FFC24D','#FFE066'], top: '#241B3A', bot: '#3E2A54', glow: '#FF9457' },
  { name: 'Ocean',  blocks: ['#5EE6D6','#5EC6E6','#5E9FE6','#7B6BFF'], top: '#0E2334', bot: '#123F58', glow: '#5EC6E6' },
  { name: 'Forest', blocks: ['#8BC34A','#4CAF50','#2E9E5B','#1D7A63'], top: '#122417', bot: '#183A28', glow: '#4CAF50' },
  { name: 'Dusk',   blocks: ['#E8A33D','#E67B5E','#C65B7C','#8E4585'], top: '#241426', bot: '#3A1E3C', glow: '#C65B7C' },
  { name: 'Neon',   blocks: ['#FF4D9D','#B14DFF','#4D7CFF','#4DE1FF'], top: '#160B2E', bot: '#2A1150', glow: '#B14DFF' },
];

// High-contrast worlds: near-black backgrounds with bright, maximally distinct
// block colors for low-vision players. Used when the High Contrast setting is on.
export const HC_WORLDS = [
  { name: 'Contrast', blocks: ['#FFFFFF','#FFD400','#00E5FF','#FF4081'], top: '#000000', bot: '#0A0A0A', glow: '#FFFFFF' },
  { name: 'Signal',   blocks: ['#FFEB3B','#00E676','#40C4FF','#FF5252'], top: '#050505', bot: '#121212', glow: '#FFEB3B' },
];

let ACTIVE = WORLDS;
// Swap the active world set. Callers should refresh the background afterward
// (main.js re-applies `background.setWorld(worldFor(0))`).
export function setHighContrast(on){ ACTIVE = on ? HC_WORLDS : WORLDS; }

export function worldIndex(floor){
  return Math.floor(floor / CONFIG.WORLD_SIZE) % ACTIVE.length;
}
export function worldFor(floor){
  return ACTIVE[worldIndex(floor)];
}
export function colorForFloor(n){
  const w = worldFor(n);
  return w.blocks[n % w.blocks.length];
}
