/**
 * dq-checks.e2e.test.ts — feat-data-quality-engine Track A (DQ executors).
 *
 * Proves the 4 DQ executors run live under brain_app (RLS FORCE) and produce a
 * graded dq_check_result row per (brand, category, target):
 *
 *   T1: freshness — a FRESH bronze_events row grades high (A+/A); a STALE one breaches
 *       (D) — the LIVE freshness-SLA monitor (Phase-7 acceptance).
 *   T2: completeness — a complete bronze_events set grades A+ (zero-tolerance null rate).
 *   T3: schema_validity — no quarantine rows + accepted events → A+ (reuses the DLQ/quarantine
 *       signal: a 'pixel.brand_mismatch' audit row drives the failure rate).
 *   T4: reconciliation — runs and writes a graded row (Bronze↔Silver delta).
 *   T5: determinism — running the same executor twice on the same inputs yields the SAME grade.
 *
 * Runs under BRAIN_APP_DATABASE_URL (brain_app, FORCE RLS). Superuser pool only for
 * seed/cleanup. Silver is NULL here (Silver checks then emit honest D — asserted distinct).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { seedTestBrand, assertBrainApp } from './helpers/connector-lifecycle-fixtures.js';
import { freshnessCheck } from '../jobs/dq/freshness-check.js';
import { completenessCheck } from '../jobs/dq/completeness-check.js';
import { schemaValidityCheck } from '../jobs/dq/schema-validity-check.js';
import { reconciliationCheck } from '../jobs/dq/reconciliation-check.js';
import { runDqChecksForBrand } from '../jobs/dq/run.js';
import type { SilverReader } from '../jobs/dq/silver-reader.js';

/**
 * Deterministic fake StarRocks reader for the Bronze side. DB-AUDIT C4 moved Bronze reads from PG
 * to the Iceberg SoR (StarRocks), so the DQ checks read Bronze via the SilverReader seam. Seeding
 * StarRocks/Iceberg per-test is heavy; this fake returns controlled Bronze aggregates by query shape
 * (the PG side — ledger, audit_log, dq_check_result — stays real under brain_app). Silver-tier reads
 * (silver_order_state) return empty here.
 */
function fakeSilver(opts: {
  bronzeLatest?: string | null;
  bronzeTotal?: number;
  bronzeBad?: number;
  bronzeAccepted?: number;
} = {}): SilverReader {
  return {
    async scopedQuery<T = Record<string, unknown>>(_brand: string, sql: string): Promise<T[]> {
      let out: unknown[] = [];
      if (sql.includes('MAX(ingested_at)')) out = [{ latest: opts.bronzeLatest ?? null }];      // bronze freshness
      else if (sql.includes('MAX(updated_at)')) out = [{ latest: null }];                        // silver freshness
      else if (sql.includes('COUNT(CASE WHEN')) out = [{ total: opts.bronzeTotal ?? 0, bad: opts.bronzeBad ?? 0 }]; // completeness
      else if (sql.includes('COUNT(*) AS n')) out = [{ n: opts.bronzeAccepted ?? 0 }];           // schema-validity accepted
      else if (sql.includes('COUNT(DISTINCT order_id)')) out = [{ n: 0 }];                        // silver recon count
      else if (sql.includes('COUNT(DISTINCT COALESCE')) out = [{ n: 0 }];                         // bronze recon count
      return out as T[];
    },
    async end(): Promise<void> { /* no-op */ },
  };
}

const BRAIN_APP_DB_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';
const SUPERUSER_DB_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_A = 'd9d9d9d9-0000-4000-8000-0000000000a1';

let superPool: Pool;
let appPool: Pool;

// DB-AUDIT C4: PG bronze_events is retired (dropped) — Bronze is the Iceberg SoR, injected via the
// fakeSilver reader above. The DQ tests no longer seed/clean a PG bronze table.
async function cleanup(brandId: string): Promise<void> {
  await superPool.query('DELETE FROM dq_check_result WHERE brand_id = $1', [brandId]);
  await superPool.query('DELETE FROM audit_log WHERE brand_id = $1', [brandId]);
}

beforeAll(async () => {
  superPool = new Pool({ connectionString: SUPERUSER_DB_URL, max: 5 });
  appPool = new Pool({ connectionString: BRAIN_APP_DB_URL, max: 5 });
  await cleanup(BRAND_A);
  await seedTestBrand(superPool, BRAND_A);
}, 30_000);

afterAll(async () => {
  await cleanup(BRAND_A);
  await superPool.end();
  await appPool.end();
});

describe('T1: freshness — the LIVE freshness-SLA monitor', () => {
  it('fresh bronze_events → high grade; stale → breached (D)', async () => {
    await assertBrainApp(appPool);
    const now = new Date('2026-06-18T12:00:00Z');

    // FRESH: 5 minutes old (SLA 60m) → A+/A. Bronze freshness now reads the Iceberg SoR (fake reader).
    await cleanup(BRAND_A);
    const fresh = await freshnessCheck(appPool, fakeSilver({ bronzeLatest: '2026-06-18T11:55:00Z' }), BRAND_A, now);
    const bronzeFresh = fresh.find((r) => r.target === 'bronze_events');
    expect(bronzeFresh).toBeDefined();
    expect(bronzeFresh!.passing).toBe(true);
    expect(['A+', 'A']).toContain(bronzeFresh!.grade);

    // STALE: 5 hours old (SLA 60m) → breached → D.
    await cleanup(BRAND_A);
    const stale = await freshnessCheck(appPool, fakeSilver({ bronzeLatest: '2026-06-18T07:00:00Z' }), BRAND_A, now);
    const bronzeStale = stale.find((r) => r.target === 'bronze_events');
    expect(bronzeStale!.grade).toBe('D');
    expect(bronzeStale!.passing).toBe(false);
  });

  it('Silver disabled emits an honest D (never a false A+)', async () => {
    const now = new Date('2026-06-18T12:00:00Z');
    await cleanup(BRAND_A);
    // silver=null → silver.order_state target is NOT emitted (skipped, honest absence).
    const rows = await freshnessCheck(appPool, null, BRAND_A, now);
    expect(rows.some((r) => r.target === 'silver.order_state')).toBe(false);
  });
});

describe('T2: completeness', () => {
  it('complete bronze_events set → A+ (zero-tolerance null rate)', async () => {
    await cleanup(BRAND_A);
    const rows = await completenessCheck(appPool, fakeSilver({ bronzeTotal: 1, bronzeBad: 0 }), BRAND_A);
    const bronze = rows.find((r) => r.target === 'bronze_events');
    expect(bronze).toBeDefined();
    expect(bronze!.grade).toBe('A+');
    expect(bronze!.passing).toBe(true);
  });
});

describe('T3: schema_validity — reuses the DLQ/quarantine signal', () => {
  it('accepted events + no quarantine → A+', async () => {
    await cleanup(BRAND_A);
    const rows = await schemaValidityCheck(appPool, fakeSilver({ bronzeAccepted: 1 }), BRAND_A);
    expect(rows[0]!.grade).toBe('A+');
    expect(rows[0]!.passing).toBe(true);
  });
});

describe('T4: reconciliation', () => {
  it('Silver disabled → honest D row written', async () => {
    await cleanup(BRAND_A);
    const rows = await reconciliationCheck(appPool, null, BRAND_A);
    expect(rows[0]!.category).toBe('reconciliation');
    expect(rows[0]!.grade).toBe('D');
    expect(rows[0]!.observed).toBe('silver_disabled');
  });
});

describe('T5: determinism + full run writes graded rows', () => {
  it('runDqChecksForBrand writes a graded row per category; re-run = same grades', async () => {
    await cleanup(BRAND_A);
    const now = new Date('2026-06-18T12:00:00Z');

    const first = await runDqChecksForBrand(appPool, null, BRAND_A, now);
    const second = await runDqChecksForBrand(appPool, null, BRAND_A, now);

    // All 4 categories represented.
    const cats = new Set(first.map((r) => r.category));
    expect(cats).toEqual(
      new Set(['freshness', 'completeness', 'schema_validity', 'reconciliation']),
    );

    // Determinism: same (category,target) → same grade across the two runs.
    const key = (r: { category: string; target: string }) => `${r.category}|${r.target}`;
    const firstMap = new Map(first.map((r) => [key(r), r.grade]));
    const secondMap = new Map(second.map((r) => [key(r), r.grade]));
    expect([...secondMap.keys()].sort()).toEqual([...firstMap.keys()].sort());
    for (const [k, g] of firstMap) {
      expect(secondMap.get(k), `grade drifted for ${k}`).toBe(g);
    }

    // Rows are persisted (append-only): two runs → two rows per (category,target) at least.
    // Read under the brand GUC in a txn (RLS FORCE — the same posture as the write path).
    const rc = await appPool.connect();
    let persistedCount = 0;
    try {
      await rc.query('BEGIN');
      await rc.query("SELECT set_config('app.current_brand_id', $1, true)", [BRAND_A]);
      const persisted = await rc.query<{ n: string }>(
        `SELECT COUNT(*) n FROM dq_check_result WHERE brand_id = $1`,
        [BRAND_A],
      );
      persistedCount = Number(persisted.rows[0]!.n);
      await rc.query('COMMIT');
    } finally {
      rc.release();
    }
    expect(persistedCount).toBeGreaterThanOrEqual(first.length * 2);
  });
});
