/**
 * @brain/metric-engine — Engine dependencies + withBrandTxn helper (D-7, F-SEC-02)
 *
 * EngineDeps carries the pg.Pool/client so the engine stays testable and
 * the read seam is injected (no hidden global).
 *
 * withBrandTxn wraps every GUC-set + seam-call in an explicit BEGIN/COMMIT
 * on the SAME client. This is the F-SEC-02 carry-in fix: the GUC's is_local=true
 * scope only holds within a transaction; under autocommit it can reset on
 * connection return. The explicit transaction eliminates that ambiguity.
 * Worst-case without the txn: two-arg current_setting('app.current_brand_id', TRUE)
 * fails closed (returns NULL → 0 rows), but we remove the ambiguity here.
 *
 * @see F-SEC-02 (02-cto-advisor-review.md §MEDIUM)
 * @see D-7 (03-architecture-plan.md §D-7)
 */

import type { Pool, PoolClient } from 'pg';

export interface EngineDeps {
  /** The pg connection pool (brain_app credentials under production; superuser for seeding). */
  readonly pool: Pool;
}

/**
 * withBrandTxn — executes fn inside an explicit BEGIN/COMMIT with the brand GUC set.
 *
 * BEGIN → set_config('app.current_brand_id', brandId, true) → fn(client) → COMMIT
 * ROLLBACK on error. The GUC is transaction-local (is_local=true), so it resets
 * automatically on COMMIT/ROLLBACK and cannot leak across pool connections.
 *
 * The fn receives a PoolClient already inside the transaction with the GUC set.
 *
 * @param pool    - The pg.Pool to acquire a client from.
 * @param brandId - The brand UUID to set as GUC (app.current_brand_id).
 * @param fn      - Async function that runs queries on the client inside the txn.
 * @returns The return value of fn.
 */
export async function withBrandTxn<T>(
  pool: Pool,
  brandId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // GUC: transaction-scoped (is_local=true) — resets on COMMIT/ROLLBACK
    await client.query("SELECT set_config('app.current_brand_id', $1, true)", [brandId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // best-effort rollback; original error takes precedence
    });
    throw err;
  } finally {
    client.release();
  }
}
