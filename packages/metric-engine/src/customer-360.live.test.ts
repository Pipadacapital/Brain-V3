/**
 * customer-360.live.test.ts — getCustomer360Summary against live StarRocks (Phase E).
 * SELF-SEEDS its 3 fixture rows into brain_gold.gold_customer_360 for a synthetic test brand, asserts,
 * and cleans up — so it is ROBUST to a dbt rebuild of the mart from real data (which legitimately
 * replaces any manually-seeded fixtures). SKIPS if StarRocks is unreachable.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { getCustomer360Summary } from './customer-360.js';
import type { SilverPool } from './silver-deps.js';

const HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? 9030);
const BRAND = 'aaaa0000-0000-0000-0000-000000000001';

let pool: mysql.Pool;
let up = false;

beforeAll(async () => {
  try {
    pool = mysql.createPool({ host: HOST, port: PORT, user: 'root', password: '', database: 'brain_gold', connectionLimit: 2 });
    await pool.query('SELECT 1');
    // Self-seed the fixture (idempotent): b1=175000/2 orders, b2=50000/1, b3=0/1 → 3 customers,
    // 225000 total, 4 orders, top=b1. All NOT-NULL columns provided; PRIMARY-KEY upsert on re-run.
    await pool.query('DELETE FROM gold_customer_360 WHERE brand_id = ?', [BRAND]);
    const cols = '(brand_id,brain_id,lifetime_orders,lifetime_value_minor,currency_code,first_seen_at,'
      + 'first_identified_at,last_seen_at,delivered_orders,rto_orders,cancelled_orders,refunded_orders,'
      + 'customer_watermark,updated_at)';
    const row = (b: string, o: number, v: number) =>
      `('${BRAND}','${b}',${o},${v},'INR',NOW(),NOW(),NOW(),${o},0,0,0,NOW(),NOW())`;
    await pool.query(`INSERT INTO gold_customer_360 ${cols} VALUES ${row('b1', 2, 175000)},${row('b2', 1, 50000)},${row('b3', 1, 0)}`);
    up = true;
  } catch {
    up = false;
  }
});

afterAll(async () => {
  if (pool) {
    await pool.query('DELETE FROM gold_customer_360 WHERE brand_id = ?', [BRAND]).catch(() => undefined);
    await pool.end();
  }
});

describe('getCustomer360Summary (gold_customer_360)', () => {
  it('summarizes the brand customer base + top customers from the Gold mart', async () => {
    if (!up) return;
    const r = await getCustomer360Summary(BRAND, { srPool: pool as unknown as SilverPool });
    expect(r.hasData).toBe(true);
    expect(r.customerCount).toBe(3n);            // b1, b2, b3
    expect(r.totalLifetimeValueMinor).toBe(225000n); // 175000 + 50000 + 0
    expect(r.totalLifetimeOrders).toBe(4n);      // o1..o4
    expect(r.topCustomers[0]?.brainId).toBe('b1'); // highest value (175000)
    expect(r.topCustomers[0]?.lifetimeValueMinor).toBe(175000n);
  });
});
