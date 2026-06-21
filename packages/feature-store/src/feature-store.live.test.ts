/**
 * feature-store.live.test.ts — offline→online materialization + parity, live (Phase F).
 * Reads gold_customer_360 fixtures (StarRocks), materializes customer features to Redis, and asserts
 * the online-served value equals the offline-computed value (no train/serve skew). SKIPS if infra down.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { RedisOnlineStore, materializeCustomerFeatures, CUSTOMER_FEATURES, type Customer360Row } from './index.js';

const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? 9030);
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const BRAND = 'aaaa0000-0000-0000-0000-000000000001';

let sr: mysql.Pool;
let store: RedisOnlineStore;
let rows: Customer360Row[] = [];
let up = false;

beforeAll(async () => {
  try {
    sr = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: 'root', password: '', database: 'brain_gold', connectionLimit: 2 });
    const [res] = await sr.query(
      'SELECT brain_id, lifetime_value_minor, lifetime_orders, delivered_orders, rto_orders FROM gold_customer_360 WHERE brand_id = ?',
      [BRAND],
    );
    rows = (res as Record<string, unknown>[]).map((r) => ({
      brain_id: String(r['brain_id']),
      lifetime_value_minor: Number(r['lifetime_value_minor']),
      lifetime_orders: Number(r['lifetime_orders']),
      delivered_orders: Number(r['delivered_orders']),
      rto_orders: Number(r['rto_orders']),
    }));
    store = new RedisOnlineStore(REDIS_URL);
    await store.purgeBrand(BRAND);
    up = rows.length > 0;
  } catch {
    up = false;
  }
});

afterAll(async () => {
  if (store) { await store.purgeBrand(BRAND); await store.close(); }
  if (sr) await sr.end();
});

describe('feature-store — offline→online materialization + parity', () => {
  it('materializes every customer feature to Redis with offline/online parity', async () => {
    if (!up) return;
    const { customers, featuresWritten } = await materializeCustomerFeatures(BRAND, rows, store, '2026-06-22T00:00:00Z');
    expect(customers).toBe(rows.length);
    expect(featuresWritten).toBe(rows.length * CUSTOMER_FEATURES.length);

    for (const row of rows) {
      for (const def of CUSTOMER_FEATURES) {
        const served = await store.get(BRAND, row.brain_id, def.name);
        expect(served, `${def.name} for ${row.brain_id}`).not.toBeNull();
        expect(served!.value).toBe(def.compute(row)); // online == offline (no skew)
      }
    }
  });

  it('computes the expected deterministic values for the seeded top customer (b1: 2 delivered/2 orders)', async () => {
    if (!up) return;
    const b1 = rows.find((r) => r.brain_id === 'b1');
    if (!b1) return;
    expect((await store.get(BRAND, 'b1', 'ltv_minor'))!.value).toBe(175000);
    expect((await store.get(BRAND, 'b1', 'purchase_probability'))!.value).toBe(1);
    expect((await store.get(BRAND, 'b1', 'rto_risk'))!.value).toBe(0);
  });
});
