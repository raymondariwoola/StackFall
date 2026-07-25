import { DUEL_PROTOCOL_VERSION } from '../../shared/duel-protocol.js';
import { comparePlayers, validateProgress } from './match-room.js';

export const CHALLENGE_STORAGE_KEY = 'challenge';
export const CHALLENGE_DRAFT_MS = 2 * 60 * 60 * 1000;
export const CHALLENGE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function nowFor(env){
  const value = Number(env && env.__TEST_NOW);
  return Number.isFinite(value) ? value : Date.now();
}

function emptyProgress(){
  return { score: 0, floors: 0, perfects: 0, maxCombo: 0, combo: 0, widthRatio: 1 };
}

function seat(id, name, tokenHash){
  return { id, name, tokenHash, progress: emptyProgress(), finished: false, finishedAt: null };
}

function randomSeed(){
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] || 1;
}

export function createBeatChallenge({ code, hostName, hostTokenHash, difficulty, now }){
  return {
    v: DUEL_PROTOCOL_VERSION,
    kind: 'beat',
    code,
    state: 'host_playing',
    difficulty,
    seed: randomSeed(),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + CHALLENGE_DRAFT_MS,
    seats: { host: seat('host', hostName, hostTokenHash), guest: null },
    result: null,
  };
}

function publicSeat(value){
  return value ? {
    id: value.id,
    name: value.name,
    progress: { ...value.progress },
    finished: value.finished,
  } : null;
}

export function publicBeatChallenge(challenge, you = null){
  return {
    v: challenge.v,
    kind: challenge.kind,
    code: challenge.code,
    state: challenge.state,
    difficulty: challenge.difficulty,
    seed: challenge.seed,
    createdAt: challenge.createdAt,
    updatedAt: challenge.updatedAt,
    expiresAt: challenge.expiresAt,
    you,
    seats: {
      host: publicSeat(challenge.seats.host),
      guest: publicSeat(challenge.seats.guest),
    },
    result: challenge.result ? { ...challenge.result } : null,
  };
}

function json(body, status = 200){ return Response.json(body, { status }); }

export class ChallengeRoom {
  constructor(state, env){ this.state = state; this.env = env; }

  async fetch(request){
    const url = new URL(request.url);
    const now = nowFor(this.env);
    if (url.pathname === '/init' && request.method === 'POST'){
      const existing = await this.state.storage.get(CHALLENGE_STORAGE_KEY);
      if (existing && now < existing.expiresAt) return json({ ok: false, error: 'code_conflict' }, 409);
      if (existing) await this._deleteAll();
      const challenge = createBeatChallenge({ ...(await request.json()), now });
      await this._save(challenge);
      return json({ ok: true, challenge: publicBeatChallenge(challenge, 'host') }, 201);
    }

    const challenge = await this.state.storage.get(CHALLENGE_STORAGE_KEY);
    if (!challenge || now >= challenge.expiresAt){
      if (challenge) await this._deleteAll();
      return json({ ok: false, error: 'challenge_not_found' }, 404);
    }

    if (url.pathname === '/state' && request.method === 'GET'){
      return json({ ok: true, challenge: publicBeatChallenge(challenge) });
    }

    if (url.pathname === '/join' && request.method === 'POST'){
      if (challenge.state === 'host_playing') return json({ ok: false, error: 'challenge_not_ready' }, 409);
      if (challenge.state !== 'open' || challenge.seats.guest) {
        return json({ ok: false, error: 'challenge_claimed' }, 409);
      }
      const body = await request.json();
      challenge.seats.guest = seat('guest', body.guestName, body.guestTokenHash);
      challenge.state = 'guest_playing';
      challenge.updatedAt = now;
      await this._save(challenge);
      return json({ ok: true, challenge: publicBeatChallenge(challenge, 'guest') });
    }

    if (url.pathname === '/finish' && request.method === 'POST'){
      const body = await request.json();
      const tokenHash = body.tokenHash || '';
      const currentSeat = challenge.seats.host.tokenHash === tokenHash
        ? challenge.seats.host
        : challenge.seats.guest && challenge.seats.guest.tokenHash === tokenHash
          ? challenge.seats.guest
          : null;
      if (!currentSeat) return json({ ok: false, error: 'unauthorized' }, 401);
      const expected = currentSeat.id === 'host' ? 'host_playing' : 'guest_playing';
      if (challenge.state !== expected || currentSeat.finished){
        return json({ ok: false, error: 'challenge_already_played' }, 409);
      }
      const validated = validateProgress(body.progress, emptyProgress(), { finish: true });
      if (!validated.ok) return json({ ok: false, error: validated.error }, 400);
      if (validated.cheated) return json({ ok: false, error: 'cheated_challenge' }, 400);
      currentSeat.progress = validated.value;
      currentSeat.finished = true;
      currentSeat.finishedAt = now;
      challenge.updatedAt = now;
      if (currentSeat.id === 'host'){
        challenge.state = 'open';
        challenge.expiresAt = now + CHALLENGE_DURATION_MS;
      }
      else {
        challenge.state = 'finished';
        challenge.result = { ...comparePlayers(challenge.seats.host, challenge.seats.guest), finishedAt: now };
      }
      await this._save(challenge);
      return json({ ok: true, challenge: publicBeatChallenge(challenge, currentSeat.id) });
    }

    if (url.pathname === '/cancel' && request.method === 'POST'){
      const body = await request.json();
      if (challenge.seats.host.tokenHash !== body.tokenHash) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      if (challenge.state === 'finished') return json({ ok: false, error: 'challenge_complete' }, 409);
      await this._deleteAll();
      return json({ ok: true, cancelled: true });
    }

    return json({ ok: false, error: 'not_found' }, 404);
  }

  async alarm(){ await this._deleteAll(); }

  async _save(challenge){
    await this.state.storage.put(CHALLENGE_STORAGE_KEY, challenge);
    await this.state.storage.setAlarm(challenge.expiresAt);
  }

  async _deleteAll(){
    await this.state.storage.deleteAlarm();
    await this.state.storage.deleteAll();
  }
}
