/**
 * over-reversal.live.test.ts — revenue-truth over-reversal signal (F2), live Postgres.
 *
 * The ledger stays truthful (signed rows); F2 makes an over-reversal LOUD instead of silently
 * driving realized revenue negative. Proves: cumulative reversals EXCEEDING the recognized sale
 * emit revenue_over_reversal_total; a clean single full reversal (reversed == sale) stays silent.
 *
 * REQUIRES Postgres with the realized_revenue_ledger (0018) + settlement event_types (0027).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { setCounterSink } from '@brain/observability';
import { LedgerWriter } from '../infrastructure/pg/LedgerWriter.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'f2000a1a-0a1a-4a1a-8a1a-000000000001';
const ORG = 'f2000a1a-0a1a-4a1a-8a1a-0000000000f1';
const USER = 'f2000a1a-0a1a-4a1a-8a1a-0000000000e1';

let superPool: pg.Pool;
let writer: LedgerWriter;
let pgAvailable = false;
let restoreSink: (() => void) | null = null;
const recorded: Array<{ name: string; labels: Record<string, string> }> = [];

async function cleanup() {
  await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

async function seedBrand() {
  await superPool.query(
    `INSERT INTO app_user (id, email, email_normalized, password_hash)
     VALUES ($1,'f2@example.invalid','f2@example.invalid','x') ON CONFLICT (id) DO NOTHING`,
    [USER],
  );
  await superPool.query(
    `INSERT INTO organization (id, name, slug, owner_user_id)
     VALUES ($1,'F2 Org','f2-org',$2) ON CONFLICT (id) DO NOTHING`,
    [ORG, USER],
  );
  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code)
     VALUES ($1,$2,'F2 Brand','INR') ON CONFLICT (id) DO NOTHING`,
    [BRAND, ORG],
  );
}

async function seedLedger(orderId: string, rows: Array<[string, number, string]>) {
  let i = 0;
  for (const [eventType, amountMinor, label] of rows) {
    i += 1;
    await superPool.query(
      `INSERT INTO realized_revenue_ledger
         (brand_id, ledger_event_id, order_id, event_type, amount_minor, currency_code,
          occurred_at, economic_effective_at, billing_posted_period, recognition_label)
       VALUES ($1,$2,$3,$4,$5::bigint,'INR','2026-06-0${i}Z','2026-06-0${i}Z','2026-06',$6)
       ON CONFLICT (brand_id, ledger_event_id) DO NOTHING`,
      [BRAND, `${orderId}-evt-${i}`, orderId, eventType, amountMinor, label],
    );
  }
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000 });
    await superPool.query('SELECT 1');
    writer = new LedgerWriter(APP);
    await cleanup();
    await seedBrand();
    restoreSink = setCounterSink({ add: (name, _v, labels) => recorded.push({ name, labels }) });
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (restoreSink) restoreSink();
  if (pgAvailable) await cleanup();
  await writer?.end?.();
  if (superPool) await superPool.end();
});

const overReversals = () => recorded.filter((r) => r.name === 'revenue_over_reversal_total' && r.labels['brand_id'] === BRAND);

describe('revenue over-reversal signal (F2, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[over-reversal] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('OVER-reversal (refund + cancellation > sale) emits revenue_over_reversal_total', async () => {
    if (!pgAvailable) return;
    // sale 100000; a refund of 60000 already posted. A further 60000 cancellation → reversed 120000 > 100000.
    await seedLedger('ovr-1', [
      ['provisional_recognition', 100_000, 'provisional'],
      ['refund', -60_000, 'finalized'],
    ]);
    const before = overReversals().length;
    const inserted = await writer.writeReversal(
      { brandId: BRAND, orderId: 'ovr-1', brainId: null, amountMinor: '60000', currencyCode: 'INR',
        occurredAt: '2026-06-09T00:00:00.000Z', paymentMethod: 'prepaid', sourcePk: 'ovr-1-src', rawEventId: 'ovr-1-src' },
      'cancellation',
    );
    expect(inserted).toBe(true);
    expect(overReversals().length).toBe(before + 1); // SIGNALLED
  });

  it('a SETTLEMENT reversal that pushes cumulative reversals past the sale also signals (F2 follow-up)', async () => {
    if (!pgAvailable) return;
    // sale 100000 with a 60000 refund already posted; a 60000 settlement_reversal → reversed 120000 > 100000.
    await seedLedger('ovr-3', [
      ['provisional_recognition', 100_000, 'provisional'],
      ['refund', -60_000, 'finalized'],
    ]);
    const before = overReversals().length;
    const inserted = await writer.writeSettlementFinalization({
      brandId: BRAND, orderId: 'ovr-3', brainId: null, settlementId: 'setl-ovr-3',
      eventType: 'settlement_reversal', amountMinor: '-60000', feeMinor: '0', taxMinor: '0',
      currencyCode: 'INR', occurredAt: '2026-06-09T00:00:00.000Z', reconciliationType: 'per_order',
      taxCode: null, rawEventId: 'ovr-3-src',
    });
    expect(inserted).toBe(true);
    expect(overReversals().length).toBe(before + 1); // SIGNALLED on the settlement path too
  });

  it('a clean single full reversal (reversed == sale) stays SILENT', async () => {
    if (!pgAvailable) return;
    await seedLedger('ovr-2', [['provisional_recognition', 100_000, 'provisional']]);
    const before = overReversals().length;
    const inserted = await writer.writeReversal(
      { brandId: BRAND, orderId: 'ovr-2', brainId: null, amountMinor: '100000', currencyCode: 'INR',
        occurredAt: '2026-06-09T00:00:00.000Z', paymentMethod: 'prepaid', sourcePk: 'ovr-2-src', rawEventId: 'ovr-2-src' },
      'rto_reversal',
    );
    expect(inserted).toBe(true);
    expect(overReversals().length).toBe(before); // NO new signal — full reversal is not over-reversal
  });
});
