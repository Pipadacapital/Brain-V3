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
 * Injection guard for the brand GUC value. It is interpolated into a single-quoted
 * `SET LOCAL app.current_brand_id = '<value>'` literal, so it must be a BARE TOKEN — alphanumerics,
 * hyphen, underscore only — with no quote/semicolon/whitespace/backslash that could break out of the
 * literal. Real brand ids are UUIDs (which match); non-UUID bare tokens (e.g. the `brand-a` fixtures
 * in unit tests, where the DB is mocked) also match and pass through. Anything else throws.
 */
const BRAND_GUC_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

/**
 * All-zero UUID — the fail-closed sentinel for an absent/empty brand GUC. A VALID uuid that no real
 * row matches, so the RLS cast `current_setting('app.current_brand_id', true)::uuid` stays a valid
 * `'<nil>'::uuid` (→ 0 rows) instead of raising `invalid input syntax for type uuid: ""`.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Resolve the literal value written into `SET LOCAL app.current_brand_id`. Empty/undefined →
 * NIL_UUID (fail-closed); a non-empty value must be an injection-safe bare token (see
 * BRAND_GUC_TOKEN_RE) or it throws. This is the fix for the `''::uuid` cast error: a pooled
 * connection whose session GUC was left as the empty string (RESET on a custom GUC yields '', not
 * NULL) would make an RLS policy that casts the GUC raise 22P02. Writing NIL_UUID for empty keeps
 * every cast legal; the token guard blocks SQL-literal breakout without rejecting the non-UUID brand
 * fixtures used by unit tests (which mock the DB, so the value never reaches Postgres).
 */
function brandGucLiteral(brandId: string): string {
  if (brandId === undefined || brandId === null || brandId === '') return NIL_UUID;
  if (!BRAND_GUC_TOKEN_RE.test(brandId)) {
    throw new Error(`[metric-engine] brandId "${brandId}" is not an injection-safe bare token`);
  }
  return brandId;
}

/**
 * withBrandTxn — executes fn inside an explicit BEGIN/COMMIT with the brand GUC set.
 *
 * BEGIN → SET LOCAL ROLE → SET LOCAL app.current_brand_id = '<uuid>' → fn(client) → COMMIT
 * ROLLBACK on error. The GUC is transaction-local (SET LOCAL), so it resets automatically on
 * COMMIT/ROLLBACK and cannot leak across pool connections.
 *
 * The brand GUC is written as a literal `SET LOCAL` (UUID-validated), mirroring @brain/db's
 * executeInRlsTxn — NOT the parameterized `set_config(...)` this used to call. On a pgbouncer-pooled
 * connection whose session GUC was left as the empty string (RESET on a custom GUC yields '', not
 * NULL), the brand table's RLS policy `id = current_setting('app.current_brand_id', TRUE)::uuid`
 * would cast '' → uuid and raise 22P02 (`invalid input syntax for type uuid: ""`), 500-ing every
 * metric-engine read (contribution-margin, orders FX enrichment). Always writing a valid uuid here
 * makes the cast legal on every connection.
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
  // Resolve + validate the GUC value BEFORE opening the txn (empty → NIL_UUID, invalid → throw).
  const brandGuc = brandGucLiteral(brandId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Drop superuser/owner privilege to the NOBYPASSRLS app role so RLS is enforced
    // for the duration of this transaction (audit R-01). Resets on COMMIT/ROLLBACK.
    await client.query(`SET LOCAL ROLE ${appRole}`);
    // GUC: transaction-scoped (SET LOCAL, UUID-validated literal) — resets on COMMIT/ROLLBACK.
    await client.query(`SET LOCAL app.current_brand_id = '${brandGuc}'`);
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
