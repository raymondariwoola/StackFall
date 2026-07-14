// Remote leaderboard + daily-challenge client. Talks to the Cloudflare
// Worker described in the design when WORKER_URL is set; until then every
// call no-ops so the game runs fully offline. The local top-5 lives in
// Storage — this file is strictly the network seam.

import { dailySeed, dailySeedString } from './rng.js';

// Point this at your deployed Worker, e.g. "https://stackfall-lb.you.workers.dev"
export const WORKER_URL = 'https://stackfall-lb.raymondariwoola.workers.dev';

// Offline/dev only. In production the real cheat passphrase lives in the Worker
// env (CHEAT_CODE) and is verified server-side; this local fallback is used
// only when there is no WORKER_URL. Set to '' to disable offline cheats.
export const LOCAL_CHEAT_CODE = 'iddqd';

// Lightweight, non-secret payload signature. It won't stop a determined
// cheater, but it deters trivial console POSTs. The Worker should re-derive
// and compare (and ultimately enforce sanity limits server-side).
async function signPayload(obj){
  const body = JSON.stringify(obj);
  if (!(window.crypto && window.crypto.subtle)) return { body, sig: '' };
  const data = new TextEncoder().encode(body + '|stackfall');
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  const sig = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return { body, sig };
}

export async function submitScore(name, score, cheated = false){
  if (!WORKER_URL) return { ok: false, offline: true };
  const payload = { name, score, cheated: !!cheated, day: dailySeedString(), ts: Date.now() };
  const { body, sig } = await signPayload(payload);
  const res = await fetch(WORKER_URL + '/score', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Sig': sig },
    body,
  });
  return res.json();
}

export async function fetchLeaderboard(){
  if (!WORKER_URL) return null;
  const res = await fetch(WORKER_URL + '/leaderboard');
  return res.json();
}

// Verify the secret cheat passphrase. Online, the Worker compares it to its
// CHEAT_CODE env var so the phrase never ships in client code; offline it
// falls back to LOCAL_CHEAT_CODE for local development.
export async function verifyCheat(code){
  if (WORKER_URL){
    try {
      const res = await fetch(WORKER_URL + '/cheat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      return !!(data && data.ok);
    } catch (e) { return false; }
  }
  return !!LOCAL_CHEAT_CODE && code === LOCAL_CHEAT_CODE;
}

// Ask the Worker for today's deterministic seed so everyone plays the same
// board. Falls back to a locally computed seed (same formula) when offline.
export async function fetchDailySeed(){
  if (WORKER_URL){
    try {
      const res = await fetch(WORKER_URL + '/daily');
      const data = await res.json();
      if (data && typeof data.seed === 'number') return data.seed >>> 0;
    } catch (e) { /* fall through to local */ }
  }
  return dailySeed();
}
