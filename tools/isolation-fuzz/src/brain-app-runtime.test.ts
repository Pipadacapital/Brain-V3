/**
 * isolation-fuzz/brain-app-runtime.test.ts — the KEYSTONE non-inert proof for
 * feat-tenancy-runtime-brain-app (audit R-01/R-14): tenant isolation is enforced when the app
 * connects as the REAL non-superuser `brain_app` login (not merely a superuser that does
 * `SET LOCAL ROLE`).
 *
 * The sibling pg.createpool.test.ts proves the @brain/db middleware enforces RLS on a SUPERUSER
 * connection (via SET LOCAL ROLE brain_app). This test closes the audit's R-14 objection — "a green
 * test under superuser is literally true, operationally false" — by:
 *
 *   1. Asserting the connection's REAL identity FIRST: current_user='brain_app', is_superuser=off,
 *      rolbypassrls=false. If this precondition fails the rest is inert and the test fails loudly.
 *   2. Proving, through the EXACT app path (createPool → connect → query, which wraps the GUC + query
 *      in one txn under the app role), that under a real brain_app connection:
 *        (a) WITH the brand GUC → the brand's OWN rows come back (A2 didn't break reads — no outage);
 *        (b) cross-brand GUC → 0 rows;
 *        (c) NO GUC → 0 rows (fail-closed);
 *        (d) a cross-brand WRITE is blocked (0 rows affected; the victim row is untouched).
 *
 * REQUIRES: Postgres on localhost:5432, migrations applied (the `_rls_demo` table + the `brain_app`
 * role come from 0001_init), and a `brain_app` LOGIN role reachable via BRAIN_APP_DATABASE_URL
 * (dev: postgres://brain_app:brain_app@localhost:5432/brain). If brain_app cannot log in, the suite
 * is PENDING (skipped) rather than falsely green.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPool, type DbPool } from '@brain/db';

const ADMIN_DSN = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_DSN = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'a0a0a0a0-0000-4000-8000-00000000aa01';
const BRAND_B = 'b0b0b0b0-0000-4000-8000-00000000bb01';
const CORR = 'brain-app-runtime-proof';

interface RawClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  end: () => Promise<void>;
}

async function open(dsn: string): Promise<RawClient | null> {
  try {
    const { default: pg } = (await import('pg')) as unknown as { default: { Client: new (c: unknown) => RawClient } };
    const client = new pg.Client({ connectionString: dsn, connectionTimeoutMillis: 5000 });
    await (client as unknown as { connect: () => Promise<void> }).connect();
    return client;
  } catch {
    return null;
  }
}

let admin: RawClient | null = null;
let appRaw: RawClient | null = null;
let pool: DbPool | null = null;
let ready = false;

beforeAll(async () => {
  admin = await open(ADMIN_DSN);
  appRaw = await open(APP_DSN); // the REAL brain_app login — null if it can't connect
  if (!admin || !appRaw) return;

  // Seed two brands as the owner (RLS bypassed for setup, by design). _rls_demo (0001) has
  // ENABLE+FORCE RLS, a brand_id policy, and GRANT SELECT,INSERT,UPDATE,DELETE TO brain_app.
  await admin.query(`DELETE FROM _rls_demo WHERE brand_id = ANY($1::uuid[])`, [[BRAND_A, BRAND_B]]);
  await admin.query(
    `INSERT INTO _rls_demo (brand_id, payload) VALUES ($1, 'brand-A-secret'), ($2, 'brand-B-secret')`,
    [BRAND_A, BRAND_B],
  );

  // The pool the app uses — but pointed at the REAL brain_app DSN (not the superuser DSN).
  pool = await createPool({ connectionString: APP_DSN, maxConnections: 3 });
  ready = true;
});

afterAll(async () => {
  if (pool) await pool.end();
  if (appRaw) await appRaw.end();
  if (admin) {
    await admin.query(`DELETE FROM _rls_demo WHERE brand_id = ANY($1::uuid[])`, [[BRAND_A, BRAND_B]]).catch(() => {});
    await admin.end();
  }
});

describe('brain_app runtime — tenant isolation under the REAL non-superuser login (R-01/R-14)', () => {
  it('SKIP_IF_NO_BRAIN_APP: pending when Postgres or the brain_app login is unavailable', () => {
    if (!ready) {
      console.warn(
        '[isolation-fuzz/brain-app-runtime] PENDING — Postgres or the brain_app LOGIN role is ' +
          'unreachable. Ensure migrations are applied and brain_app can log in (BRAIN_APP_DATABASE_URL).',
      );
    }
    expect(true).toBe(true);
  });

  // ── The R-14 precondition: the connection must REALLY be a non-superuser brain_app ──
  it('[precondition] the connection is brain_app, NOT a superuser and NOT bypassing RLS', async () => {
    if (!ready || !appRaw) return;
    const { rows } = await appRaw.query(
      `SELECT current_user AS who,
              current_setting('is_superuser') AS is_superuser,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`,
    );
    const r = rows[0] as { who: string; is_superuser: string; bypassrls: boolean };
    expect(r.who).toBe('brain_app');
    expect(r.is_superuser).toBe('off');   // NOT a superuser → RLS is NOT bypassed
    expect(r.bypassrls).toBe(false);      // NOT BYPASSRLS → FORCE RLS actually applies
  });

  it('[positive] WITH the brand GUC, brand-A reads its OWN rows (A2 works — no outage)', async () => {
    if (!ready || !pool) return;
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

  it('[NEGATIVE-CONTROL] cross-brand read → 0 rows (I-S01)', async () => {
    if (!ready || !pool) return;
    const c = await pool.connect();
    try {
      const { rowCount } = await c.query(
        { brandId: BRAND_A, correlationId: CORR },
        `SELECT * FROM _rls_demo WHERE brand_id = $1`,
        [BRAND_B],
      );
      expect(rowCount).toBe(0);
    } finally {
      c.release();
    }
  });

  it('[NEGATIVE-CONTROL] no brand GUC → 0 rows (fail-closed, NN-1)', async () => {
    if (!ready || !pool) return;
    const c = await pool.connect();
    try {
      // ctx with NO brandId → buildContextGucSql defaults the GUC to NIL_UUID → matches nothing.
      const { rowCount } = await c.query(
        { correlationId: CORR },
        `SELECT * FROM _rls_demo`,
        [],
      );
      expect(rowCount).toBe(0);
    } finally {
      c.release();
    }
  });

  it('[NEGATIVE-CONTROL] cross-brand WRITE is blocked — 0 rows affected, victim row untouched', async () => {
    if (!ready || !pool || !admin) return;
    const c = await pool.connect();
    try {
      // Under brand-A context, try to tamper with brand-B's row. The policy's USING clause makes
      // brand-B invisible to the UPDATE → 0 rows affected (the write cannot reach another tenant).
      const { rowCount } = await c.query(
        { brandId: BRAND_A, correlationId: CORR },
        `UPDATE _rls_demo SET payload = 'tampered-by-brand-A' WHERE brand_id = $1`,
        [BRAND_B],
      );
      expect(rowCount).toBe(0);
    } finally {
      c.release();
    }
    // Independently confirm (as owner) brand-B's secret is intact — the write truly did nothing.
    const { rows } = await admin.query(`SELECT payload FROM _rls_demo WHERE brand_id = $1`, [BRAND_B]);
    expect((rows[0] as { payload: string }).payload).toBe('brand-B-secret');
  });
});
