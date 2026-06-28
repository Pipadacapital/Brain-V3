/**
 * ad-spend-metrics.live.test.ts — Live tests for the Track 3 spend/ROAS metrics.
 *
 * PHASE G — FULLY RE-POINTED TO THE LAKEHOUSE: computeAdSpendTimeseries / getAdSpendTimeseries /
 * computeBlendedRoas / getBlendedRoas all read brain_silver.silver_marketing_spend (+ gold_revenue_
 * ledger for the ROAS numerator) via withSilverBrand. The PG ad_spend_as_of() function is no longer a
 * production read path, so this test no longer seeds PG ad_spend_ledger or asserts the PG seam.
 *   - PG ad_spend_ledger remains the operational WRITE SoR (the repull jobs append there); its
 *     FORCE-RLS fail-closed isolation is covered by the dedicated stream-worker test
 *     spend-ledger-wiring.e2e.test.ts (AD4) — not re-proven here.
 *   (This is the deferred follow-up from the architecture-compliance refactor: "ad-spend-metrics.live
 *   still seeds PG spend — repoint to Silver". Done — reads + seeds are now Silver/lakehouse only.)
 *
 * Proves:
 *   1. LAKEHOUSE TOTAL (D-3): seed spend into Silver; the engine total is the exact BIGINT sum and the
 *      platform filter narrows correctly (no rounding).
 *   2. HONEST-EMPTY (D-2): zero Silver spend rows → state='no_data' (timeseries + blended-roas).
 *   3+4. CROSS-CURRENCY GUARD + honest spend=0→null: blended_roas over Silver/gold.
 *   5. ISOLATION (I-ST01): the Silver read seam (BRAND_PREDICATE → brand_id = ?) scopes BRAND_A's
 *      spend out for BRAND_B.
 *
 * REQUIRES: Postgres on localhost:5432 (brand fixtures) + Trino on :8090 over Iceberg with
 * brain_silver.silver_marketing_spend + brain_gold.gold_revenue_ledger (Spark-built). The lakehouse
 * sections SKIP if Trino is down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import {
  computeAdSpendTimeseries,
  computeBlendedRoas,
  createTrinoPool,
  type SilverPool,
} from '@brain/metric-engine';
import { getAdSpendTimeseries, getBlendedRoas } from '../index.js';
// MEDALLION REALIGNMENT (Epic 1): the measurement module was deleted with the PG ledger write path;
// billing_posted_period is a trivial 'YYYY-MM' derivation, inlined here.
function toBillingPostedPeriod(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
// BRAIN V4: StarRocks is REMOVED. The spend/ROAS reads run over TRINO (createTrinoPool) — the same
// Trino-over-Iceberg serving path the app uses in production. Seeds INSERT the base Iceberg tables;
// reads go through the brain_serving.mv_* views via the metric-engine seam.
const TRINO_URL =
  process.env['TRINO_URL'] ??
  `http://${process.env['TRINO_HOST'] ?? '127.0.0.1'}:${process.env['TRINO_PORT'] ?? '8090'}`;
const TRINO_USER = process.env['TRINO_USER'] ?? 'brain';

// Distinct UUID prefix (ad3) to avoid collision with other analytics test brands.
const BRAND_A = 'ad300a1a-0a1a-0a1a-0a1a-000000000001';
const BRAND_B = 'ad300a1a-0a1a-0a1a-0a1a-000000000002';

let superPool: pg.Pool;
let srPool: SilverPool;
let srUp = false;

function todayStr(): string {
  return new Date().toISOString().split('T')[0] as string;
}
function daysAgoStr(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
}

async function clearRevenue(brandId: string): Promise<void> {
  // MEDALLION REALIGNMENT (Epic 1): revenue is the lakehouse gold ledger now, not the PG ledger.
  if (srUp) await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [brandId]);
}
async function clearSpendSilver(brandId: string): Promise<void> {
  if (srUp) await srPool.query(`DELETE FROM brain_silver.silver_marketing_spend WHERE brand_id = ?`, [brandId]);
}

/** Seed a spend row into the lakehouse Silver entity (the sole re-pointed read source). */
async function seedSpendSilver(
  brandId: string,
  opts: { platform: 'meta' | 'google_ads'; levelId: string; statDate: string; spendMinor: bigint; currency: string },
): Promise<void> {
  if (!srUp) return;
  // Iceberg silver_marketing_spend: stat_date is `date` (the date-only `?` param renders as DATE '…');
  // occurred_at/updated_at are `timestamp` (no zone) → localtimestamp; spend_minor is bigint → pass the
  // bigint (a String() param would render as a quoted varchar that will not insert into a bigint column).
  await srPool.query(
    `INSERT INTO brain_silver.silver_marketing_spend
       (brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name,
        stat_date, spend_minor, currency_code, impressions, clicks, account_timezone, occurred_at, updated_at)
     VALUES (?, ?, ?, 'campaign', ?, NULL, ?, 'Test Campaign', ?, ?, ?, 1000, 50, 'Asia/Kolkata', localtimestamp, localtimestamp)`,
    [
      brandId,
      `${brandId}:${opts.platform}:${opts.levelId}:${opts.statDate}`,
      opts.platform,
      opts.levelId,
      opts.levelId,
      opts.statDate,
      opts.spendMinor,
      opts.currency,
    ],
  );
}

/** Seed a finalized realized row into the lakehouse ledger (blended-roas numerator source). */
async function seedRealizedSilver(brandId: string, amountMinor: bigint, currency: string): Promise<void> {
  if (!srUp) return;
  // amount_minor is bigint → pass the bigint (not String()); occurred_at/economic_effective_at/updated_at
  // are no-zone `timestamp` → localtimestamp; data_source is NOT NULL → 'live'.
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'finalization', ?, ?, 0, localtimestamp, localtimestamp, 'finalized', ?, 'live', localtimestamp)`,
    [brandId, `${brandId}:fin:${String(amountMinor)}:${currency}`, `order-${currency}`, amountMinor, currency, toBillingPostedPeriod(new Date())],
  );
}
async function clearRealizedSilver(brandId: string): Promise<void> {
  if (srUp) await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [brandId]);
}

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  await superPool.query('SELECT 1');

  try {
    srPool = createTrinoPool({ baseUrl: TRINO_URL, user: TRINO_USER, catalog: 'iceberg' });
    await srPool.query('SELECT 1');
    srUp = true;
  } catch {
    srUp = false;
  }

  const existingOrg = await superPool.query<{ id: string }>(`SELECT id FROM organization LIMIT 1`);
  const useOrgId = existingOrg.rows[0]?.id ?? 'ffffffff-0000-0000-0000-000000000001';

  for (const id of [BRAND_A, BRAND_B]) {
    await superPool.query(
      `INSERT INTO brand (id, organization_id, display_name, currency_code, status)
       VALUES ($1, $2, 'Ad Spend Test Brand', 'INR', 'active')
       ON CONFLICT (id) DO UPDATE SET currency_code = 'INR', status = 'active'`,
      [id, useOrgId],
    );
  }
  await clearRevenue(BRAND_A);
  await clearRevenue(BRAND_B);
  await clearSpendSilver(BRAND_A);
  await clearSpendSilver(BRAND_B);
});

afterAll(async () => {
  await clearRevenue(BRAND_A);
  await clearRevenue(BRAND_B);
  await clearSpendSilver(BRAND_A);
  await clearSpendSilver(BRAND_B);
  await superPool.query(`DELETE FROM brand WHERE id IN ($1, $2)`, [BRAND_A, BRAND_B]).catch(() => {});
  await superPool.end().catch(() => {});
  // The Trino pool is a stateless HTTP adapter — no connection to close.
});

// ── 1. LAKEHOUSE TOTAL — engine SUM is exact bigint + platform filter (D-3) ──

describe('1. lakehouse spend total — exact bigint + platform filter (D-3)', () => {
  const from = daysAgoStr(10);
  const to = todayStr();

  beforeAll(async () => {
    await clearSpendSilver(BRAND_A);
    const rows = [
      { platform: 'meta' as const, levelId: 'c1', statDate: daysAgoStr(5), spendMinor: 100000n, currency: 'INR' },
      { platform: 'meta' as const, levelId: 'c2', statDate: daysAgoStr(3), spendMinor: 50000n, currency: 'INR' },
      { platform: 'google_ads' as const, levelId: 'g1', statDate: daysAgoStr(2), spendMinor: 30000n, currency: 'INR' },
    ];
    for (const r of rows) await seedSpendSilver(BRAND_A, r);
  });
  afterAll(async () => { await clearSpendSilver(BRAND_A); });

  it('engine(lakehouse) timeseries total == exact seeded SUM (no rounding)', async () => {
    if (!srUp) return;
    const buckets = await computeAdSpendTimeseries(
      BRAND_A,
      { fromDate: new Date(`${from}T00:00:00Z`), toDate: new Date(`${to}T00:00:00Z`), grain: 'day' },
      { srPool: srPool as unknown as SilverPool },
    );
    const engineTotal = buckets.reduce((acc, b) => acc + b.spendMinor, 0n);
    expect(engineTotal).toBe(180000n); // 100000 + 50000 + 30000, exact BIGINT
  });

  it('getAdSpendTimeseries (BFF use-case) total matches engine — same exact bigint', async () => {
    if (!srUp) return;
    const result = await getAdSpendTimeseries(
      BRAND_A,
      { fromDate: new Date(`${from}T00:00:00Z`), toDate: new Date(`${to}T00:00:00Z`), grain: 'day' },
      { srPool: srPool as unknown as SilverPool },
    );
    expect(result.state).toBe('has_data');
    if (result.state === 'has_data') {
      const total = result.buckets.reduce((acc, b) => acc + BigInt(b.spend_minor), 0n);
      expect(total).toBe(180000n);
      // platform filter narrows correctly
      const metaOnly = await getAdSpendTimeseries(
        BRAND_A,
        { fromDate: new Date(`${from}T00:00:00Z`), toDate: new Date(`${to}T00:00:00Z`), grain: 'day', platform: 'meta' },
        { srPool: srPool as unknown as SilverPool },
      );
      if (metaOnly.state === 'has_data') {
        const metaTotal = metaOnly.buckets.reduce((acc, b) => acc + BigInt(b.spend_minor), 0n);
        expect(metaTotal).toBe(150000n);
        expect(metaOnly.buckets.every((b) => b.platform === 'meta')).toBe(true);
      }
    }
  });
});

// ── 2. HONEST-EMPTY (D-2) ────────────────────────────────────────────────────

describe('2. honest-empty — zero spend rows → no_data', () => {
  beforeAll(async () => { await clearSpendSilver(BRAND_A); await clearRevenue(BRAND_A); await clearRealizedSilver(BRAND_A); });

  it('ad-spend-timeseries with no lakehouse rows → state=no_data', async () => {
    if (!srUp) return;
    const result = await getAdSpendTimeseries(
      BRAND_A,
      { fromDate: new Date(`${daysAgoStr(10)}T00:00:00Z`), toDate: new Date(`${todayStr()}T00:00:00Z`), grain: 'day' },
      { srPool: srPool as unknown as SilverPool },
    );
    expect(result.state).toBe('no_data');
  });

  it('blended-roas with no spend → state=no_data (no denominator → honest)', async () => {
    if (!srUp) return;
    // Even with realized revenue present, no spend means no ROAS (no_data driven by spend EXISTS).
    await seedRealizedSilver(BRAND_A, 500000n, 'INR');
    const result = await getBlendedRoas(
      BRAND_A,
      { fromDate: new Date(`${daysAgoStr(10)}T00:00:00Z`), toDate: new Date(`${todayStr()}T00:00:00Z`) },
      { srPool: srPool as unknown as SilverPool },
    );
    expect(result.state).toBe('no_data');
    await clearRealizedSilver(BRAND_A);
  });
});

// ── 3 + 4. BLENDED ROAS: same-currency-only + honest spend=0→null (lakehouse) ──

describe('3+4. blended_roas — same-currency-only + honest spend=0→null', () => {
  const from = daysAgoStr(10);
  const to = todayStr();

  beforeAll(async () => {
    await clearSpendSilver(BRAND_A);
    await clearRealizedSilver(BRAND_A);
    // realized: INR 5000.00 finalized (brand currency = INR) — lakehouse ledger
    await seedRealizedSilver(BRAND_A, 500000n, 'INR');
    // spend: INR 100000 (paise) + USD 20000 (cents) — two currencies, must NOT blend
    await seedSpendSilver(BRAND_A, { platform: 'meta', levelId: 'inr1', statDate: daysAgoStr(4), spendMinor: 100000n, currency: 'INR' });
    await seedSpendSilver(BRAND_A, { platform: 'google_ads', levelId: 'usd1', statDate: daysAgoStr(3), spendMinor: 20000n, currency: 'USD' });
  });
  afterAll(async () => { await clearSpendSilver(BRAND_A); await clearRealizedSilver(BRAND_A); });

  it('produces per-currency rows; INR row has realized+spend, USD row has spend only', async () => {
    if (!srUp) return;
    const result = await getBlendedRoas(
      BRAND_A,
      { fromDate: new Date(`${from}T00:00:00Z`), toDate: new Date(`${to}T00:00:00Z`) },
      { srPool: srPool as unknown as SilverPool },
    );
    expect(result.state).toBe('has_data');
    if (result.state === 'has_data') {
      const inr = result.rows.find((r) => r.currency_code === 'INR');
      const usd = result.rows.find((r) => r.currency_code === 'USD');
      expect(inr).toBeDefined();
      expect(usd).toBeDefined();

      // INR: realized 500000 / spend 100000 = 5.0000 (exact ratio, same currency)
      expect(inr!.realized_minor).toBe('500000');
      expect(inr!.spend_minor).toBe('100000');
      expect(inr!.roas_ratio).toBe('5.0000');

      // USD: realized is on INR side only (brand currency=INR) → USD realized=0,
      // spend=20000 → ratio 0.0000 (NEVER realized(INR)/spend(USD) cross-blend).
      expect(usd!.realized_minor).toBe('0');
      expect(usd!.spend_minor).toBe('20000');
      expect(usd!.roas_ratio).toBe('0.0000');
      // The cross-currency guard: USD realized is NOT the INR realized leaking across.
      expect(usd!.realized_minor).not.toBe('500000');
    }
  });

  it('engine: a currency with spend=0 reports roasRatio=null (honest, no divide-by-zero)', async () => {
    if (!srUp) return;
    // Direct engine probe — fabricate a window where INR has realized but spend lands
    // outside the window for INR (so INR spend=0 inside window).
    const rows = await computeBlendedRoas(
      BRAND_A,
      // window that EXCLUDES the seeded spend dates (future window) → spend=0 everywhere
      { fromDate: new Date(`${daysAgoStr(1)}T00:00:00Z`), toDate: new Date(`${todayStr()}T00:00:00Z`) },
      { srPool: srPool as unknown as SilverPool },
    );
    // No spend in this narrow window → every row (if any) has spend=0 → roasRatio null.
    for (const r of rows) {
      if (r.spendMinor === 0n) expect(r.roasRatio).toBeNull();
    }
  });
});

// ── 5. ISOLATION — Silver read-seam scoping (I-ST01) ──────────────────────────

describe('5. isolation — cross-brand spend invisible via the Silver read seam', () => {
  beforeAll(async () => {
    await clearSpendSilver(BRAND_A);
    await clearSpendSilver(BRAND_B);
    await seedSpendSilver(BRAND_A, { platform: 'meta', levelId: 'iso1', statDate: daysAgoStr(2), spendMinor: 777000n, currency: 'INR' });
  });
  afterAll(async () => { await clearSpendSilver(BRAND_A); await clearSpendSilver(BRAND_B); });

  it('BRAND_A spend visible to BRAND_A (positive control), invisible to BRAND_B (Silver seam)', async () => {
    if (!srUp) return;
    const a = await getAdSpendTimeseries(
      BRAND_A,
      { fromDate: new Date(`${daysAgoStr(10)}T00:00:00Z`), toDate: new Date(`${todayStr()}T00:00:00Z`), grain: 'day' },
      { srPool: srPool as unknown as SilverPool },
    );
    const b = await getAdSpendTimeseries(
      BRAND_B,
      { fromDate: new Date(`${daysAgoStr(10)}T00:00:00Z`), toDate: new Date(`${todayStr()}T00:00:00Z`), grain: 'day' },
      { srPool: srPool as unknown as SilverPool },
    );
    expect(a.state).toBe('has_data'); // positive control: BRAND_A sees its own spend
    expect(b.state).toBe('no_data'); // BRAND_PREDICATE (brand_id = ?) scopes BRAND_A's rows out for BRAND_B
  });
});
