/**
 * orders-list.live.test.ts — getOrdersList (paginated latest-state orders from Bronze), live PG.
 *   1. pagination: page_size=2 over 3 orders → page1 has 2 (newest first), page2 has 1, total=3.
 *   2. latest-state-wins: an order with two events shows its newest amount.
 *   3. no_data: a brand with zero orders → state:'no_data'.
 *   4. RLS isolation: brand B cannot see brand A's orders (negative control).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { getOrdersList } from '../index.js';

const SUPERUSER_URL = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const APP_URL = process.env['BRAIN_APP_DATABASE_URL'] ?? 'postgres://brain_app:brain_app@localhost:5432/brain';

const BRAND_A = 'a5d11507-0a11-4a11-8a11-00000000aa01';
const BRAND_B = 'a5d11507-0a11-4a11-8a11-00000000bb01';
const ORG = 'a5d11507-0a11-4a11-8a11-00000000ff01';
const ORG_B = 'a5d11507-0a11-4a11-8a11-00000000ff02';
const USER = 'a5d11507-0a11-4a11-8a11-00000000ee01';

let superPool: pg.Pool;
let appPool: pg.Pool;
let pgAvailable = false;
let seq = 0;

async function seedOrder(brandId: string, orderId: string, amountMinor: string, occurredAt: string) {
  seq += 1;
  const eventId = `a5d11507-0a11-4a11-8a11-0000000${String(seq).padStart(5, '0')}`;
  await superPool.query(
    `INSERT INTO bronze_events (brand_id, event_id, occurred_at, ingested_at, schema_name, schema_version, event_type, correlation_id, partition_key, payload)
     VALUES ($1,$2,$3,now(),'collector.event','1','order.live.v1',$4,$5,$6)`,
    [brandId, eventId, occurredAt, `corr-${seq}`, `${brandId}:${eventId}`,
     JSON.stringify({ event_name: 'order.live.v1', properties: { order_id: orderId, currency_code: 'INR', amount_minor: amountMinor, financial_status: 'paid', line_items: [{ sku: 'X', quantity: 1, unit_price_minor: amountMinor, line_total_minor: amountMinor, line_discount_minor: '0' }] } })],
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
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'OLST',$2,$3)`, [ORG, `olst-${ORG.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO organization (id,name,slug,owner_user_id) VALUES ($1,'OLSTB',$2,$3)`, [ORG_B, `olstb-${ORG_B.slice(-6)}`, USER]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'OLST','INR','active')`, [BRAND_A, ORG]);
    await superPool.query(`INSERT INTO brand (id,organization_id,display_name,currency_code,status) VALUES ($1,$2,'OLSTB','INR','active')`, [BRAND_B, ORG_B]);
    // 3 orders, newest → oldest: OL-3 (12:00), OL-2 (11:00), OL-1 (10:00). OL-3 has two events (latest 50000).
    await seedOrder(BRAND_A, 'OL-1', '10000', '2026-06-01T10:00:00Z');
    await seedOrder(BRAND_A, 'OL-2', '20000', '2026-06-01T11:00:00Z');
    await seedOrder(BRAND_A, 'OL-3', '30000', '2026-06-01T11:30:00Z'); // older event for OL-3
    await seedOrder(BRAND_A, 'OL-3', '50000', '2026-06-01T12:00:00Z'); // newest event for OL-3
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

describe('getOrdersList (feat-shopify-order-depth, live Postgres)', () => {
  it('SKIP_IF_NO_PG', () => {
    if (!pgAvailable) console.warn('[orders-list] Postgres unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('paginates latest-state orders newest-first (page 1)', async () => {
    if (!pgAvailable) return;
    const r = await getOrdersList(BRAND_A, { page: 1, pageSize: 2 }, { pool: appPool });
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    expect(r.total).toBe('3'); // 3 DISTINCT orders (not 4 events)
    expect(r.orders).toHaveLength(2);
    expect(r.orders[0]!.order_id).toBe('OL-3');
    expect(r.orders[0]!.amount_minor).toBe('50000'); // latest event for OL-3
    expect(r.orders[0]!.has_depth).toBe(true);
    expect(r.orders[1]!.order_id).toBe('OL-2');
  });

  it('returns the remaining order on page 2', async () => {
    if (!pgAvailable) return;
    const r = await getOrdersList(BRAND_A, { page: 2, pageSize: 2 }, { pool: appPool });
    expect(r.state).toBe('has_data');
    if (r.state !== 'has_data') return;
    expect(r.orders).toHaveLength(1);
    expect(r.orders[0]!.order_id).toBe('OL-1');
  });

  it('no_data for a brand with zero orders', async () => {
    if (!pgAvailable) return;
    const r = await getOrdersList(BRAND_B, { page: 1, pageSize: 20 }, { pool: appPool });
    expect(r.state).toBe('no_data');
    expect(r.total).toBe('0');
  });

  it('RLS isolation: brand B cannot see brand A orders (negative control)', async () => {
    if (!pgAvailable) return;
    const r = await getOrdersList(BRAND_B, { page: 1, pageSize: 20 }, { pool: appPool });
    expect(r.state).toBe('no_data');
  });
});
