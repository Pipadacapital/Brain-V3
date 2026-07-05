/**
 * LeaderLock — single-leader gating for the periodic worker loops (P1 pre-scale).
 *
 * The ingest-scheduler, sync-request-claimer, and dq-checks loops run in EVERY replica with no
 * coordination. The scheduler is the dangerous one: each replica enumerates every connector and
 * dispatches its repull, and run()'s own FOR UPDATE SKIP LOCKED is released immediately (not held
 * for the fetch) — so N replicas issue N× the connector API load (a latent double-fetch hazard
 * masked only by downstream dedup, and a hard rate-limit ceiling at scale).
 *
 * This gates each tick on a Postgres SESSION-level advisory lock keyed per loop: at most ONE replica
 * runs a given loop's tick at a time. Non-leaders skip the tick cheaply and try again next interval,
 * so there is no leader-election handshake and no leader-death recovery to get wrong — whichever
 * replica wins `pg_try_advisory_lock` for the next tick is the leader for that tick.
 *
 * The lock is a SESSION lock (not a transaction lock) held only for the tick body and released in a
 * finally — so there is NO long idle-in-transaction. One pooled connection is checked out for the
 * tick's duration.
 *
 * Advisory-lock keys (app-private, arbitrary but stable) — keep DISTINCT per loop:
 */
import type { Pool } from 'pg';

// 910_001 was LEADER_LOCK_INGEST_SCHEDULER (loop retired) — keep the key reserved, do not reuse.
export const LEADER_LOCK_SYNC_CLAIMER = 910_002;
export const LEADER_LOCK_DQ_CHECKS = 910_003;

export type LeaderLockOutcome<T> =
  | { ranAsLeader: true; result: T }
  | { ranAsLeader: false };

/**
 * Run `fn` only if this replica wins the advisory lock for `lockKey`. Returns whether it ran as
 * leader (and the result if so). On a lost lock, returns immediately without running `fn`.
 */
export async function withTickLeaderLock<T>(
  pool: Pool,
  lockKey: number,
  fn: () => Promise<T>,
): Promise<LeaderLockOutcome<T>> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [lockKey],
    );
    if (res.rows[0]?.locked !== true) {
      return { ranAsLeader: false };
    }
    try {
      return { ranAsLeader: true, result: await fn() };
    } finally {
      // Release the session lock so the next tick can be won by any replica. Best-effort: a failed
      // unlock still clears when the connection closes; never let it mask the tick's own error.
      await client.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
