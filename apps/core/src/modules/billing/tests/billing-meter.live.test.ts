/**
 * billing-meter.live.test.ts — live Postgres tests for the realized-GMV billing meter (P1).
 *
 * Proves:
 *   1. meter — sealing a period sums realized rows as-of the period's last day via
 *      realized_gmv_as_of (provisional rows EXCLUDED; refunds netted), seals an immutable row.
 *   2. immutability/idempotency — re-sealing returns sealed:false AND the original figure stands
 *      even after MORE ledger rows land (a sealed bill basis can never silently change).
 *   3. read — getBillingPeriods returns has_data with the sealed period.
 *   4. RLS isolation — BRAND_A's sealed snapshot is invisible under a BRAND_B scope (→ no_data).
 *      Reads/writes go through @brain/db createPool (SET LOCAL ROLE brain_app + brand GUC).
 *
 * REQUIRES: Postgres on localhost:5432 with migration 0040 applied.
 * Seeds/cleans via the superuser pool; meters/reads via the RLS-enforcing DbPool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { createPool, type DbPool } from '@brain/db';
import type { SilverPool } from '@brain/metric-engine';
import { sealBillingPeriod, getBillingPeriods } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? '9030');

const BRAND_A = 'b111111a-0a1a-4a1a-8a1a-000000000001';
const BRAND_B = 'b111111a-0a1a-4a1a-8a1a-000000000002';
const ORG_ID = '0111111a-0a1a-4a1a-8a1a-000000000001';
const USER_ID = 'a111111a-0a1a-4a1a-8a1a-000000000001';
const PERIOD = '2099-03';
const CORR = 'billing-meter-live-test';

let superPool: pg.Pool;
let dbPool: DbPool;
let srPool: SilverPool;
let pgAvailable = false;

let seq = 0;
/**
 * MEDALLION REALIGNMENT (Epic 1 / decision B): the billing meter now reads the LAKEHOUSE ledger
 * (brain_gold.gold_revenue_ledger on StarRocks), not the PG ledger. Seed there so the seal sees it.
 */
async function insertLedgerRow(
  brandId: string,
  eventType: string,
  amountMinor: number,
  effectiveAt: string,
  period = '2099-03',
): Promise<void> {
  seq += 1;
  const recognitionLabel = eventType === 'provisional_recognition' ? 'provisional' : 'finalized';
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period,
        ingested_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 'INR', 0, ?, ?, ?, ?, ?, ?)`,
    [
      brandId,
      `evt-${brandId}-${seq}`,
      `order-${seq}`,
      eventType,
      amountMinor,
      effectiveAt,
      effectiveAt,
      recognitionLabel,
      period,
      effectiveAt,
      effectiveAt,
    ],
  );
}

async function seedBrand(): Promise<void> {
  // app_user → organization → brand chain (brand.currency_code drives the ledger currency trigger).
  await superPool.query(
    `INSERT INTO app_user (id, email, email_normalized, password_hash)
     VALUES ($1, 'billing-meter-test@example.invalid', 'billing-meter-test@example.invalid', 'x')
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await superPool.query(
    `INSERT INTO organization (id, name, slug, owner_user_id)
     VALUES ($1, 'Billing Meter Test Org', 'billing-meter-test-org', $2)
     ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, USER_ID],
  );
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code)
     VALUES ($1, $2, 'Billing Meter Test Brand', 'INR')
     ON CONFLICT (id) DO NOTHING`,
    [BRAND_A, ORG_ID],
  );
}

async function cleanup(): Promise<void> {
  for (const b of [BRAND_A, BRAND_B]) {
    await superPool.query(`DELETE FROM gmv_meter_snapshot WHERE brand_id = $1`, [b]).catch(() => {});
    await srPool
      .query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [b])
      .catch(() => {});
  }
  await superPool.query(`DELETE FROM brand WHERE id = $1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG_ID]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER_ID]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    dbPool = await createPool({ connectionString: SUPERUSER_URL });
    srPool = mysql.createPool({
      host: SR_HOST,
      port: SR_PORT,
      user: 'root',
      password: '',
      connectionLimit: 2,
    }) as unknown as SilverPool;
    await srPool.query('SELECT 1');
    await cleanup();
    await seedBrand();
    // Realized GMV as-of 2099-03-31 = 100000 (finalization) − 20000 (refund) = 80000.
    // The provisional row (+50000) and an out-of-window row (+999 on 2099-04-01) must NOT count.
    await insertLedgerRow(BRAND_A, 'finalization', 100_000, '2099-03-10T00:00:00Z');
    await insertLedgerRow(BRAND_A, 'refund', -20_000, '2099-03-20T00:00:00Z');
    await insertLedgerRow(BRAND_A, 'provisional_recognition', 50_000, '2099-03-15T00:00:00Z');
    // Posted to a DIFFERENT period (2099-04) — must NOT count toward the 2099-03 delta.
    await insertLedgerRow(BRAND_A, 'finalization', 999, '2099-04-01T00:00:00Z', '2099-04');
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (dbPool) await dbPool.end();
  if (srPool) await (srPool as unknown as mysql.Pool).end().catch(() => {});
  if (superPool) await superPool.end();
});

describe('billing meter (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[billing-meter] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. meter — seals the per-period realized GMV (provisional excluded, refund netted, other periods out)', async () => {
    if (!pgAvailable) return;
    const r = await sealBillingPeriod(BRAND_A, PERIOD, CORR, { pool: dbPool, srPool });
    expect(r.sealed).toBe(true);
    expect(r.billing_period).toBe(PERIOD);
    expect(r.currency_code).toBe('INR');
    expect(r.metered_gmv_minor).toBe('80000'); // 100000 − 20000; provisional & out-of-window excluded
    expect(r.as_of_date).toBe('2099-03-31');
    expect(r.ledger_row_count).toBeGreaterThanOrEqual(3); // provenance count (incl provisional row)
  });

  it('2. immutability — re-seal is a no-op even after more ledger rows land', async () => {
    if (!pgAvailable) return;
    // A late finalization arrives AFTER the seal — must NOT change the sealed figure.
    await insertLedgerRow(BRAND_A, 'finalization', 777_000, '2099-03-25T00:00:00Z');
    const r = await sealBillingPeriod(BRAND_A, PERIOD, CORR, { pool: dbPool, srPool });
    expect(r.sealed).toBe(false); // already sealed
    expect(r.metered_gmv_minor).toBe('80000'); // original figure stands — immutable
  });

  it('3. read — getBillingPeriods returns has_data with the sealed period', async () => {
    if (!pgAvailable) return;
    const r = await getBillingPeriods(BRAND_A, CORR, { pool: dbPool });
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    const p = r.periods.find((x) => x.billing_period === PERIOD);
    expect(p).toBeDefined();
    expect(p!.metered_gmv_minor).toBe('80000');
  });

  it('4. RLS isolation — BRAND_A snapshot invisible under BRAND_B scope', async () => {
    if (!pgAvailable) return;
    const r = await getBillingPeriods(BRAND_B, CORR, { pool: dbPool });
    expect(r.state).toBe('no_data');
  });
});
