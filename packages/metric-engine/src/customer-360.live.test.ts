/**
 * customer-360.live.test.ts — getCustomer360Summary against live StarRocks (Phase E).
 * Reads the seeded brain_gold.gold_customer_360 fixtures. SKIPS if StarRocks is unreachable.
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
    up = true;
  } catch {
    up = false;
  }
});

afterAll(async () => {
  if (pool) await pool.end();
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
