/**
 * refund-ledger-reversal.live.test.ts — feat-shopify-refund-ledger-reversal (live Postgres).
 *   RR1: an order.live.v1 carrying refunds writes one NEGATIVE 'refund' row per refund.
 *   RR2: re-delivering the SAME order event is idempotent (per-refund PK dedup → still one row each).
 *   RR3: two DISTINCT refunds on the same order + same day BOTH persist (partial-dedup fix, 0054).
 *   RR4: a later restatement adding a 3rd refund writes only the new one.
 * REQUIRES Postgres with migration 0054.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { LedgerWriter } from '../infrastructure/pg/LedgerWriter.js';
import { routeLiveOrderToLedger } from '../interfaces/consumers/LiveOrderConsumer.js';

const SUPER = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND = 'cf110001-0a11-4a11-8a11-00000000aa01';
const ORG = 'cf110001-0a11-4a11-8a11-00000000ff01';
const USER = 'cf110001-0a11-4a11-8a11-00000000ee01';
const ORDER = 'refund-order-1';

let superPool: pg.Pool;
let writer: LedgerWriter;
let pgAvailable = false;
let evt = 0;

/** Build an order.live.v1 event Buffer with the given refunds array. */
function orderEvent(refunds: Array<{ refund_id: string; amount_minor: string; processed_at?: string }>): Buffer {
  return Buffer.from(JSON.stringify({
    event_name: 'order.live.v1',
    occurred_at: '2026-06-10T10:00:00.000Z',
    properties: {
      order_id: ORDER,
      amount_minor: '100000',
      currency_code: 'INR',
      payment_method: 'prepaid',
      refunds,
    },
  }));
}

async function refundRows(): Promise<Array<{ amount_minor: string; raw: string }>> {
  const r = await superPool.query<{ amount_minor: string; ledger_event_id: string }>(
    `SELECT amount_minor::text AS amount_minor, ledger_event_id FROM realized_revenue_ledger
      WHERE brand_id=$1 AND order_id=$2 AND event_type='refund' ORDER BY amount_minor`,
    [BRAND, ORDER],
  );
  return r.rows.map((x) => ({ amount_minor: x.amount_minor, raw: x.ledger_event_id }));
}

async function cleanup() {
  await superPool.query(`DELETE FROM realized_revenue_ledger WHERE brand_id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM brand WHERE id=$1`, [BRAND]).catch(() => {});
  await superPool.query(`DELETE FROM organization WHERE id=$1`, [ORG]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPER, connectionTimeoutMillis: 4000, max: 3 });
    await superPool.query('SELECT 1');
    writer = new LedgerWriter(APP);
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'RF',$2,$3)`, [ORG, `rf-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'RF','INR','active')`, [BRAND, ORG]);
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await writer?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
});

const route = (buf: Buffer) => routeLiveOrderToLedger(buf, BRAND, `evt-${++evt}`, writer);

describe('refund → ledger reversal (live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[refund-ledger] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('RR1+RR3: two distinct same-day refunds → two NEGATIVE refund rows', async () => {
    if (!pgAvailable) return;
    await route(orderEvent([
      { refund_id: 'rf-1', amount_minor: '15000', processed_at: '2026-06-11T09:00:00.000Z' },
      { refund_id: 'rf-2', amount_minor: '5000', processed_at: '2026-06-11T12:00:00.000Z' },
    ]));
    const rows = await refundRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount_minor).sort()).toEqual(['-15000', '-5000']);
  });

  it('RR2: re-delivering the same event is idempotent (still two rows)', async () => {
    if (!pgAvailable) return;
    await route(orderEvent([
      { refund_id: 'rf-1', amount_minor: '15000', processed_at: '2026-06-11T09:00:00.000Z' },
      { refund_id: 'rf-2', amount_minor: '5000', processed_at: '2026-06-11T12:00:00.000Z' },
    ]));
    expect(await refundRows()).toHaveLength(2);
  });

  it('RR4: a restatement adding a 3rd refund writes only the new one', async () => {
    if (!pgAvailable) return;
    await route(orderEvent([
      { refund_id: 'rf-1', amount_minor: '15000', processed_at: '2026-06-11T09:00:00.000Z' },
      { refund_id: 'rf-2', amount_minor: '5000', processed_at: '2026-06-11T12:00:00.000Z' },
      { refund_id: 'rf-3', amount_minor: '2500', processed_at: '2026-06-12T09:00:00.000Z' },
    ]));
    const rows = await refundRows();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.amount_minor).sort()).toEqual(['-15000', '-2500', '-5000']);
  });

  it('skips a refund with no refund_id or zero amount (no fabricated row)', async () => {
    if (!pgAvailable) return;
    const before = (await refundRows()).length;
    await route(orderEvent([
      { refund_id: '', amount_minor: '9999' },          // no id → skip
      { refund_id: 'rf-zero', amount_minor: '0' },        // zero → skip
    ] as Array<{ refund_id: string; amount_minor: string }>));
    expect(await refundRows()).toHaveLength(before);
  });
});
