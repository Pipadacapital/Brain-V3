/**
 * revenue-metrics.live.test.ts — live tests for the Analytics revenue snapshot (Track A).
 *
 * PHASE G follow-up re-point: the DASHBOARD revenue snapshot now reads the LAKEHOUSE gold ledger
 * (brain_gold.gold_revenue_ledger) via withSilverBrand — computeRealizedRevenue / computeProvisionalRevenue
 * / getRevenueMetrics all take { srPool } and read StarRocks, NOT PG realized_revenue_ledger. (PG remains
 * the source for BILLING — seal-billing-period reads billing.realized_revenue_ledger directly; invoicing
 * must seal off the write SoR, never a lagged copy.) So this suite seeds the gold mart and passes srPool.
 *
 * Invariants proven (unchanged in spirit):
 *   1. engine==use-case exact-bigint (sole-read-path, D-3): the snapshot.realized equals the engine map.
 *   2. honest-empty-state (D-2): zero gold rows → no_data; provisional-only → has_data + realized {ccy:'0'}.
 *   3. isolation: gold rows seeded for BRAND_A are invisible to BRAND_B (Silver seam BRAND_PREDICATE).
 *   4. provisional shown separately (D-4): realized excludes provisional; never blended.
 *   5. as_of filtering: rows after as_of are excluded from realized (existence still → has_data).
 *   6. structural: no ad-hoc SUM(amount_minor) in the analytics module (D-3).
 *
 * REQUIRES: duckdb-serving-over-Iceberg on :8091 with brain_gold.gold_revenue_ledger. Lakehouse sections SKIP if down.
 *
 * BRAIN V4: StarRocks and Trino are REMOVED (ADR-0014). The revenue snapshot reads the gold ledger over DUCKDB-SERVING (createDuckDbServingPool)
 * — the same duckdb-serving-over-Iceberg serving path the app uses in production. Seeds INSERT the base Iceberg
 * table; the reader reads through the brain_serving.mv_* view via the metric-engine seam.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { computeRealizedRevenue, createDuckDbServingPool, type SilverPool } from '@brain/metric-engine';
import { getRevenueMetrics } from '../index.js';

const SERVING_URL =
  process.env['DUCKDB_SERVING_URL'] ??
  `http://${process.env['DUCKDB_SERVING_HOST'] ?? '127.0.0.1'}:${process.env['DUCKDB_SERVING_PORT'] ?? '8091'}`;

// Deterministic test brand UUIDs (analytics-specific; aa10 prefix avoids collision with other suites).
const BRAND_A = 'aa100a1a-0a1a-0a1a-0a1a-000000000001';
const BRAND_B = 'aa100a1a-0a1a-0a1a-0a1a-000000000002';

let srPool: SilverPool;
let srUp = false;
const deps = () => ({ srPool });

// ── Helpers — seed the lakehouse gold ledger directly ───────────────────────────

async function clearGold(brandId: string): Promise<void> {
  if (srUp) await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [brandId]);
}

// Iceberg gold_revenue_ledger: occurred_at/economic_effective_at/updated_at are `timestamp` (no zone) →
// `localtimestamp` (the engine's no-zone now; `now()`/current_timestamp are zoned and would not coerce).
// data_source is NOT NULL → seed 'live' explicitly (StarRocks defaulted it; Iceberg enforces it).

/** Seed a finalized (realized) row into the gold ledger, economic_effective_at = localtimestamp. */
async function seedFinalizedRow(brandId: string, amountMinor: bigint): Promise<void> {
  if (!srUp) return;
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'finalization', ?, 'INR', 0, localtimestamp, localtimestamp, 'finalized', '2026-06', 'live', localtimestamp)`,
    [brandId, randomUUID(), `order-${randomUUID()}`, amountMinor],
  );
}

/** Seed a provisional row into the gold ledger, economic_effective_at = localtimestamp. */
async function seedProvisionalRow(brandId: string, amountMinor: bigint): Promise<void> {
  if (!srUp) return;
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'provisional_recognition', ?, 'INR', 0, localtimestamp, localtimestamp, 'provisional', '2026-06', 'live', localtimestamp)`,
    [brandId, randomUUID(), `order-prov-${randomUUID()}`, amountMinor],
  );
}

beforeAll(async () => {
  try {
    srPool = createDuckDbServingPool({ baseUrl: SERVING_URL });
    await srPool.query('SELECT 1');
    srUp = true;
  } catch {
    srUp = false;
  }
  await clearGold(BRAND_A);
  await clearGold(BRAND_B);
});

afterAll(async () => {
  await clearGold(BRAND_A);
  await clearGold(BRAND_B);
  // The serving pool is a stateless HTTP adapter — no connection to close.
});

// ── 1. engine==use-case exact-bigint (sole-read-path, D-3) ──────────────────────

describe('1. engine==use-case exact-bigint — sole-read-path (D-3)', () => {
  const SALE_AMOUNT = 123450n; // INR 1234.50 in paise
  const asOf = new Date();

  beforeAll(async () => { await clearGold(BRAND_A); await seedFinalizedRow(BRAND_A, SALE_AMOUNT); });
  afterAll(async () => { await clearGold(BRAND_A); });

  it('computeRealizedRevenue (engine) returns the seeded amount', async () => {
    if (!srUp) return;
    const engineMap = await computeRealizedRevenue(BRAND_A, asOf, deps());
    expect(engineMap.get('INR')).toBe(SALE_AMOUNT);
  });

  it('getRevenueMetrics.realized[INR] === String(engine.get(INR)) — exact, has_data', async () => {
    if (!srUp) return;
    const engineMap = await computeRealizedRevenue(BRAND_A, asOf, deps());
    const snapshot = await getRevenueMetrics(BRAND_A, asOf, deps());
    expect(snapshot.state).toBe('has_data');
    expect(snapshot.realized).not.toBeNull();
    if (snapshot.realized !== null) {
      expect(snapshot.realized['INR']).toBe(String(engineMap.get('INR')));
      expect(snapshot.realized['INR']).toBe(String(SALE_AMOUNT));
    }
  });
});

// ── 2. honest-empty-state (D-2) ────────────────────────────────────────────────

describe('2. honest-empty-state — provisional-only → has_data; zero rows → no_data (D-2)', () => {
  const PROVISIONAL_AMOUNT = 99999n;

  beforeAll(async () => { await clearGold(BRAND_A); await seedProvisionalRow(BRAND_A, PROVISIONAL_AMOUNT); });
  afterAll(async () => { await clearGold(BRAND_A); });

  it('provisional-only → state=has_data, realized={INR:"0"} (honest zero)', async () => {
    if (!srUp) return;
    const snapshot = await getRevenueMetrics(BRAND_A, new Date(), deps());
    expect(snapshot.state).toBe('has_data');
    expect(snapshot.realized).toEqual({ INR: '0' });
  });

  it('provisional-only → provisional carries the seeded amount', async () => {
    if (!srUp) return;
    const snapshot = await getRevenueMetrics(BRAND_A, new Date(), deps());
    expect(snapshot.provisional).toEqual({ INR: String(PROVISIONAL_AMOUNT) });
  });

  it('completely empty brand (zero gold rows) → state=no_data', async () => {
    if (!srUp) return;
    await clearGold(BRAND_A);
    const snapshot = await getRevenueMetrics(BRAND_A, new Date(), deps());
    expect(snapshot.state).toBe('no_data');
    expect(snapshot.realized).toBeNull();
    expect(snapshot.provisional).toBeNull();
  });
});

// ── 3. isolation — BRAND_A gold rows invisible to BRAND_B (Silver seam BRAND_PREDICATE) ──

describe('3. isolation — cross-brand invisible at the Silver seam', () => {
  const BRAND_A_AMOUNT = 777000n;

  beforeAll(async () => {
    await clearGold(BRAND_A); await clearGold(BRAND_B);
    await seedFinalizedRow(BRAND_A, BRAND_A_AMOUNT);
  });
  afterAll(async () => { await clearGold(BRAND_A); await clearGold(BRAND_B); });

  it('BRAND_A visible to BRAND_A (positive control)', async () => {
    if (!srUp) return;
    const snapshot = await getRevenueMetrics(BRAND_A, new Date(), deps());
    expect(snapshot.state).toBe('has_data');
    expect(snapshot.realized?.['INR']).toBe(String(BRAND_A_AMOUNT));
  });

  it('BRAND_A invisible to BRAND_B → no_data (seam scopes brand_id = ?)', async () => {
    if (!srUp) return;
    const snapshot = await getRevenueMetrics(BRAND_B, new Date(), deps());
    expect(snapshot.state).toBe('no_data');
    expect(snapshot.realized).toBeNull();
  });

  it('BRAND_B result does NOT carry BRAND_A value', async () => {
    if (!srUp) return;
    const a = await getRevenueMetrics(BRAND_A, new Date(), deps());
    const b = await getRevenueMetrics(BRAND_B, new Date(), deps());
    expect(a.state).toBe('has_data');
    expect(b.state).toBe('no_data');
    if (a.realized !== null) expect(b.realized).not.toEqual(a.realized);
  });
});

// ── 4. provisional shown separately — never blended with realized (D-4) ─────────

describe('4. provisional shown separately — never blended (D-4)', () => {
  const FINALIZED_AMOUNT = 500000n;
  const PROVISIONAL_AMOUNT = 75000n;

  beforeAll(async () => {
    await clearGold(BRAND_A);
    await seedFinalizedRow(BRAND_A, FINALIZED_AMOUNT);
    await seedProvisionalRow(BRAND_A, PROVISIONAL_AMOUNT);
  });
  afterAll(async () => { await clearGold(BRAND_A); });

  it('realized = finalized only; provisional = provisional only; never summed', async () => {
    if (!srUp) return;
    const snapshot = await getRevenueMetrics(BRAND_A, new Date(), deps());
    expect(snapshot.state).toBe('has_data');
    expect(snapshot.realized?.['INR']).toBe(String(FINALIZED_AMOUNT));
    expect(snapshot.provisional?.['INR']).toBe(String(PROVISIONAL_AMOUNT));
    // Never blended (D-4): realized is NOT the sum of both.
    expect(snapshot.realized?.['INR']).not.toBe(String(FINALIZED_AMOUNT + PROVISIONAL_AMOUNT));
    expect(snapshot.realized?.['INR']).not.toBe(snapshot.provisional?.['INR']);
  });
});

// ── 5. as_of filtering ─────────────────────────────────────────────────────────

describe('5. as_of — rows after as_of excluded from realized (existence still → has_data)', () => {
  const AMOUNT = 200000n;

  beforeAll(async () => { await clearGold(BRAND_A); await seedFinalizedRow(BRAND_A, AMOUNT); });
  afterAll(async () => { await clearGold(BRAND_A); });

  it('as_of=today → seeded row included', async () => {
    if (!srUp) return;
    const snapshot = await getRevenueMetrics(BRAND_A, new Date(), deps());
    expect(snapshot.state).toBe('has_data');
    expect(snapshot.realized?.['INR']).toBe(String(AMOUNT));
  });

  it('as_of=past (before the row) → has_data via existence, realized excluded → {INR:"0"}', async () => {
    if (!srUp) return;
    const snapshot = await getRevenueMetrics(BRAND_A, new Date('2025-01-01T00:00:00Z'), deps());
    // Existence (no date filter) → has_data; realized sum over ≤ as_of excludes the today-row → 0.
    expect(snapshot.state).toBe('has_data');
    expect(snapshot.realized).toEqual({ INR: '0' });
  });
});

// ── 6. structural: no ad-hoc SUM(amount_minor) in the analytics module (D-3) ────

describe('6. structural: no SUM(amount_minor) in analytics module (D-3)', () => {
  it('grep: analytics module source files contain no ad-hoc SUM(amount_minor)', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const analyticsDir = path.resolve(process.cwd(), 'src/modules/analytics');

    async function scanDir(dir: string): Promise<string[]> {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && e.name !== 'tests') files.push(...(await scanDir(full)));
        else if (e.isFile() && e.name.endsWith('.ts') && !e.name.includes('.test.')) files.push(full);
      }
      return files;
    }

    const tsFiles = await scanDir(analyticsDir);
    const violatingLines: string[] = [];
    for (const file of tsFiles) {
      const lines = (await readFile(file, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
        if (/SUM\s*\(\s*amount_minor\s*\)/i.test(line)) violatingLines.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(violatingLines).toHaveLength(0);
  });
});
