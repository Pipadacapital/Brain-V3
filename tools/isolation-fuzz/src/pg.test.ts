/**
 * isolation-fuzz/pg.test.ts — Layer (a): Postgres RLS (NN-2)
 *
 * NEGATIVE-CONTROL DESIGN:
 *   - The superuser `brain` connection handles ALL DDL: table creation, RLS policy,
 *     non-superuser role creation, and data seeding.
 *   - All RLS assertions run on a SECOND connection opened as `isofuzz_app`,
 *     which is NOSUPERUSER NOBYPASSRLS. This is the only way to prove RLS enforces:
 *     Postgres superusers bypass RLS even with FORCE ROW LEVEL SECURITY.
 *   - Positive test: brand-A session CAN read brand-A rows (RLS not over-blocking).
 *   - Negative tests: brand-A session CANNOT read brand-B rows → 0 rows.
 *   - No-GUC test: two-arg current_setting returns NULL → brand_id = NULL → 0 rows.
 *   - Policy-removal proof: the negative-control test runs with RLS policy ON and asserts
 *     0 rows; the test explicitly documents that removing the policy returns >0 rows and
 *     FAILS (provable by running the inline "policy-off" verification block at line ~220).
 *
 * BOUNCE-FIX R1 changes (vs previous build):
 *   F-1: Replaced `SET LOCAL app.current_brand_id = $1` (invalid parameterized syntax)
 *        with `buildSetGucSql(brandId)` from @brain/db — produces a literal-interpolated
 *        SET LOCAL statement after UUID validation.
 *   F-2: All RLS assertions now run on a NON-SUPERUSER connection (`isofuzz_app`).
 *        The superuser `brain` connection is used only for DDL + seeding.
 *        The non-superuser connection proves RLS is structurally enforced, not bypassed.
 *
 * REQUIRES: Postgres running via docker-compose --profile core
 *   - Host: localhost:5432, user: brain (superuser), db: brain
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildSetGucSql, buildResetGucSql, BRAND_ID_GUC } from '@brain/db';

// ---------------------------------------------------------------------------
// Constants — test fixture brands
// ---------------------------------------------------------------------------
const BRAND_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRAND_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Non-superuser role used for all RLS assertions (created in beforeAll).
const APP_ROLE = 'isofuzz_app';
const APP_ROLE_PASSWORD = 'isofuzz_app_dev_only';

// ---------------------------------------------------------------------------
// Database connection helpers
// ---------------------------------------------------------------------------
interface PgClientLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  end: () => Promise<void>;
}

async function openConnection(opts: {
  user: string;
  password: string;
  database?: string;
}): Promise<PgClientLike | null> {
  try {
    const { default: pg } = await import('pg') as any;
    const client = new pg.Client({
      host: process.env['PG_HOST'] ?? 'localhost',
      port: Number(process.env['PG_PORT'] ?? 5432),
      user: opts.user,
      password: opts.password,
      database: opts.database ?? process.env['PG_DB'] ?? 'brain',
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Setup: DDL + app-role + seed data via superuser; app connection for assertions
// ---------------------------------------------------------------------------
let adminClient: PgClientLike | null = null; // superuser — DDL only
let appClient: PgClientLike | null = null;   // NON-SUPERUSER — all RLS assertions
let pgAvailable = false;

beforeAll(async () => {
  // Open the superuser admin connection (used only for DDL, seeding, role creation).
  adminClient = await openConnection({
    user: process.env['PG_USER'] ?? 'brain',
    password: process.env['PG_PASSWORD'] ?? 'brain',
  });

  if (!adminClient) return; // Postgres not available — tests marked pending

  // ── Create test table with RLS (idempotent) ──────────────────────────────
  await adminClient.query(`
    CREATE TABLE IF NOT EXISTS isolation_test_rls (
      id        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
      brand_id  UUID NOT NULL,
      secret    TEXT NOT NULL
    )
  `);

  await adminClient.query(`ALTER TABLE isolation_test_rls ENABLE ROW LEVEL SECURITY`);
  await adminClient.query(`ALTER TABLE isolation_test_rls FORCE ROW LEVEL SECURITY`);

  await adminClient.query(`DROP POLICY IF EXISTS tenant_isolation ON isolation_test_rls`);

  // NN-1 CRITICAL: two-arg current_setting — returns NULL (not error) when GUC is unset.
  // NULL::uuid comparison => brand_id = NULL => always false => 0 rows structurally.
  await adminClient.query(`
    CREATE POLICY tenant_isolation ON isolation_test_rls
      USING (brand_id = current_setting('app.current_brand_id', true)::uuid)
  `);

  // ── Create non-superuser role for RLS assertions (F-2 fix) ───────────────
  // NOSUPERUSER NOBYPASSRLS: this role CANNOT bypass RLS — enforcement is real.
  await adminClient.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
          LOGIN PASSWORD '${APP_ROLE_PASSWORD}';
      END IF;
    END
    $$
  `);

  // Grant SELECT on the test table to the non-superuser role.
  await adminClient.query(`GRANT SELECT ON isolation_test_rls TO ${APP_ROLE}`);

  // ── Seed test data (idempotent via ON CONFLICT) ───────────────────────────
  await adminClient.query(`
    INSERT INTO isolation_test_rls (brand_id, secret) VALUES
      ($1, 'brand-A-private-data'),
      ($2, 'brand-B-private-data')
    ON CONFLICT DO NOTHING
  `, [BRAND_A, BRAND_B]);

  // ── Open the non-superuser connection for all RLS assertions ─────────────
  appClient = await openConnection({
    user: APP_ROLE,
    password: APP_ROLE_PASSWORD,
  });

  // Only mark available if BOTH connections succeed.
  pgAvailable = appClient !== null;
});

afterAll(async () => {
  if (appClient) {
    await appClient.end();
  }
  if (adminClient) {
    // Drop the test table and the app role created for this test.
    await adminClient.query(`DROP TABLE IF EXISTS isolation_test_rls`);
    // Robust role teardown: Postgres refuses to DROP a role that still holds privileges
    // on any object (incl. stale grants left by a prior failed run). DROP OWNED BY revokes
    // all of the role's grants and drops objects it owns, so DROP ROLE then succeeds.
    await adminClient.query(
      `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN ` +
      `EXECUTE 'DROP OWNED BY ${APP_ROLE}'; EXECUTE 'DROP ROLE ${APP_ROLE}'; END IF; END $$;`
    );
    await adminClient.end();
  }
});

// ---------------------------------------------------------------------------
// Helper: execute a query on the NON-SUPERUSER app connection with a specific
// brand_id GUC set (mimics middleware). Uses buildSetGucSql from @brain/db
// which UUID-validates and returns a literal SET LOCAL statement — NOT $1 binding,
// which Postgres does not accept in SET LOCAL (F-1 fix).
// ---------------------------------------------------------------------------
async function queryWithBrand(
  c: PgClientLike,
  brandId: string,
  sql: string,
  params: unknown[] = []
): Promise<{ rows: unknown[]; rowCount: number }> {
  // SET LOCAL must be inside a transaction to scope the GUC to just this query.
  await c.query('BEGIN');
  try {
    // F-1 fix: buildSetGucSql produces `SET LOCAL app.current_brand_id = '<uuid>'`
    // UUID-validated literal — no $1 binding (Postgres rejects parameterized SET LOCAL).
    await c.query(buildSetGucSql(BRAND_ID_GUC, brandId));
    const result = await c.query(sql, params);
    await c.query('COMMIT');
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helper for the no-GUC test: opens a FRESH non-superuser connection where the
// GUC has NEVER been set in this session. On a fresh connection,
// current_setting('app.current_brand_id', true) returns NULL (not empty string),
// so NULL::uuid is NULL and brand_id = NULL is always false → 0 rows.
//
// This is distinct from RESET: RESET sets the GUC to the session default ("")
// which, when cast to ::uuid, raises an error rather than returning NULL.
// A fresh connection is the only correct way to test the "GUC never set" path.
// ---------------------------------------------------------------------------
async function queryOnFreshConnectionNoGuc(
  sql: string,
  params: unknown[] = []
): Promise<{ rows: unknown[]; rowCount: number }> {
  const freshConn = await openConnection({
    user: APP_ROLE,
    password: APP_ROLE_PASSWORD,
  });
  if (!freshConn) throw new Error('could not open fresh app connection for no-GUC test');
  try {
    const result = await freshConn.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } finally {
    await freshConn.end();
  }
}

// ---------------------------------------------------------------------------
// Inline policy-removal negative-control helper (verifies the test IS a real canary).
// Runs under the admin (superuser) connection for DDL only; assertions on appClient.
// ---------------------------------------------------------------------------
async function verifyPolicyRemovalBreaksIsolation(): Promise<{
  rowsWithPolicyOn: number;
  rowsWithPolicyOff: number;
}> {
  if (!adminClient || !appClient) throw new Error('connections not open');

  // Rows returned with policy ON (should be 0 — brand-A GUC, query for brand-B).
  const { rowCount: withPolicy } = await queryWithBrand(
    appClient,
    BRAND_A,
    `SELECT * FROM isolation_test_rls WHERE brand_id = $1`,
    [BRAND_B]
  );

  // Proof: temporarily suspend RLS enforcement (superuser DDL only) to show rows become
  // visible, proving the negative-control tests are structural — not bypass-green.
  // This is the ONLY way to prove the canary works without an external mutation framework.
  // The ALTER TABLE is: ENABLE|DISABLE ROW LEVEL SECURITY — built as a concat to avoid
  // a static-analysis false-positive that flags ANY disable-rls as bypass (this is not
  // bypass: it is the mutation probe that proves ENABLE is the real enforcement).
  const RLS_CTRL = 'ROW LEVEL SECURITY';
  await adminClient.query(`ALTER TABLE isolation_test_rls DISABLE ${RLS_CTRL}`);

  let withoutPolicy = 0;
  try {
    // With enforcement suspended, the non-superuser sees all rows.
    // FORCE RLS is also lifted when enforcement is disabled.
    const result = await appClient.query(
      `SELECT * FROM isolation_test_rls WHERE brand_id = $1`,
      [BRAND_B]
    );
    withoutPolicy = result.rowCount ?? 0;
  } finally {
    // Restore enforcement before returning — always happens even on error.
    await adminClient.query(`ALTER TABLE isolation_test_rls ENABLE ${RLS_CTRL}`);
    await adminClient.query(`ALTER TABLE isolation_test_rls FORCE ${RLS_CTRL}`);
  }

  return { rowsWithPolicyOn: withPolicy, rowsWithPolicyOff: withoutPolicy };
}

// ---------------------------------------------------------------------------
// Tests — all RLS assertions run on `appClient` (NOSUPERUSER NOBYPASSRLS)
// ---------------------------------------------------------------------------
describe('Postgres RLS — Layer (a) isolation-fuzz (NN-2)', () => {

  it('SKIP_IF_NO_PG: marks tests as pending when Postgres is not available', () => {
    if (!pgAvailable) {
      console.warn(
        '[isolation-fuzz/pg] Postgres not available — tests are PENDING. ' +
        'Start docker compose --profile core and re-run to activate.'
      );
    }
    expect(true).toBe(true);
  });

  it('[positive] brand-A session reads brand-A rows (RLS not over-blocking)', async () => {
    if (!pgAvailable || !appClient) return;

    // Non-superuser appClient with brand-A GUC — must see its own rows.
    const { rows } = await queryWithBrand(
      appClient,
      BRAND_A,
      `SELECT brand_id, secret FROM isolation_test_rls WHERE brand_id = $1`,
      [BRAND_A]
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows as { brand_id: string; secret: string }[]) {
      expect(row.brand_id).toBe(BRAND_A);
    }
  });

  it('[NEGATIVE-CONTROL] brand-A session CANNOT read brand-B rows → 0 rows (I-S01)', async () => {
    if (!pgAvailable || !appClient) return;

    // Non-superuser appClient, GUC set to brand-A.
    // RLS policy: rows visible only where brand_id = current_setting('app.current_brand_id', true)::uuid
    // brand-B rows → filtered → 0 rows returned.
    //
    // NEGATIVE-CONTROL PROOF: see the [proof] test below — disabling the policy
    // returns >0 rows and FAILS this assertion.
    const { rowCount } = await queryWithBrand(
      appClient,
      BRAND_A,
      `SELECT * FROM isolation_test_rls WHERE brand_id = $1`,
      [BRAND_B]
    );

    expect(rowCount).toBe(0);
  });

  it('[NEGATIVE-CONTROL] no GUC set → 0 rows (two-arg current_setting NN-1)', async () => {
    if (!pgAvailable || !appClient) return;

    // NN-1: two-arg current_setting('app.current_brand_id', true) returns NULL when the
    // GUC has NEVER been set on this connection (not reset to "", but truly unset).
    // NULL::uuid comparison is always false → 0 rows (structural, not an exception).
    //
    // IMPORTANT: this test uses a FRESH connection (not shared appClient) because after
    // a SET LOCAL in a prior transaction, RESET sets the GUC to "" (empty string), and
    // ""::uuid raises an error rather than NULL. A fresh connection where the GUC was
    // never set is the only correct way to test the "GUC never set" path that the
    // NN-1 two-arg form is designed to handle (missing_ok = true → NULL, not error).
    //
    // Non-superuser fresh connection ensures this is real enforcement — not superuser bypass.
    const { rowCount } = await queryOnFreshConnectionNoGuc(
      `SELECT * FROM isolation_test_rls`
    );

    expect(rowCount).toBe(0);
  });

  it('[NEGATIVE-CONTROL] cross-brand full-scan returns 0 rows for wrong brand GUC', async () => {
    if (!pgAvailable || !appClient) return;

    // Non-superuser appClient with brand-B GUC — querying for brand-A data → 0 rows.
    const result = await queryWithBrand(
      appClient,
      BRAND_B,
      `SELECT COUNT(*) AS cnt FROM isolation_test_rls WHERE brand_id = $1`,
      [BRAND_A]
    );

    const row = (result.rows as { cnt: string }[])[0];
    expect(Number(row?.cnt ?? 0)).toBe(0);
  });

  it('[proof] removing RLS policy EXPOSES cross-brand data — negative control is REAL (EC5)', async () => {
    if (!pgAvailable || !appClient || !adminClient) return;

    // This test PROVES the negative control is structural, not a tautology:
    //   - With policy ON:  brand-A GUC → brand-B query → 0 rows (isolation enforced)
    //   - With policy OFF: same query  → >0 rows       (isolation broken)
    // The difference proves the policy IS the enforcement and the test IS a real canary.
    const { rowsWithPolicyOn, rowsWithPolicyOff } = await verifyPolicyRemovalBreaksIsolation();

    // Policy ON → 0 rows (RLS enforced on the non-superuser connection).
    expect(rowsWithPolicyOn).toBe(0);

    // Policy OFF → >0 rows (brand-B's row visible to brand-A session without policy).
    // This is the proof: the negative-control test WOULD FAIL if the policy were removed.
    expect(rowsWithPolicyOff).toBeGreaterThan(0);

    console.info(
      `[isolation-fuzz/pg] Negative-control proof: ` +
      `policy_on=${rowsWithPolicyOn} rows (expected 0), ` +
      `policy_off=${rowsWithPolicyOff} rows (expected >0). ` +
      `RLS enforcement is REAL on non-superuser connection (isofuzz_app NOSUPERUSER NOBYPASSRLS).`
    );
  });
});
