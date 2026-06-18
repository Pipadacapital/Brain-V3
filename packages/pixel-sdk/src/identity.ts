/**
 * pixel-sdk/identity — client-side anonymous id + 30-min rolling session.
 *
 * ADR-2 / REC-4: the anon-id is minted CLIENT-SIDE in localStorage — NO Set-Cookie on
 * /collect (the edge stays stateless). brain_anon_id is a random uuid, NOT a PII identifier.
 */
import type { BrowserEnv } from './types.js';

const ANON_KEY = '__brain_anon_id';
const SESSION_KEY = '__brain_session';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes rolling

interface StoredSession {
  id: string;
  last: number; // last-activity epoch ms
}

/** Get-or-mint a durable client anonymous id (uuid). */
export function getOrCreateAnonId(env: BrowserEnv): string {
  const existing = env.storage.getItem(ANON_KEY);
  if (existing) return existing;
  const id = env.uuid();
  env.storage.setItem(ANON_KEY, id);
  return id;
}

/**
 * Get-or-roll the session id. A session expires after 30 min of inactivity; any activity
 * extends it. Returns a fresh session id when expired/absent.
 */
export function getOrRollSession(env: BrowserEnv): string {
  const now = env.now();
  const raw = env.storage.getItem(SESSION_KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw) as StoredSession;
      if (s.id && typeof s.last === 'number' && now - s.last < SESSION_TTL_MS) {
        const updated: StoredSession = { id: s.id, last: now };
        env.storage.setItem(SESSION_KEY, JSON.stringify(updated));
        return s.id;
      }
    } catch {
      // fall through to mint a fresh session
    }
  }
  const id = env.uuid();
  env.storage.setItem(SESSION_KEY, JSON.stringify({ id, last: now } satisfies StoredSession));
  return id;
}
