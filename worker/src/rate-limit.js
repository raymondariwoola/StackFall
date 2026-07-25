// Shared best-effort fixed-window rate limiting for public Worker routes.
// KV is eventually consistent, so this is intentionally an abuse-speed bump
// rather than an authentication or correctness boundary.

import { safeMetricEvent } from './safe-log.js';

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
}

export async function rateLimit(env, bucket, ip, limit, windowSec) {
  if (!ip || !env.LEADERBOARD) return { ok: true, limit, remaining: limit };
  const nowSec = Math.floor(Date.now() / 1000);
  const win = Math.floor(nowSec / windowSec);
  const key = `rl:${bucket}:${ip}:${win}`;
  let count = 0;
  try { count = parseInt(await env.LEADERBOARD.get(key) || '0', 10) || 0; } catch (e) { /* fail open */ }
  if (count >= limit) {
    const retryAfter = windowSec - (nowSec % windowSec);
    console.warn('stackfall_metric', safeMetricEvent('rate_limited', { bucket, limit, retryAfter }));
    return { ok: false, limit, remaining: 0, retryAfter };
  }
  try {
    await env.LEADERBOARD.put(key, String(count + 1), { expirationTtl: Math.max(60, windowSec * 2) });
  } catch (e) { /* fail open */ }
  return { ok: true, limit, remaining: Math.max(0, limit - count - 1) };
}

export function intEnv(v, fallback) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
