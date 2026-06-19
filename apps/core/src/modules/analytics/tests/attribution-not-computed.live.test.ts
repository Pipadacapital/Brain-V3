/**
 * attribution-not-computed.live.test.ts — honest attribution states (audit R-10), live Postgres.
 *
 * Proves the attribution read surfaces distinguish THREE states instead of rendering an empty
 * credit ledger as a real 0%/100% result:
 *   - no_data:       no realized revenue at all.
 *   - not_computed:  realized revenue exists, but attribution_credit_ledger is EMPTY (the credit
 *                    pipeline hasn't run) — the case the audit flagged as indistinguishable from
 *                    no-data, now surfaced honestly.
 *   - has_data:      realized revenue AND credit rows exist.
 *
 * REQUIRES: Postgres with migrations through 0039 applied.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getAttributionByChannel, getAttributionReconciliation } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

const BRAND_EMPTY = 'a1000a1a-0a1a-4a1a-8a1a-000000000001'; // no revenue → no_data
const BRAND_NOCREDIT = 'a1000a1a-0a1a-4a1a-8a1a-000000000002'; // revenue, no credit → not_computed
const BRAND_CREDIT = 'a1000a1a-0a1a-4a1a-8a1a-000000000003'; // revenue + credit → has_data

let pool: pg.Pool;
let pgAvailable = false;

const params = (model = 'last_touch' as const) => ({
  model,
  fromDate: new Date('2026-06-01T00:00:00Z'),
  toDate: new Date('2026-06-30T23:59:59Z'),
  fromStr: '2026-06-01',
  toStr: '2026-06-30',
  dataSource: 'live' as const,
});

async function seedRevenue(brandId: string) {
  await pool.query(
    `INSERT INTO realized_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        rounding_adjustment_minor, occurred_at, economic_effective_at, billing_posted_period, recognition_label)
     VALUES ($1, $2, $3, $4, 'finalization', 100000, 'INR', 0, '2026-06-15T00:00:00Z', '2026-06-15T00:00:00Z', '2026-06', 'finalized')
     ON CONFLICT DO NOTHING`,
    [brandId, randomUUID(), `order-${brandId}`, randomUUID()],
  );
}

async function seedCredit(brandId: string) {
  await pool.query(
    `INSERT INTO attribution_credit_ledger
       (brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, model_id, row_kind,
        weight_fraction, credited_revenue_minor, currency_code, realized_revenue_minor,
        occurred_at, economic_effective_at, billing_posted_period)
     VALUES ($1, $2, $3, 'anon-1', 1, 'google', 'last_touch', 'credit', 1.0, 100000, 'INR', 100000,
             '2026-06-15T00:00:00Z', '2026-06-15T00:00:00Z', '2026-06')
     ON CONFLICT DO NOTHING`,
    [brandId, randomUUID(), `order-${brandId}`],
  );
}

async function cleanup() {
  for (const b of [BRAND_EMPTY, BRAND_NOCREDIT, BRAND_CREDIT]) {
    await pool.query(`DELETE FROM attribution_credit_ledger WHERE brand_id = $1`, [b]).catch(() => {});
    await pool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id = $1`, [b]).catch(() => {});
  }
}

beforeAll(async () => {
  try {
    pool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000 });
    await pool.query('SELECT 1');
    await cleanup();
    await seedRevenue(BRAND_NOCREDIT);
    await seedRevenue(BRAND_CREDIT);
    await seedCredit(BRAND_CREDIT);
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  if (pool) await pool.end();
});

describe('attribution honest states (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[attribution-not-computed] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('no realized revenue → no_data', async () => {
    if (!pgAvailable) return;
    const r = await getAttributionByChannel(BRAND_EMPTY, params(), { pool });
    expect(r.state).toBe('no_data');
  });

  it('revenue but EMPTY credit ledger → not_computed (the honesty fix)', async () => {
    if (!pgAvailable) return;
    const byChannel = await getAttributionByChannel(BRAND_NOCREDIT, params(), { pool });
    expect(byChannel.state).toBe('not_computed');
    const recon = await getAttributionReconciliation(BRAND_NOCREDIT, params(), { pool });
    expect(recon.state).toBe('not_computed');
  });

  it('revenue + credit rows → NOT not_computed (real result)', async () => {
    if (!pgAvailable) return;
    const r = await getAttributionByChannel(BRAND_CREDIT, params(), { pool });
    expect(r.state).not.toBe('not_computed');
    expect(r.state).not.toBe('no_data');
  });
});
