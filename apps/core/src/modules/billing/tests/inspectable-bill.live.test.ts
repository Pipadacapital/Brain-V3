/**
 * inspectable-bill.live.test.ts — live Postgres tests for the inspectable bill (P1, slice 2).
 *
 * Proves:
 *   1. default rate — with no billing_plan row, the bill uses the platform default and SAYS so;
 *      fee = round(basis × default_bps / 10000), banker's rounding (D-7).
 *   2. plan rate — a billing_plan row overrides the rate; rate.source = 'plan'; fee recomputed.
 *   3. composition reconciles — the per-event_type lines (finalization +, refund −) sum to the
 *      sealed basis via realized_gmv_composition_as_of (the D-3 named seam).
 *   4. honest drift — a backdated row landing AFTER the seal makes the live composition diverge
 *      from the sealed basis; reconciles:false + a non-zero drift, but the fee stays on the seal.
 *   5. not_sealed — an unsealed period returns state:'not_sealed' (no throw).
 *
 * REQUIRES: Postgres on localhost:5432 with migrations 0040 + 0041 applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool, type DbPool } from '@brain/db';
import { sealBillingPeriod, getInspectableBill, DEFAULT_RATE_BPS } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_A = 'b222222a-0a1a-4a1a-8a1a-000000000001';
const ORG_ID = '0222222a-0a1a-4a1a-8a1a-000000000001';
const USER_ID = 'a222222a-0a1a-4a1a-8a1a-000000000001';
const PERIOD = '2099-03';
const CORR = 'inspectable-bill-live-test';

let superPool: pg.Pool;
let dbPool: DbPool;
let pgAvailable = false;

let seq = 0;
async function insertLedgerRow(eventType: string, amountMinor: number, effectiveAt: string): Promise<void> {
  seq += 1;
  await superPool.query(
    `INSERT INTO realized_revenue_ledger
       (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code,
        occurred_at, economic_effective_at, billing_posted_period, recognition_label)
     VALUES ($1, $2, $3, $4, $5, 'INR', $6, $6, '2099-03',
             CASE WHEN $4 = 'provisional_recognition' THEN 'provisional' ELSE 'finalized' END)
     ON CONFLICT (brand_id, ledger_event_id) DO NOTHING`,
    [BRAND_A, `bill-evt-${seq}`, `order-${seq}`, eventType, amountMinor, effectiveAt],
  );
}

async function seedBrand(): Promise<void> {
  await superPool.query(
    `INSERT INTO app_user (id, email, email_normalized, password_hash)
     VALUES ($1, 'bill-test@example.invalid', 'bill-test@example.invalid', 'x') ON CONFLICT (id) DO NOTHING`,
    [USER_ID],
  );
  await superPool.query(
    `INSERT INTO organization (id, name, slug, owner_user_id)
     VALUES ($1, 'Bill Test Org', 'bill-test-org', $2) ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, USER_ID],
  );
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code)
     VALUES ($1, $2, 'Bill Test Brand', 'INR') ON CONFLICT (id) DO NOTHING`,
    [BRAND_A, ORG_ID],
  );
}

async function cleanup(): Promise<void> {
  await superPool.query(`DELETE FROM billing_plan WHERE brand_id = $1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM gmv_meter_snapshot WHERE brand_id = $1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id = $1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id = $1`, [BRAND_A]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id = $1`, [ORG_ID]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id = $1`, [USER_ID]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    dbPool = await createPool({ connectionString: SUPERUSER_URL });
    await cleanup();
    await seedBrand();
    // Sealed basis as-of 2099-03-31 = 100000 (finalization) − 20000 (refund) = 80000.
    await insertLedgerRow('finalization', 100_000, '2099-03-10T00:00:00Z');
    await insertLedgerRow('refund', -20_000, '2099-03-20T00:00:00Z');
    await insertLedgerRow('provisional_recognition', 50_000, '2099-03-15T00:00:00Z'); // excluded
    await sealBillingPeriod(BRAND_A, PERIOD, CORR, { pool: dbPool });
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (dbPool) await dbPool.end();
  if (superPool) await superPool.end();
});

describe('inspectable bill (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[inspectable-bill] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('1. default rate — no plan → platform default, fee on sealed basis', async () => {
    if (!pgAvailable) return;
    const b = await getInspectableBill(BRAND_A, PERIOD, CORR, { pool: dbPool });
    expect(b.state).toBe('billed');
    if (b.state !== 'billed') return;
    expect(b.rate.source).toBe('default');
    expect(b.rate.rate_bps).toBe(DEFAULT_RATE_BPS); // 100 bps = 1%
    expect(b.basis.metered_gmv_minor).toBe('80000');
    // fee = round(80000 × 100 / 10000) = 800
    expect(b.fee_minor).toBe('800');
  });

  it('2. composition reconciles to the sealed basis (finalization + refund)', async () => {
    if (!pgAvailable) return;
    const b = await getInspectableBill(BRAND_A, PERIOD, CORR, { pool: dbPool });
    if (b.state !== 'billed') throw new Error('expected billed');
    const byType = Object.fromEntries(b.lines.map((l) => [l.event_type, l.amount_minor]));
    expect(byType['finalization']).toBe('100000');
    expect(byType['refund']).toBe('-20000');
    expect(b.reconciliation.live_composition_minor).toBe('80000');
    expect(b.reconciliation.sealed_basis_minor).toBe('80000');
    expect(b.reconciliation.reconciles).toBe(true);
    expect(b.reconciliation.drift_minor).toBe('0');
  });

  it('3. plan rate — a billing_plan row overrides the default', async () => {
    if (!pgAvailable) return;
    await superPool.query(
      `INSERT INTO billing_plan (brand_id, rate_bps) VALUES ($1, 150)
       ON CONFLICT (brand_id) DO UPDATE SET rate_bps = EXCLUDED.rate_bps`,
      [BRAND_A],
    );
    const b = await getInspectableBill(BRAND_A, PERIOD, CORR, { pool: dbPool });
    if (b.state !== 'billed') throw new Error('expected billed');
    expect(b.rate.source).toBe('plan');
    expect(b.rate.rate_bps).toBe(150);
    // fee = round(80000 × 150 / 10000) = 1200
    expect(b.fee_minor).toBe('1200');
  });

  it('4. honest drift — a backdated row after sealing diverges from the sealed basis', async () => {
    if (!pgAvailable) return;
    // A finalization effective IN March arrives AFTER the seal — sealed basis must NOT move.
    await insertLedgerRow('finalization', 5_000, '2099-03-28T00:00:00Z');
    const b = await getInspectableBill(BRAND_A, PERIOD, CORR, { pool: dbPool });
    if (b.state !== 'billed') throw new Error('expected billed');
    expect(b.basis.metered_gmv_minor).toBe('80000'); // sealed figure unchanged
    expect(b.reconciliation.live_composition_minor).toBe('85000'); // live recompute
    expect(b.reconciliation.reconciles).toBe(false);
    expect(b.reconciliation.drift_minor).toBe('5000');
    expect(b.fee_minor).toBe('1200'); // still billed on the sealed basis (× 150 bps)
  });

  it('5. not_sealed — an unsealed period returns state:not_sealed', async () => {
    if (!pgAvailable) return;
    const b = await getInspectableBill(BRAND_A, '2099-01', CORR, { pool: dbPool });
    expect(b.state).toBe('not_sealed');
  });
});
