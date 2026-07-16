/**
 * attribution-not-computed.live.test.ts — honest attribution states (audit R-10), live lakehouse.
 *
 * Proves the attribution read surfaces distinguish THREE states instead of rendering an empty
 * credit ledger as a real 0%/100% result:
 *   - no_data:       no realized revenue at all.
 *   - not_computed:  realized revenue exists, but the attribution credit mart is EMPTY (the credit
 *                    pipeline hasn't run) — the case the audit flagged as indistinguishable from
 *                    no-data, now surfaced honestly.
 *   - has_data:      realized revenue AND credit rows exist.
 *
 * PHASE G: getAttributionByChannel / getAttributionReconciliation now read the LAKEHOUSE
 * (brain_gold.gold_revenue_ledger for realized, brain_gold.gold_marketing_attribution for credit)
 * via withSilverBrand. BRAIN V4: StarRocks and Trino are REMOVED (ADR-0014) — those reads run over DUCKDB-SERVING (createDuckDbServingPool),
 * the same duckdb-serving-over-Iceberg serving path the app uses in production. This test seeds the base Iceberg
 * tables and passes { srPool }; the exists-check and the compute read the SAME store (via the
 * brain_serving.mv_* views). SKIPS if duckdb-serving is down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDuckDbServingPool, type SilverPool } from '@brain/metric-engine';
import { getAttributionByChannel, getAttributionReconciliation } from '../index.js';

const SERVING_URL =
  process.env['DUCKDB_SERVING_URL'] ??
  `http://${process.env['DUCKDB_SERVING_HOST'] ?? '127.0.0.1'}:${process.env['DUCKDB_SERVING_PORT'] ?? '8091'}`;

const BRAND_EMPTY = 'a1000a1a-0a1a-4a1a-8a1a-000000000001'; // no revenue → no_data
const BRAND_NOCREDIT = 'a1000a1a-0a1a-4a1a-8a1a-000000000002'; // revenue, no credit → not_computed
const BRAND_CREDIT = 'a1000a1a-0a1a-4a1a-8a1a-000000000003'; // revenue + credit → has_data

let srPool: SilverPool;
let srUp = false;
const sr = (): SilverPool => srPool;

const params = (model = 'last_touch' as const) => ({
  model,
  fromDate: new Date('2026-06-01T00:00:00Z'),
  toDate: new Date('2026-06-30T23:59:59Z'),
  fromStr: '2026-06-01',
  toStr: '2026-06-30',
  dataSource: 'live' as const,
});

// Iceberg ts columns (occurred_at/economic_effective_at/updated_at) are `timestamp` (no zone) → typed
// no-zone TIMESTAMP literals + localtimestamp. data_source on the ledger is NOT NULL → 'live'.
async function seedRealized(brandId: string) {
  await srPool.query(
    `INSERT INTO brain_gold.gold_revenue_ledger
       (brand_id, ledger_event_id, order_id, brain_id, event_type, amount_minor, currency_code,
        fee_minor, occurred_at, economic_effective_at, recognition_label, billing_posted_period, data_source, updated_at)
     VALUES (?, ?, ?, NULL, 'finalization', 100000, 'INR', 0, TIMESTAMP '2026-06-15 00:00:00', TIMESTAMP '2026-06-15 00:00:00', 'finalized', '2026-06', 'live', localtimestamp)`,
    [brandId, `fin-${brandId}`, `order-${brandId}`],
  );
}

async function seedCredit(brandId: string) {
  // attribution_confidence is a STRING column (kept as the numeric string) → quote '1.000' (a bare
  // decimal literal would not coerce double→varchar on insert).
  await srPool.query(
    `INSERT INTO brain_gold.gold_marketing_attribution
       (brand_id, credit_id, order_id, brain_anon_id, touch_seq, channel, campaign_id, model_id, row_kind,
        credited_revenue_minor, currency_code, realized_revenue_minor, reversed_of_credit_id,
        confidence_grade, attribution_confidence, model_version, occurred_at, economic_effective_at, billing_posted_period, updated_at)
     VALUES (?, ?, ?, 'anon-1', 1, 'google', NULL, 'last_touch', 'credit', 100000, 'INR', 100000, NULL,
             'A', '1.000', 'v1', TIMESTAMP '2026-06-15 00:00:00', TIMESTAMP '2026-06-15 00:00:00', '2026-06', localtimestamp)`,
    [brandId, `credit-${brandId}`, `order-${brandId}`],
  );
}

async function cleanup() {
  if (!srUp) return;
  for (const b of [BRAND_EMPTY, BRAND_NOCREDIT, BRAND_CREDIT]) {
    await srPool.query(`DELETE FROM brain_gold.gold_marketing_attribution WHERE brand_id = ?`, [b]).catch(() => {});
    await srPool.query(`DELETE FROM brain_gold.gold_revenue_ledger WHERE brand_id = ?`, [b]).catch(() => {});
  }
}

beforeAll(async () => {
  try {
    srPool = createDuckDbServingPool({ baseUrl: SERVING_URL });
    await srPool.query('SELECT 1');
    srUp = true;
    await cleanup();
    await seedRealized(BRAND_NOCREDIT);
    await seedRealized(BRAND_CREDIT);
    await seedCredit(BRAND_CREDIT);
  } catch {
    srUp = false;
  }
});

afterAll(async () => {
  if (srUp) await cleanup();
  // The serving pool is a stateless HTTP adapter — no connection to close.
});

describe('attribution honest states (live lakehouse)', () => {
  it('SKIP_IF_NO_SERVING', () => {
    if (!srUp) console.warn('[attribution-not-computed] duckdb-serving unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('no realized revenue → no_data', async () => {
    if (!srUp) return;
    const r = await getAttributionByChannel(BRAND_EMPTY, params(), { srPool: sr() });
    expect(r.state).toBe('no_data');
  });

  it('revenue but EMPTY credit mart → not_computed (the honesty fix)', async () => {
    if (!srUp) return;
    const byChannel = await getAttributionByChannel(BRAND_NOCREDIT, params(), { srPool: sr() });
    expect(byChannel.state).toBe('not_computed');
    const recon = await getAttributionReconciliation(BRAND_NOCREDIT, params(), { srPool: sr() });
    expect(recon.state).toBe('not_computed');
  });

  it('revenue + credit rows → NOT not_computed (real result)', async () => {
    if (!srUp) return;
    const r = await getAttributionByChannel(BRAND_CREDIT, params(), { srPool: sr() });
    expect(r.state).not.toBe('not_computed');
    expect(r.state).not.toBe('no_data');
  });
});
