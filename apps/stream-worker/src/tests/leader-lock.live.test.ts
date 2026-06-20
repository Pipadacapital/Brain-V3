/**
 * leader-lock.live.test.ts — P1: single-leader gating eliminates N× redundant ticks (live Postgres).
 *
 * Proves the advisory-lock semantics the scheduler relies on: when two "replicas" (separate pooled
 * connections) try the SAME lock key concurrently, exactly ONE runs the tick body; the other skips.
 * A distinct key is independent. The lock releases after the body, so a later attempt wins again.
 *
 * REQUIRES Postgres (pg_try_advisory_lock).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { withTickLeaderLock } from '../infrastructure/pg/LeaderLock.js';

const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const KEY_A = 920_777;
const KEY_B = 920_778;

let pool: pg.Pool;
let pgAvailable = false;

beforeAll(async () => {
  try {
    pool = new pg.Pool({ connectionString: APP, max: 5, connectionTimeoutMillis: 4000 });
    await pool.query('SELECT 1');
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  await pool?.end?.().catch(() => {});
});

describe('withTickLeaderLock (P1, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[leader-lock] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('only ONE of two concurrent acquirers on the same key runs the tick body', async () => {
    if (!pgAvailable) return;
    let running = 0;
    let maxConcurrent = 0;
    let ranCount = 0;
    const body = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 150)); // hold the lock briefly
      running -= 1;
      ranCount += 1;
    };
    const [a, b] = await Promise.all([
      withTickLeaderLock(pool, KEY_A, body),
      withTickLeaderLock(pool, KEY_A, body),
    ]);
    // Exactly one ran as leader; the other skipped. Never two bodies at once.
    expect([a.ranAsLeader, b.ranAsLeader].filter(Boolean).length).toBe(1);
    expect(ranCount).toBe(1);
    expect(maxConcurrent).toBe(1);
  });

  it('a DIFFERENT key is independent (both run)', async () => {
    if (!pgAvailable) return;
    const noop = async () => 42;
    const [a, b] = await Promise.all([
      withTickLeaderLock(pool, KEY_A, noop),
      withTickLeaderLock(pool, KEY_B, noop),
    ]);
    expect(a.ranAsLeader).toBe(true);
    expect(b.ranAsLeader).toBe(true);
  });

  it('releases after the body so a later attempt wins again', async () => {
    if (!pgAvailable) return;
    const first = await withTickLeaderLock(pool, KEY_A, async () => 'x');
    const second = await withTickLeaderLock(pool, KEY_A, async () => 'y');
    expect(first.ranAsLeader).toBe(true);
    expect(second.ranAsLeader).toBe(true); // lock was released after the first body
  });
});
