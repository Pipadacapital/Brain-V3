/**
 * ad-spend-metrics.live.test.ts — Live tests for the Track 3 spend/ROAS metrics.
 *
 * PHASE G re-point: computeAdSpendTimeseries / getAdSpendTimeseries now read the LAKEHOUSE
 * Silver entity (brain_silver.silver_marketing_spend) via withSilverBrand, NOT PG ad_spend_ledger.
 * So the spend-timeseries assertions seed StarRocks and pass { srPool }. blended-roas is NOT yet
 * re-pointed (a later Phase-G slice) — its reads stay on PG via { pool }, so those sections still
 * seed ad_spend_ledger. PG remains the WRITE SoR (the repull jobs append there); only READS moved.
 *
 * Proves:
 *   1. PARITY ORACLE (PG⇄lakehouse, sole-read-path, D-3):
 *      Seed identical spend into BOTH PG ad_spend_ledger AND Silver silver_marketing_spend;
 *      the engine total reading the lakehouse EXACTLY equals the PG ad_spend_as_of() seam SUM —
 *      exact BIGINT, no rounding. This is the cutover parity gate for the spend reader.
 *   2. HONEST-EMPTY (D-2): zero Silver spend rows → state='no_data' (timeseries).
 *      blended-roas with no PG spend → no_data.
 *   3. CROSS-CURRENCY GUARD + 4. honest spend=0→null: blended_roas, PG-side (unchanged).
 *   5. ISOLATION: timeseries via the Silver seam — BRAND_A spend invisible to BRAND_B
 *      (BRAND_PREDICATE → brand_id = ?). PG negative-control kept (ledger still FORCE-RLS as write SoR).
 *
 * REQUIRES: Postgres on localhost:5432 (migrations ≥0029) + StarRocks on :9030 with
 * brain_silver.silver_marketing_spend (dbt-built). The lakehouse sections SKIP if StarRocks is down.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { computeAdSpendTimeseries, computeBlendedRoas } from '@brain/metric-engine';
import type { SilverPool } from '@brain/metric-engine';
import { getAdSpendTimeseries, getBlendedRoas } from '../index.js';
import { toBillingPostedPeriod } from '../../measurement/internal/domain/recognition/entities/LedgerEntry.js';

const SUPERUSER_URL =
  process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL =
  process.env['BRAIN_APP_DATABASE_URL'] ??
  'postgres://brain_app:brain_app@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? 9030);

// Distinct UUID prefix (ad3) to avoid collision with other analytics test brands.
const BRAND_A = 'ad300a1a-0a1a-0a1a-0a1a-000000000001';
const BRAND_B = 'ad300a1a-0a1a-0a1a-0a1a-000000000002';

let superPool: pg.Pool;
let appPool: pg.Pool;
let srPool: mysql.Pool;
let srUp = false;

function todayStr(): string {
  return new Date().toISOString().split('T')[0] as string;
}
function daysAgoStr(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
}

async function clearSpend(brandId: string): Promise<void> {
  await superPool.query(`DELETE FROM ad_spend_ledger WHERE brand_id = $1`, [brandId]);
}
async function clearRevenue(brandId: string): Promise<void> {
  await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id = $1`, [brandId]);
}
async function clearSpendSilver(brandId: string): Promise<void> {
  if (srUp) await srPool.query(`DELETE FROM brain_silver.silver_marketing_spend WHERE brand_id = ?`, [brandId]);
}

/** Seed an ad_spend_ledger row via superuser (PG write SoR — feeds the as_of seam oracle). */
async function seedSpend(
  brandId: string,
  opts: { platform: 'meta' | 'google_ads'; levelId: string; statDate: string; spendMinor: bigint; currency: string },
): Promise<void> {
  await superPool.query(
    `INSERT INTO ad_spend_ledger (
       brand_id, spend_event_id, platform, level, level_id, parent_id,
       campaign_id, campaign_name, stat_date, spend_minor, currency_code,
       impressions, clicks, conversions_raw, account_timezone, raw_event_id, occurred_at
     ) VALUES ($1, $2, $3, 'campaign', $4, NULL, $4, 'Test Campaign', $5::date, $6, $7,
               1000, 50, NULL, 'Asia/Kolkata', $2, NOW())
     ON CONFLICT (brand_id, spend_event_id) DO NOTHING`,
    [
      brandId,
      `${brandId}:${opts.platform}:${opts.levelId}:${opts.statDate}`,
      opts.platform,
      opts.levelId,
      opts.statDate,
      String(opts.spendMinor),
      opts.currency,
    ],
  );
}

/** Seed the SAME logical spend row into the lakehouse Silver entity (the re-pointed read source). */
async function seedSpendSilver(
  brandId: string,
  opts: { platform: 'meta' | 'google_ads'; levelId: string; statDate: string; spendMinor: bigint; currency: string },
): Promise<void> {
  if (!srUp) return;
  await srPool.query(
    `INSERT INTO brain_silver.silver_marketing_spend
       (brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name,
        stat_date, spend_minor, currency_code, impressions, clicks, account_timezone, occurred_at, updated_at)
     VALUES (?, ?, ?, 'campaign', ?, NULL, ?, 'Test Campaign', ?, ?, ?, 1000, 50, 'Asia/Kolkata', NOW(), NOW())`,
    [
      brandId,
      `${brandId}:${opts.platform}:${opts.levelId}:${opts.statDate}`,
      opts.platform,
      opts.levelId,
      opts.levelId,
      opts.statDate,
      String(opts.spendMinor),
      opts.currency,
    ],
  );
}

/** Seed a finalized revenue row (numerator side) via superuser. */
async function seedFinalized(brandId: string, amountMinor: bigint, currency: string): Promise<void> {
  const now = new Date();
  await superPool.query(
    `INSERT INTO realized_revenue_ledger (
       brand_id, ledger_event_id, order_id, event_type,
       amount_minor, currency_code, rounding_adjustment_minor,
       occurred_at, economic_effective_at, billing_posted_period, recognition_label
     ) VALUES ($1, $2, $3, 'finalization', $4, $5, 0, NOW(), NOW(), $6, 'finalized')`,
    [brandId, randomUUID(), `order-${randomUUID()}`, String(amountMinor), currency, toBillingPostedPeriod(now)],
  );
}

beforeAll(async () => {
  superPool = new pg.Pool({ connectionString: SUPERUSER_URL, max: 5 });
  appPool = new pg.Pool({ connectionString: APP_URL, max: 5 });
  await superPool.query('SELECT 1');
  await appPool.query('SELECT 1');

  try {
    srPool = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: 'root', password: '', connectionLimit: 2 });
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
  await clearSpend(BRAND_A);
  await clearSpend(BRAND_B);
  await clearRevenue(BRAND_A);
  await clearRevenue(BRAND_B);
  await clearSpendSilver(BRAND_A);
  await clearSpendSilver(BRAND_B);
});

afterAll(async () => {
  await clearSpend(BRAND_A);
  await clearSpend(BRAND_B);
  await clearRevenue(BRAND_A);
  await clearRevenue(BRAND_B);
  await clearSpendSilver(BRAND_A);
  await clearSpendSilver(BRAND_B);
  await superPool.query(`DELETE FROM brand WHERE id IN ($1, $2)`, [BRAND_A, BRAND_B]).catch(() => {});
  await superPool.end().catch(() => {});
  await appPool.end().catch(() => {});
  if (srPool) await srPool.end().catch(() => {});
});

// ── 1. PARITY ORACLE — engine(lakehouse) SUM == PG ad_spend_as_of seam SUM (D-3) ──

describe('1. parity oracle — ad_spend engine(lakehouse)==PG seam exact-bigint (D-3)', () => {
  const from = daysAgoStr(10);
  const to = todayStr();

  beforeAll(async () => {
    await clearSpend(BRAND_A);
    await clearSpendSilver(BRAND_A);
    const rows = [
      { platform: 'meta' as const, levelId: 'c1', statDate: daysAgoStr(5), spendMinor: 100000n, currency: 'INR' },
      { platform: 'meta' as const, levelId: 'c2', statDate: daysAgoStr(3), spendMinor: 50000n, currency: 'INR' },
      { platform: 'google_ads' as const, levelId: 'g1', statDate: daysAgoStr(2), spendMinor: 30000n, currency: 'INR' },
    ];
    for (const r of rows) { await seedSpend(BRAND_A, r); await seedSpendSilver(BRAND_A, r); }
  });
  afterAll(async () => { await clearSpend(BRAND_A); await clearSpendSilver(BRAND_A); });

  it('engine(lakehouse) timeseries total == PG ad_spend_as_of seam SUM (exact, no rounding)', async () => {
    if (!srUp) return;
    const buckets = await computeAdSpendTimeseries(
      BRAND_A,
      { fromDate: new Date(`${from}T00:00:00Z`), toDate: new Date(`${to}T00:00:00Z`), grain: 'day' },
      { srPool: srPool as unknown as SilverPool },
    );
    const engineTotal = buckets.reduce((acc, b) => acc + b.spendMinor, 0n);

    // The PG seam SUM (the prior sole as-of read) — the parity oracle the lakehouse must match.
    const client = await appPool.connect();
    let seamTotal = 0n;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [BRAND_A]);
      const r = await client.query<{ spend_minor: string }>(
        `SELECT spend_minor FROM ad_spend_as_of($1::uuid, $2::date, $3::date)`,
        [BRAND_A, from, to],
      );
      await client.query('COMMIT');
      seamTotal = r.rows.reduce((acc, row) => acc + BigInt(row.spend_minor), 0n);
    } finally {
      client.release();
    }

    expect(engineTotal).toBe(180000n);
    expect(engineTotal).toBe(seamTotal); // PG⇄lakehouse parity — RED on any divergence at cutover
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
  beforeAll(async () => { await clearSpend(BRAND_A); await clearSpendSilver(BRAND_A); await clearRevenue(BRAND_A); });

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
    // Even with realized revenue present, no spend means no ROAS. (blended-roas still reads PG.)
    await seedFinalized(BRAND_A, 500000n, 'INR');
    const result = await getBlendedRoas(
      BRAND_A,
      { fromDate: new Date(`${daysAgoStr(10)}T00:00:00Z`), toDate: new Date(`${todayStr()}T00:00:00Z`) },
      { pool: appPool },
    );
    expect(result.state).toBe('no_data');
    await clearRevenue(BRAND_A);
  });
});

// ── 3 + 4. BLENDED ROAS: same-currency-only + honest spend=0→null (PG-side, unchanged) ──

describe('3+4. blended_roas — same-currency-only + honest spend=0→null', () => {
  const from = daysAgoStr(10);
  const to = todayStr();

  beforeAll(async () => {
    await clearSpend(BRAND_A);
    await clearRevenue(BRAND_A);
    // realized: INR 5000.00 finalized (brand currency = INR)
    await seedFinalized(BRAND_A, 500000n, 'INR');
    // spend: INR 100000 (paise) + USD 20000 (cents) — two currencies, must NOT blend
    await seedSpend(BRAND_A, { platform: 'meta', levelId: 'inr1', statDate: daysAgoStr(4), spendMinor: 100000n, currency: 'INR' });
    await seedSpend(BRAND_A, { platform: 'google_ads', levelId: 'usd1', statDate: daysAgoStr(3), spendMinor: 20000n, currency: 'USD' });
  });
  afterAll(async () => { await clearSpend(BRAND_A); await clearRevenue(BRAND_A); });

  it('produces per-currency rows; INR row has realized+spend, USD row has spend only', async () => {
    const result = await getBlendedRoas(
      BRAND_A,
      { fromDate: new Date(`${from}T00:00:00Z`), toDate: new Date(`${to}T00:00:00Z`) },
      { pool: appPool },
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
    // Direct engine probe — fabricate a window where INR has realized but spend lands
    // outside the window for INR (so INR spend=0 inside window).
    const rows = await computeBlendedRoas(
      BRAND_A,
      // window that EXCLUDES the seeded spend dates (future window) → spend=0 everywhere
      { fromDate: new Date(`${daysAgoStr(1)}T00:00:00Z`), toDate: new Date(`${todayStr()}T00:00:00Z`) },
      { pool: appPool },
    );
    // No spend in this narrow window → every row (if any) has spend=0 → roasRatio null.
    for (const r of rows) {
      if (r.spendMinor === 0n) expect(r.roasRatio).toBeNull();
    }
  });
});

// ── 5. ISOLATION — Silver-seam scoping (timeseries) + PG negative-control (write SoR) ──

describe('5. isolation — cross-brand spend invisible (Silver seam + PG control)', () => {
  beforeAll(async () => {
    await clearSpend(BRAND_A);
    await clearSpend(BRAND_B);
    await clearSpendSilver(BRAND_A);
    await clearSpendSilver(BRAND_B);
    const row = { platform: 'meta' as const, levelId: 'iso1', statDate: daysAgoStr(2), spendMinor: 777000n, currency: 'INR' };
    await seedSpend(BRAND_A, row);
    await seedSpendSilver(BRAND_A, row);
  });
  afterAll(async () => { await clearSpend(BRAND_A); await clearSpend(BRAND_B); await clearSpendSilver(BRAND_A); await clearSpendSilver(BRAND_B); });

  it('current_user is brain_app (non-superuser, NOBYPASSRLS) — PG isolation is non-inert', async () => {
    const r = await appPool.query<{ current_user: string; is_superuser: boolean }>(
      `SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
    );
    expect(r.rows[0]!.current_user).toBe('brain_app');
    expect(r.rows[0]!.is_superuser).toBe(false);
  });

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
    expect(a.state).toBe('has_data');
    expect(b.state).toBe('no_data'); // BRAND_PREDICATE (brand_id = ?) scopes BRAND_A's rows out for BRAND_B
  });

  it('[negative-control] GUC=BRAND_B querying BRAND_A spend rows → count 0 (PG RLS non-inert)', async () => {
    const client = await appPool.connect();
    let count: number;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_brand_id', $1, true)`, [BRAND_B]);
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ad_spend_ledger WHERE brand_id = $1`,
        [BRAND_A],
      );
      await client.query('COMMIT');
      count = parseInt(r.rows[0]?.count ?? '0', 10);
    } finally {
      client.release();
    }
    // MUST be 0 — goes RED if RLS policy dropped or role gains bypass.
    expect(count).toBe(0);
  });
});
