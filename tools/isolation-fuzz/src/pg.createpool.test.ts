/**
 * isolation-fuzz/pg.createpool.test.ts — proves the @brain/db createPool() MIDDLEWARE
 * enforces RLS even when the pool connects as the SUPERUSER `brain` (audit R-01/R-02).
 *
 * Why this test exists (the gap the audit found):
 *   The sibling pg.test.ts proves RLS enforces by opening a SEPARATE, hand-created
 *   NOSUPERUSER role and hand-rolling `BEGIN; SET LOCAL guc; …`. That proves the *policies*
 *   work, but it does NOT exercise the path the real app uses — `createPool().connect().query()`
 *   — and it does NOT prove enforcement holds on the app's actual superuser connection.
 *   Before the fix, createPool() set the GUC in a separate autocommit statement (discarded
 *   before the query) and never dropped privilege, so on the superuser `brain` connection the
 *   app relied entirely on app-level WHERE clauses — a single missing predicate = cross-tenant leak.
 *
 * What this proves now:
 *   - createPool() is constructed with the SAME superuser DSN the app uses (brain:brain).
 *   - A query under brand-A context CANNOT read brand-B rows → 0 rows (isolation enforced
 *     by the middleware's `SET LOCAL ROLE brain_app` inside the transaction).
 *   - A query under brand-A context CAN read brand-A rows (not over-blocking).
 *   - CONTRAST PROOF: the SAME superuser connection, querying WITHOUT the role switch, DOES
 *     see brand-B's row — proving the connection truly is superuser and the role switch is
 *     the thing doing the enforcing (i.e. this is a real canary, not a tautology).
 *
 * REQUIRES: Postgres running via docker compose --profile core (localhost:5432, brain/brain),
 * migrations applied (the `_rls_demo` table + brain_app role come from migration 0001_init).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, type DbPool } from '@brain/db';
import { withBrandTxn } from '@brain/metric-engine';

const DSN = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

// Test-fixture brands seeded into the purpose-built `_rls_demo` table (migration 0001).
const BRAND_A = 'a0a0a0a0-0000-4000-8000-0000000000a1';
const BRAND_B = 'b0b0b0b0-0000-4000-8000-0000000000b1';
const CORR = 'isolation-createpool-test';

interface RawClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  end: () => Promise<void>;
}

async function openSuperuser(): Promise<RawClient | null> {
  try {
    const { default: pg } = (await import('pg')) as any;
    const client = new pg.Client({ connectionString: DSN, connectionTimeoutMillis: 5000 });
    await client.connect();
    return client;
  } catch {
    return null;
  }
}

let admin: RawClient | null = null;
let pool: DbPool | null = null;
let pgAvailable = false;

beforeAll(async () => {
  admin = await openSuperuser();
  if (!admin) return;

  // Seed two brands' rows directly as superuser (bypasses RLS for setup, by design).
  // _rls_demo is created by migration 0001 with ENABLE+FORCE RLS, a brand_id policy,
  // and GRANT SELECT,INSERT,UPDATE,DELETE TO brain_app.
  await admin.query(`DELETE FROM _rls_demo WHERE brand_id = ANY($1::uuid[])`, [[BRAND_A, BRAND_B]]);
  await admin.query(
    `INSERT INTO _rls_demo (brand_id, payload) VALUES ($1, 'brand-A-secret'), ($2, 'brand-B-secret')`,
    [BRAND_A, BRAND_B],
  );

  // Build the pool EXACTLY as the app does — superuser DSN, default appRole 'brain_app'.
  pool = await createPool({ connectionString: DSN, maxConnections: 3 });
  pgAvailable = true;
});

afterAll(async () => {
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DELETE FROM _rls_demo WHERE brand_id = ANY($1::uuid[])`, [[BRAND_A, BRAND_B]]).catch(() => {});
    await admin.end();
  }
});

describe('createPool() RLS middleware on a SUPERUSER connection (audit R-01/R-02)', () => {
  it('SKIP_IF_NO_PG: pending when Postgres is unavailable', () => {
    if (!pgAvailable) {
      console.warn(
        '[isolation-fuzz/createpool] Postgres unavailable — PENDING. ' +
          'Run: docker compose --profile core up -d && (apply migrations) && re-run.',
      );
    }
    expect(true).toBe(true);
  });

  it('[positive] brand-A context reads brand-A rows (middleware not over-blocking)', async () => {
    if (!pgAvailable || !pool) return;
    const c = await pool.connect();
    try {
      const { rows } = await c.query(
        { brandId: BRAND_A, correlationId: CORR },
        `SELECT brand_id, payload FROM _rls_demo WHERE brand_id = $1`,
        [BRAND_A],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows as { brand_id: string }[]) expect(r.brand_id).toBe(BRAND_A);
    } finally {
      c.release();
    }
  });

  it('[NEGATIVE-CONTROL] brand-A context CANNOT read brand-B rows → 0 rows (I-S01)', async () => {
    if (!pgAvailable || !pool) return;
    const c = await pool.connect();
    try {
      const { rowCount } = await c.query(
        { brandId: BRAND_A, correlationId: CORR },
        `SELECT * FROM _rls_demo WHERE brand_id = $1`,
        [BRAND_B],
      );
      // Enforced by SET LOCAL ROLE brain_app + transaction-scoped GUC inside executeInRlsTxn.
      expect(rowCount).toBe(0);
    } finally {
      c.release();
    }
  });

  it('[proof] the SAME superuser connection WITHOUT the role switch DOES see brand-B → the canary is real', async () => {
    if (!pgAvailable || !admin) return;
    // This is the pre-fix behaviour: a plain query on the superuser connection (no SET LOCAL
    // ROLE, no GUC) bypasses RLS entirely and sees every brand's rows. If this returned 0,
    // the negative control above would be a tautology (connection wasn't really privileged).
    const { rowCount } = await admin.query(`SELECT * FROM _rls_demo WHERE brand_id = $1`, [BRAND_B]);
    expect(rowCount ?? 0).toBeGreaterThan(0);
    console.info(
      `[isolation-fuzz/createpool] canary proof: superuser-without-role-switch sees ${rowCount} brand-B row(s); ` +
        `createPool() middleware (with SET LOCAL ROLE brain_app) returns 0. The role switch is the enforcement.`,
    );
  });
});

describe('withBrandTxn() RLS hardening on a SUPERUSER connection (audit R-01)', () => {
  it('[NEGATIVE-CONTROL] brand-A txn CANNOT read brand-B rows → 0 rows; brand-A → >0', async () => {
    if (!pgAvailable) return;
    const { default: pg } = (await import('pg')) as any;
    // Raw pg.Pool on the SAME superuser DSN the app uses — proves withBrandTxn's
    // SET LOCAL ROLE brain_app enforces RLS despite the privileged connection.
    const rawPool = new pg.Pool({ connectionString: DSN, max: 2 });
    try {
      const crossTenant = await withBrandTxn(rawPool, BRAND_A, async (c) => {
        const r = await c.query(`SELECT * FROM _rls_demo WHERE brand_id = $1`, [BRAND_B]);
        return r.rowCount ?? 0;
      });
      expect(crossTenant).toBe(0);

      const ownTenant = await withBrandTxn(rawPool, BRAND_A, async (c) => {
        const r = await c.query(`SELECT * FROM _rls_demo WHERE brand_id = $1`, [BRAND_A]);
        return r.rowCount ?? 0;
      });
      expect(ownTenant).toBeGreaterThan(0);
    } finally {
      await rawPool.end();
    }
  });
});
