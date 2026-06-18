/**
 * isolation-fuzz/silver-touchpoint.test.ts — Silver journey read seam isolation (NN-2, I-ST01)
 *
 * Proves per-brand isolation on the Silver READ path (silver.touchpoint) and that the
 * guard is NON-INERT — the exact bypass-green trap the order-state test documents.
 *
 * THE MECHANISM UNDER TEST: packages/metric-engine/src/silver-deps.ts `withSilverBrand`.
 * The journey reads (computeFirstTouchMix / computeStitchHitRate / computeTouchpointTimeline)
 * go through the SAME seam as order_state, so isolation is STRUCTURAL — a caller cannot
 * forget the predicate (it is substituted from ${BRAND_PREDICATE} at the seam). This test
 * exercises the REAL seam imported from @brain/metric-engine (not a copy) so what passes
 * here is what ships.
 *
 * THE NON-INERT PROOF (the part that matters):
 *   1. [positive] withSilverBrand(brandA) returns ONLY brand-A touchpoints (>0), zero brand-B.
 *   2. [mutation / negative-control] the SAME seam asked for brandA but with the predicate
 *      injection DISABLED (__unsafeDisableBrandPredicate) MUST leak brand-B touchpoints. If
 *      disabling the filter does NOT leak, the predicate was inert → the test FAILS LOUD.
 *
 * REQUIRES: StarRocks on :9030 with brain_silver.silver_touchpoint present (`make journey-build`).
 * If StarRocks is unreachable OR the mart is absent, the tests PEND (visibly skipped) — they
 * are NOT silently green. Seeding uses a transient throwaway brand-id pair (self-contained).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withSilverBrand, type SilverPool, type SilverConnection } from '@brain/metric-engine';

// Throwaway brand ids unique to this test (avoid colliding with real Silver rows).
const BRAND_A = 'aaaa3333-0000-4000-8000-aaaaaaaaaaaa';
const BRAND_B = 'bbbb4444-0000-4000-8000-bbbbbbbbbbbb';
const SEED_TABLE = 'brain_silver.silver_touchpoint';

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
      user: process.env['STARROCKS_USER'] ?? 'root', // root for SEEDING; engine reads as brain_analytics in prod
      password: process.env['STARROCKS_PASSWORD'] ?? '',
      connectTimeout: 10000,
      multipleStatements: false,
    });
    srAvailable = true;
  } catch {
    console.warn(
      '[isolation-fuzz/touchpoint] StarRocks not reachable on :9030 — tests PENDING. ' +
      'Start docker compose --profile core and run `make journey-build`.',
    );
    return;
  }

  // Confirm the mart exists (dbt run). If not, PEND.
  try {
    await rawConn!.query(`SELECT COUNT(*) AS cnt FROM ${SEED_TABLE}`);
    martAvailable = true;
  } catch {
    console.warn(
      `[isolation-fuzz/touchpoint] ${SEED_TABLE} not found — tests PENDING. Run \`make journey-build\`.`,
    );
    return;
  }

  // Seed one brand-A + one brand-B touchpoint row (upsert by PK
  // (brand_id, brain_anon_id, touch_seq)). Columns mirror the mart DDL (05-architecture §2);
  // if the column set drifts this INSERT fails loud → a real signal the mart shape changed.
  const seed = async (brand: string, anon: string) => {
    await rawConn!.query(
      `INSERT INTO ${SEED_TABLE}
         (brand_id, brain_anon_id, touch_seq, session_key, session_seq,
          is_first_touch, is_last_touch, occurred_at, event_type, channel,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content,
          fbclid, gclid, ttclid, referrer_host, landing_path,
          stitched_order_id, stitched_brain_id, is_synthetic, session_id_raw, updated_at)
       VALUES (?, ?, 1, 0, 1, true, true, NOW(), 'page.viewed', 'direct',
               NULL, NULL, NULL, NULL, NULL,
               NULL, NULL, NULL, NULL, '/',
               NULL, NULL, false, NULL, NOW())`,
      [brand, anon],
    );
  };
  try {
    await seed(BRAND_A, 'iso-fuzz-anon-a');
    await seed(BRAND_B, 'iso-fuzz-anon-b');
  } catch (err) {
    console.warn(`[isolation-fuzz/touchpoint] seed failed (mart shape drift?) — tests PENDING: ${String(err)}`);
    martAvailable = false;
  }
});

afterAll(async () => {
  if (rawConn && martAvailable) {
    await rawConn
      .query(`DELETE FROM ${SEED_TABLE} WHERE brand_id IN (?, ?)`, [BRAND_A, BRAND_B])
      .catch(() => { /* best-effort */ });
  }
  if (rawConn) await rawConn.end().catch(() => { /* ignore */ });
});

describe('Silver journey read seam — per-brand isolation (NN-2 / I-ST01, withSilverBrand)', () => {

  it('SKIP_IF_UNAVAILABLE: PENDING when StarRocks / the mart is not reachable', () => {
    if (!srAvailable || !martAvailable) {
      console.warn('[isolation-fuzz/touchpoint] StarRocks or silver.touchpoint unavailable — isolation assertions PENDING.');
    }
    expect(true).toBe(true);
  });

  it('[positive] withSilverBrand(brandA) returns ONLY brand-A touchpoints, zero brand-B', async (ctx) => {
    if (!srAvailable || !martAvailable || !rawConn) return ctx.skip();
    const pool = poolFromConn(rawConn);

    const rows = await withSilverBrand(pool, BRAND_A, async (scope) =>
      scope.runScoped<{ brand_id: string }>(
        `SELECT brand_id FROM ${SEED_TABLE} WHERE \${BRAND_PREDICATE} AND brain_anon_id IN ('iso-fuzz-anon-a','iso-fuzz-anon-b')`,
      ),
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.brand_id).toBe(BRAND_A);
    expect(rows.some((r) => r.brand_id === BRAND_B)).toBe(false);
  });

  it('[mutation / NON-INERT proof] disabling the seam predicate MUST leak brand-B touchpoints', async (ctx) => {
    if (!srAvailable || !martAvailable || !rawConn) return ctx.skip();
    const pool = poolFromConn(rawConn);

    // Same logical read, asked for brand-A, but with predicate injection DISABLED.
    // If the predicate were inert (not doing the work), brand-B would still be excluded —
    // and THIS assertion would fail, exposing it.
    const leaked = await withSilverBrand(
      pool,
      BRAND_A,
      async (scope) =>
        scope.runScoped<{ brand_id: string }>(
          `SELECT brand_id FROM ${SEED_TABLE} WHERE \${BRAND_PREDICATE} AND brain_anon_id IN ('iso-fuzz-anon-a','iso-fuzz-anon-b')`,
        ),
      { __unsafeDisableBrandPredicate: true },
    );

    // The guard is PROVEN non-inert: without it, brand-B leaks.
    expect(leaked.some((r) => r.brand_id === BRAND_B)).toBe(true);
  });

  it('[documentation] engine-level row policy is the prod graduation (M1 step)', () => {
    // ALWAYS PASSES — documents the platform boundary honestly. Dev allin1 StarRocks has
    // NO CREATE ROW POLICY. M1 isolation = the withSilverBrand seam predicate, proven
    // non-inert by the mutation test above. Prod graduation: apply
    // db/starrocks/row_policy_template.sql on a managed cluster; the seam predicate then
    // becomes defense-in-depth behind the engine policy.
    expect('Silver journey isolation = app-seam predicate (non-inert); engine row policy = prod graduation').toBeTruthy();
  });
});
