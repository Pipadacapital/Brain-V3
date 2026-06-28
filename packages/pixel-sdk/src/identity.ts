/**
 * pixel-sdk/identity — client-side anonymous id + 30-min rolling session (with lifecycle).
 *
 * ADR-2 / REC-4: the anon-id is minted CLIENT-SIDE in localStorage — NO Set-Cookie on
 * /collect (the edge stays stateless). brain_anon_id is a random uuid, NOT a PII identifier.
 *
 * The session now also carries its START time so the SDK can emit the behavioural lifecycle
 * events session.started (first event of a new 30-min session) and session.ended (the next event
 * after >30-min idle, or pagehide) with an accurate { session_duration_ms }.
 */
import type { BrowserEnv } from './types.js';

const ANON_KEY = '__brain_anon_id';
const SESSION_KEY = '__brain_session';
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes rolling

interface StoredSession {
  id: string;
  last: number; // last-activity epoch ms
  started: number; // session-start epoch ms (for session_duration_ms)
}

/** Get-or-mint a durable client anonymous id (uuid). */
export function getOrCreateAnonId(env: BrowserEnv): string {
  const existing = env.storage.getItem(ANON_KEY);
  if (existing) return existing;
  const id = env.uuid();
  env.storage.setItem(ANON_KEY, id);
  return id;
}

/** Result of rolling the session — carries the lifecycle signals the caller emits as events. */
export interface SessionRoll {
  /** The active session id (a NEW one when isNew). */
  id: string;
  /** True when this call MINTED a fresh session → emit session.started. */
  isNew: boolean;
  /** Present when a PRIOR session expired on this call → emit session.ended for it. */
  ended?: { id: string; durationMs: number };
}

function writeSession(env: BrowserEnv, s: StoredSession): void {
  env.storage.setItem(SESSION_KEY, JSON.stringify(s));
}

/**
 * Roll the session and report lifecycle. A session expires after 30 min of inactivity; any activity
 * within the window extends it (and returns isNew:false). When expired/absent a fresh session is
 * minted (isNew:true); if a prior session existed it is reported as `ended` with its duration so the
 * caller can emit session.ended for the OLD session before session.started for the new one.
 */
export function rollSession(env: BrowserEnv): SessionRoll {
  const now = env.now();
  const raw = env.storage.getItem(SESSION_KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw) as Partial<StoredSession>;
      if (s.id && typeof s.last === 'number') {
        const started = typeof s.started === 'number' ? s.started : s.last;
        if (now - s.last < SESSION_TTL_MS) {
          writeSession(env, { id: s.id, last: now, started });
          return { id: s.id, isNew: false };
        }
        // Expired → end the old session (duration = its last activity − its start), mint a fresh one.
        const ended = { id: s.id, durationMs: Math.max(0, s.last - started) };
        const id = env.uuid();
        writeSession(env, { id, last: now, started: now });
        return { id, isNew: true, ended };
      }
    } catch {
      // fall through to mint a fresh session
    }
  }
  const id = env.uuid();
  writeSession(env, { id, last: now, started: now });
  return { id, isNew: true };
}

/**
 * Get-or-roll the session id (back-compat wrapper — discards the lifecycle signals).
 */
export function getOrRollSession(env: BrowserEnv): string {
  return rollSession(env).id;
}

/**
 * Tear down the active session (pagehide) and report its duration for a session.ended event. Removes
 * the stored session so the next event mints a fresh one (and re-emits session.started). Returns
 * undefined when no session existed (nothing to end).
 */
export function endSessionRecord(env: BrowserEnv): { id: string; durationMs: number } | undefined {
  const raw = env.storage.getItem(SESSION_KEY);
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (s.id && typeof s.last === 'number') {
      const started = typeof s.started === 'number' ? s.started : s.last;
      env.storage.removeItem(SESSION_KEY);
      return { id: s.id, durationMs: Math.max(0, env.now() - started) };
    }
  } catch {
    // no recoverable session
  }
  return undefined;
}
