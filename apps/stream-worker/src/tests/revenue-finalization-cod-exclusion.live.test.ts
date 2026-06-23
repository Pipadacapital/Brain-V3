/**
 * revenue-finalization-cod-exclusion.live.test.ts — regression for the finalization COD double-count bug.
 *
 * Finalization recognizes PREPAID revenue after the return/cancel horizon. COD revenue is recognized
 * on a SEPARATE path (cod_delivery_confirmed / cod_rto_clawback). Every order gets a
 * provisional_recognition (COD + prepaid), so the job MUST NOT finalize a provisional whose order has
 * a COD recognition event — else realized revenue (= finalization + cod_delivery_confirmed + reversals)
 * double-counts. It must also skip orders reversed by ANY type (not just rto/cancel).
 *
 * Seeds a dedicated brand with 4 overdue orders and runs the REAL job (runRevenueFinalization):
 *   - prepaid   (provisional only)                  → MUST finalize
 *   - cod       (provisional + cod_delivery_confirmed)→ must NOT finalize (double-count guard)
 *   - cod_rto   (provisional + cod_rto_clawback)     → must NOT finalize (RTO'd COD)
 *   - refunded  (provisional + refund)               → must NOT finalize (reversal guard, previously a bug)
 *
 * Skips cleanly when Postgres is unavailable (mirrors the other *.live.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { runRevenueFinalization } from '../jobs/revenue-finalization.js';

const SUPER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'fffff096-c0de-0096-0096-00000000c0de';
let superPool: pg.Pool;
let available = false;

const ord = {
  prepaid: `fin-cod-prepaid-${randomUUID()}`,
  cod: `fin-cod-delivered-${randomUUID()}`,
  codRto: `fin-cod-rto-${randomUUID()}`,
  refunded: `fin-cod-refunded-${randomUUID()}`,
  inflightCod: `fin-cod-inflight-${randomUUID()}`, // 0097: COD, no cod_* event yet, past horizon
};

/** Insert a ledger row (superuser bypasses RLS). occurredDaysAgo controls the horizon test. */
async function seedRow(
  orderId: string,
  eventType: string,
  amountMinor: number,
  occurredDaysAgo: number,
  label: string,
  paymentMethod: 'cod' | 'prepaid' | null = null,
): Promise<void> {
  const d = new Date();
  d.setDate(d.getDate() - occurredDaysAgo);
  const iso = d.toISOString();
  const period = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  await superPool.query(
    `INSERT INTO billing.realized_revenue_ledger
       (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code,
        rounding_adjustment_minor, occurred_at, occurred_date, economic_effective_at,
        billing_posted_period, recognition_label, payment_method)
     VALUES ($1,$2,$3,$4,$5,'INR',0,$6,(timezone('UTC',$6::timestamptz))::date,$6,$7,$8,$9)
     ON CONFLICT DO NOTHING`,
    [BRAND, randomUUID(), orderId, eventType, amountMinor, iso, period, label, paymentMethod],
  );
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER_URL, max: 2 });
    const org = await superPool.query<{ id: string }>(`SELECT id FROM tenancy.organization LIMIT 1`);
    const orgId = org.rows[0]?.id;
    if (!orgId) { available = false; return; }
    await superPool.query(
      `INSERT INTO tenancy.brand (id, organization_id, display_name, currency_code, status,
                                  cod_recognition_horizon_days, prepaid_recognition_horizon_days)
       VALUES ($1,$2,'Finalization COD Test','INR','active',25,7)
       ON CONFLICT (id) DO UPDATE SET status='active', cod_recognition_horizon_days=25,
                                      prepaid_recognition_horizon_days=7`,
      [BRAND, orgId],
    );
    // All 30 days old → past both the 25d COD horizon and the 7d prepaid horizon.
    await seedRow(ord.prepaid, 'provisional_recognition', 50000, 30, 'provisional', 'prepaid');
    await seedRow(ord.cod, 'provisional_recognition', 60000, 30, 'provisional', 'cod');
    await seedRow(ord.cod, 'cod_delivery_confirmed', 60000, 5, 'finalized');
    await seedRow(ord.codRto, 'provisional_recognition', 70000, 30, 'provisional', 'cod');
    await seedRow(ord.codRto, 'cod_rto_clawback', -70000, 5, 'finalized');
    await seedRow(ord.refunded, 'provisional_recognition', 80000, 30, 'provisional', 'prepaid');
    await seedRow(ord.refunded, 'refund', -80000, 5, 'finalized');
    // 0097 RESIDUAL FIX: a COD order past the horizon with NO cod_* event yet (lost in transit / RTO
    // not recorded). Pre-0097 this was indistinguishable from prepaid and WOULD finalize; now it is
    // excluded by payment_method='cod'.
    await seedRow(ord.inflightCod, 'provisional_recognition', 90000, 30, 'provisional', 'cod');
    available = true;
  } catch {
    available = false;
  }
});

afterAll(async () => {
  if (superPool) {
    await superPool.query(`DELETE FROM billing.realized_revenue_ledger WHERE brand_id=$1`, [BRAND]).catch(() => {});
    await superPool.query(`DELETE FROM tenancy.brand WHERE id=$1`, [BRAND]).catch(() => {});
    await superPool.end().catch(() => {});
  }
});

async function isFinalized(orderId: string): Promise<boolean> {
  const r = await superPool.query(
    `SELECT 1 FROM billing.realized_revenue_ledger WHERE brand_id=$1 AND order_id=$2 AND event_type='finalization'`,
    [BRAND, orderId],
  );
  return (r.rowCount ?? 0) > 0;
}

describe('revenue-finalization — COD exclusion + reversal guard (live PG)', () => {
  it('finalizes ONLY prepaid; never COD-recognized, RTO-clawed, or refunded orders', async () => {
    if (!available) {
      console.warn('[skip] Postgres unavailable — finalization COD-exclusion test skipped');
      return;
    }
    process.env['BRAIN_APP_DATABASE_URL'] = APP_URL;
    await runRevenueFinalization();

    expect(await isFinalized(ord.prepaid), 'prepaid order must finalize').toBe(true);
    expect(await isFinalized(ord.cod), 'cod_delivery_confirmed order must NOT finalize (double-count)').toBe(false);
    expect(await isFinalized(ord.codRto), 'cod_rto_clawback order must NOT finalize').toBe(false);
    expect(await isFinalized(ord.refunded), 'refunded order must NOT finalize').toBe(false);
    // 0097: the in-flight COD order (payment_method='cod', no cod_* event yet) must NOT finalize —
    // excluded by method. This is the residual the persisted payment_method closes.
    expect(await isFinalized(ord.inflightCod), 'in-flight COD (no cod_* event) must NOT finalize (0097)').toBe(false);
  });

  it('is idempotent — a second run finalizes nothing new for the test brand', async () => {
    if (!available) return;
    const before = await superPool.query(
      `SELECT count(*)::int AS n FROM billing.realized_revenue_ledger WHERE brand_id=$1 AND event_type='finalization'`,
      [BRAND],
    );
    await runRevenueFinalization();
    const after = await superPool.query(
      `SELECT count(*)::int AS n FROM billing.realized_revenue_ledger WHERE brand_id=$1 AND event_type='finalization'`,
      [BRAND],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
