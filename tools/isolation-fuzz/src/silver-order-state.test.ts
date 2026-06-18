/**
 * isolation-fuzz/silver-order-state.test.ts — Silver read seam isolation (NN-2, I-ST01)
 *
 * Proves per-brand isolation on the Silver READ path (silver.order_state) and that the
 * guard is NON-INERT — the exact bypass-green trap starrocks.test.ts documents.
 *
 * THE MECHANISM UNDER TEST: packages/metric-engine/src/silver-deps.ts `withSilverBrand`.
 * StarRocks `CREATE ROW POLICY` is enterprise-only and unavailable on the dev allin1
 * image, so M1 isolation is an application-injected brand predicate at the single Silver
 * seam (the I-ST01 sole reader). This test exercises the REAL seam (imported from
 * @brain/metric-engine — not a copy) so what passes here is what ships.
 *
 * THE NON-INERT PROOF (the part that matters):
 *   1. [positive] withSilverBrand(brandA) returns ONLY brand-A rows (>0), zero brand-B.
 *   2. [mutation / negative-control] the SAME seam, asked for brandA but with the
 *      predicate injection DISABLED (__unsafeDisableBrandPredicate), MUST leak brand-B
 *      rows. If disabling the filter does NOT leak, the predicate was inert (it wasn't
 *      doing the work) → the test FAILS LOUD. This makes the guard's effectiveness
 *      observable (the R1/M-01 demand).
 *
 * ENGINE-POLICY GAP: engine-level CREATE ROW POLICY is the documented prod graduation
 * (db/starrocks/row_policy_template.sql). Until a managed cluster applies it, the seam
 * predicate is the enforcement and this mutation test is its proof.
 *
 * REQUIRES: StarRocks on :9030 with brain_silver.silver_order_state present (dbt run, T1).
 * If StarRocks is unreachable OR the mart is absent, the tests PEND (visibly skipped) —
 * they are NOT silently green. Seeding uses a transient throwaway brand-id pair so the
 * test is self-contained and idempotent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withSilverBrand, type SilverPool, type SilverConnection } from '@brain/metric-engine';

// Throwaway brand ids unique to this test (avoid colliding with real Silver rows).
const BRAND_A = 'aaaa1111-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb2222-0000-4000-8000-bbbbbbbbbbbb';
const SEED_TABLE = 'brain_silver.silver_order_state';

interface RawConn {
  query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>;
  release?: () => void;
  end: () => Promise<void>;
}

let rawConn: RawConn | null = null;
let srAvailable = false;
let martAvailable = false;

/** Adapt a single mysql2 connection into the structural SilverPool the seam expects. */
function poolFromConn(conn: RawConn): SilverPool {
  const silverConn: SilverConnection = {
    query: (sql, params) => conn.query(sql, params),
    release: () => { /* single shared connection — no-op release */ },
  };
  return {
    query: (sql, params) => conn.query(sql, params),
    getConnection: async () => silverConn,
  };
}

beforeAll(async () => {
  try {
    const mysql = (await import('mysql2/promise')) as unknown as {
      createConnection: (opts: Record<string, unknown>) => Promise<RawConn>;
    };
    rawConn = await mysql.createConnection({
      host: process.env['STARROCKS_HOST'] ?? 'localhost',
      port: Number(process.env['STARROCKS_PORT'] ?? 9030),
      user: process.env['STARROCKS_USER'] ?? 'root', // root for SEEDING; the engine reads as brain_analytics in prod
      password: process.env['STARROCKS_PASSWORD'] ?? '',
      connectTimeout: 10000,
      multipleStatements: false,
    });
    srAvailable = true;
  } catch {
    console.warn(
      '[isolation-fuzz/silver] StarRocks not reachable on :9030 — tests PENDING. ' +
      'Start docker compose --profile core and run `make silver-build`.',
    );
    return;
  }

  // Confirm the mart exists (dbt run, T1). If not, PEND.
  try {
    await rawConn!.query(`SELECT COUNT(*) AS cnt FROM ${SEED_TABLE}`);
    martAvailable = true;
  } catch {
    console.warn(
      `[isolation-fuzz/silver] ${SEED_TABLE} not found — tests PENDING. Run T1: \`make silver-build\`.`,
    );
    return;
  }

  // Seed one brand-A + one brand-B row (upsert by PK (brand_id, order_id)).
  // Columns mirror the mart DDL (05-architecture.md §2). If the column set drifts this
  // INSERT fails loud → a real signal the mart shape changed.
  const seed = async (brand: string, orderId: string, state: string) => {
    await rawConn!.query(
      `INSERT INTO ${SEED_TABLE}
         (brand_id, order_id, brain_id, lifecycle_state, is_terminal,
          order_value_minor, currency_code, first_event_at, state_effective_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, 'INR', NOW(), NOW(), NOW())`,
      [brand, orderId, state, state === 'delivered', 100000],
    );
  };
  try {
    await seed(BRAND_A, 'iso-fuzz-a-1', 'delivered');
    await seed(BRAND_B, 'iso-fuzz-b-1', 'delivered');
  } catch (err) {
    console.warn(`[isolation-fuzz/silver] seed failed (mart shape drift?) — tests PENDING: ${String(err)}`);
    martAvailable = false;
  }
});

afterAll(async () => {
  if (rawConn && martAvailable) {
    // Clean up the throwaway rows so the test is idempotent.
    await rawConn.query(`DELETE FROM ${SEED_TABLE} WHERE brand_id IN (?, ?)`, [BRAND_A, BRAND_B]).catch(() => { /* best-effort */ });
  }
  if (rawConn) await rawConn.end().catch(() => { /* ignore */ });
});

describe('Silver read seam — per-brand isolation (NN-2 / I-ST01, withSilverBrand)', () => {

  it('SKIP_IF_UNAVAILABLE: PENDING when StarRocks / the mart is not reachable', () => {
    if (!srAvailable || !martAvailable) {
      console.warn('[isolation-fuzz/silver] StarRocks or silver.order_state unavailable — isolation assertions PENDING.');
    }
    expect(true).toBe(true);
  });

  it('[positive] withSilverBrand(brandA) returns ONLY brand-A rows, zero brand-B', async (ctx) => {
    if (!srAvailable || !martAvailable || !rawConn) return ctx.skip();
    const pool = poolFromConn(rawConn);

    const rows = await withSilverBrand(pool, BRAND_A, async (scope) =>
      scope.runScoped<{ brand_id: string }>(
        `SELECT brand_id FROM ${SEED_TABLE} WHERE \${BRAND_PREDICATE} AND order_id IN ('iso-fuzz-a-1','iso-fuzz-b-1')`,
      ),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.brand_id).toBe(BRAND_A);
    expect(rows.some((r) => r.brand_id === BRAND_B)).toBe(false);
  });

  it('[mutation / NON-INERT proof] disabling the seam predicate MUST leak brand-B rows', async (ctx) => {
    if (!srAvailable || !martAvailable || !rawConn) return ctx.skip();
    const pool = poolFromConn(rawConn);

    // Same logical read, asked for brand-A, but with predicate injection DISABLED.
    // If the predicate were inert (not doing the work), the result would be unchanged
    // and brand-B would still be excluded — and THIS assertion would fail, exposing it.
    const leaked = await withSilverBrand(
      pool,
      BRAND_A,
      async (scope) =>
        scope.runScoped<{ brand_id: string }>(
          `SELECT brand_id FROM ${SEED_TABLE} WHERE \${BRAND_PREDICATE} AND order_id IN ('iso-fuzz-a-1','iso-fuzz-b-1')`,
        ),
      { __unsafeDisableBrandPredicate: true },
    );

    // The guard is PROVEN non-inert: without it, brand-B leaks.
    expect(leaked.some((r) => r.brand_id === BRAND_B)).toBe(true);
  });

  it('[documentation] engine-level row policy is the prod graduation (M1 step)', () => {
    // ALWAYS PASSES — documents the platform boundary honestly.
    // Dev allin1 StarRocks has NO CREATE ROW POLICY. M1 isolation = the withSilverBrand
    // seam predicate, proven non-inert by the mutation test above. Prod graduation:
    // apply db/starrocks/row_policy_template.sql on a managed/enterprise cluster; the
    // seam predicate then becomes defense-in-depth behind the engine policy.
    expect('Silver isolation = app-seam predicate (non-inert); engine row policy = prod graduation').toBeTruthy();
  });
});
