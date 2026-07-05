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
 * R-01 hardening (audit): the transaction also `SET LOCAL ROLE brain_app` so that
 * row-level security is enforced even when the pool connects as a superuser/owner
 * (e.g. the dev `brain` role). Superusers and table owners BYPASS RLS — without the
 * role switch this path relied on the prod connection happening to be brain_app, and
 * was silently inert under any superuser connection. Mirrors @brain/db executeInRlsTxn.
 *
 * @see F-SEC-02 (02-cto-advisor-review.md §MEDIUM)
 * @see D-7 (03-architecture-plan.md §D-7)
 */

import type { Pool, PoolClient } from 'pg';

export interface EngineDeps {
  /** The pg connection pool (brain_app credentials under production; superuser for seeding). */
  readonly pool: Pool;
}

/** Default NOBYPASSRLS role the RLS policies are written `TO` (migration 0001_init). */
const DEFAULT_APP_ROLE = 'brain_app';

/** Bare SQL identifier — the role name is interpolated into SET LOCAL ROLE. */
const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

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
 * @param appRole - NOBYPASSRLS role to assume for the transaction (default brain_app).
 * @returns The return value of fn.
 */
export async function withBrandTxn<T>(
  pool: Pool,
  brandId: string,
  fn: (client: PoolClient) => Promise<T>,
  appRole: string = DEFAULT_APP_ROLE,
): Promise<T> {
  if (!IDENT_RE.test(appRole)) {
    throw new Error(`[metric-engine] app role "${appRole}" is not a valid SQL identifier`);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Drop superuser/owner privilege to the NOBYPASSRLS app role so RLS is enforced
    // for the duration of this transaction (audit R-01). Resets on COMMIT/ROLLBACK.
    await client.query(`SET LOCAL ROLE ${appRole}`);
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
