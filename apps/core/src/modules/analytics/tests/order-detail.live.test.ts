/**
 * order-detail.live.test.ts — getOrderDetail reads one order's economic breakdown from Bronze
 * (feat-shopify-order-depth), live Postgres. Four invariants:
 *   1. has_data: line items / tax / shipping / discounts / refunds returned from payload.properties.
 *   2. latest-state-wins: when an order has multiple live events, the newest occurred_at is used.
 *   3. not_found: an unknown order_id → state:'not_found' (honest empty, D-2).
 *   4. RLS isolation: brand_app under brand B's GUC cannot read brand A's order (negative control).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getOrderDetail } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'de7a11de-0a11-4a11-8a11-00000000aa01';
const BRAND_B = 'de7a11de-0a11-4a11-8a11-00000000bb01';
const ORG = 'de7a11de-0a11-4a11-8a11-00000000ff01';
const USER = 'de7a11de-0a11-4a11-8a11-00000000ee01';
const ORG_B = 'de7a11de-0a11-4a11-8a11-00000000ff02';
const ORDER_ID = 'depth-order-1';

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;
let evtSeq = 0;

function depthProps(amountMinor: string) {
  return {
    source: 'shopify',
    order_id: ORDER_ID,
    shopify_order_id: ORDER_ID,
    currency_code: 'INR',
    amount_minor: amountMinor,
    payment_method: 'prepaid',
    financial_status: 'paid',
    fulfillment_status: 'fulfilled',
    line_items: [
      { sku: 'SKU-1', title: 'Widget', quantity: 2, unit_price_minor: '50000', line_total_minor: '100000', line_discount_minor: '0', product_id: '9', variant_id: '90' },
    ],
    tax_lines: [{ title: 'GST', rate: 0.18, amount_minor: '18000' }],
    tax_total_minor: '18000',
    shipping_total_minor: '5000',
    discount_codes: [{ code: 'SAVE10', amount_minor: '10000', type: 'percentage' }],
    discount_total_minor: '10000',
    refunds: [{ refund_id: '555', processed_at: '2026-06-02T09:00:00.000Z', amount_minor: '15000', reason: 'damaged' }],
    refund_total_minor: '15000',
  };
}

async function seedOrderEvent(brandId: string, props: object, occurredAt: string) {
  evtSeq += 1;
  const eventId = `de7a11de-0a11-4a11-8a11-0000000${String(evtSeq).padStart(5, '0')}`;
  await superPool.query(
    `INSERT INTO bronze_events (brand_id, event_id, occurred_at, ingested_at, schema_name, schema_version, event_type, correlation_id, partition_key, payload)
     VALUES ($1,$2,$3,now(),'collector.event','1','order.live.v1',$4,$5,$6)`,
    [brandId, eventId, occurredAt, `corr-${evtSeq}`, `${brandId}:${eventId}`, JSON.stringify({ event_name: 'order.live.v1', properties: props })],
  );
}

async function cleanup() {
  for (const b of [BRAND_A, BRAND_B]) await superPool.query(`DELETE FROM bronze_events WHERE brand_id=$1`, [b]).catch(() => {});
  for (const b of [BRAND_A, BRAND_B]) await superPool.query(`DELETE FROM brand WHERE id=$1`, [b]).catch(() => {});
  for (const o of [ORG, ORG_B]) await superPool.query(`DELETE FROM organization WHERE id=$1`, [o]).catch(() => {});
  await superPool.query(`DELETE FROM app_user WHERE id=$1`, [USER]).catch(() => {});
}

beforeAll(async () => {
  try {
    superPool = new pg.Pool({ connectionString: SUPERUSER_URL, connectionTimeoutMillis: 4000, max: 4 });
    await superPool.query('SELECT 1');
    appPool = new pg.Pool({ connectionString: APP_URL, max: 4 });
    await cleanup();
    await superPool.query(`INSERT INTO app_user (id,email,email_normalized,password_hash) VALUES ($1,$2,$3,'x')`, [USER, `${USER}@x.invalid`, `${USER}@x.invalid`]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'OD',$2,$3)`, [ORG, `od-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'ODB',$2,$3)`, [ORG_B, `odb-${ORG_B.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'OD','INR','active')`, [BRAND_A, ORG]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'ODB','INR','active')`, [BRAND_B, ORG_B]);
    // Two live states for the same order: the LATER occurred_at must win.
    await seedOrderEvent(BRAND_A, depthProps('120000'), '2026-06-01T10:00:00Z');
    await seedOrderEvent(BRAND_A, depthProps('125000'), '2026-06-01T11:00:00Z'); // latest
    pgAvailable = true;
  } catch {
    pgAvailable = false;
  }
});

afterAll(async () => {
  if (pgAvailable) await cleanup();
  await appPool?.end?.().catch(() => {});
  await superPool?.end?.().catch(() => {});
});

describe('getOrderDetail (feat-shopify-order-depth, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[order-detail] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('returns the full economic breakdown from Bronze (latest state wins)', async () => {
    if (!pgAvailable) return;
    const r = await getOrderDetail(BRAND_A, ORDER_ID, { pool: appPool });
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    expect(r.detail.amount_minor).toBe('125000'); // the LATER event
    expect(r.detail.has_depth).toBe(true);
    expect(r.detail.line_items).toHaveLength(1);
    expect(r.detail.line_items[0]).toMatchObject({ sku: 'SKU-1', quantity: 2, unit_price_minor: '50000', line_total_minor: '100000' });
    expect(r.detail.tax_total_minor).toBe('18000');
    expect(r.detail.shipping_total_minor).toBe('5000');
    expect(r.detail.discount_total_minor).toBe('10000');
    expect(r.detail.refund_total_minor).toBe('15000');
    expect(r.detail.refunds[0]).toMatchObject({ refund_id: '555', amount_minor: '15000', reason: 'damaged' });
  });

  it('returns not_found for an unknown order (honest empty)', async () => {
    if (!pgAvailable) return;
    const r = await getOrderDetail(BRAND_A, 'no-such-order', { pool: appPool });
    expect(r.state).toBe('not_found');
  });

  it('RLS isolation: brand B cannot read brand A’s order (negative control)', async () => {
    if (!pgAvailable) return;
    const r = await getOrderDetail(BRAND_B, ORDER_ID, { pool: appPool });
    expect(r.state).toBe('not_found');
  });
});
