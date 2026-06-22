import { describe, it, expect } from 'vitest';
import { getCustomerCommerce } from './customer-commerce.js';
import type { SilverPool, SilverConnection } from './silver-deps.js';

const BRAND = '33333333-3333-4333-8333-333333333333';
const BRAIN = '44444444-4444-4444-8444-444444444444';

function fakePool(rows: Array<Record<string, unknown>>): SilverPool {
  const conn: SilverConnection = {
    async query(sql: string): Promise<[unknown, unknown]> {
      if (/^\s*SET\b/i.test(sql)) return [[], []];
      return [rows, []];
    },
    release() {},
  };
  return { async query() { return [[], []]; }, async getConnection() { return conn; } };
}

describe('getCustomerCommerce — per-customer Customer-360 commerce profile (H7)', () => {
  it('assembles the commerce profile (LTV + lifecycle breakdown) for a brain_id', async () => {
    const pool = fakePool([{
      currency_code: 'INR', lifetime_orders: 4, lifetime_value_minor: '120000',
      delivered_orders: 3, rto_orders: 1, cancelled_orders: 0, refunded_orders: 0,
      first_seen_at: '2026-01-02 00:00:00', last_seen_at: '2026-06-01 00:00:00',
    }]);
    const p = await getCustomerCommerce(BRAND, BRAIN, { srPool: pool });
    expect(p).toMatchObject({
      brainId: BRAIN, currencyCode: 'INR', lifetimeOrders: 4, lifetimeValueMinor: 120000n,
      deliveredOrders: 3, rtoOrders: 1,
    });
  });

  it('returns null when the customer has no commerce footprint (identity-only is valid)', async () => {
    expect(await getCustomerCommerce(BRAND, BRAIN, { srPool: fakePool([]) })).toBeNull();
  });

  it('returns null for an invalid brain_id (never a malformed query)', async () => {
    expect(await getCustomerCommerce(BRAND, 'not-a-uuid', { srPool: fakePool([]) })).toBeNull();
  });
});
