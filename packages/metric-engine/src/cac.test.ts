import { describe, it, expect } from 'vitest';
import { computeCac } from './cac.js';
import type { SilverPool, SilverConnection } from './silver-deps.js';

const BRAND = '22222222-2222-4222-8222-222222222222';
const WINDOW = { fromDate: new Date('2026-05-01T00:00:00Z'), toDate: new Date('2026-05-31T00:00:00Z') };

/** Fake StarRocks pool: SET succeeds; the gold_cac SELECT returns `rows`. */
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

describe('computeCac — CAC = spend ÷ new customers (honest, exact)', () => {
  it('computes CAC in minor units from exact integer operands', async () => {
    const pool = fakePool([
      { currency_code: 'INR', new_customers: 4, acquisition_spend_minor: '10000' },
    ]);
    const [row] = await computeCac(BRAND, WINDOW, { srPool: pool });
    expect(row).toMatchObject({ currency_code: 'INR', newCustomers: 4, acquisitionSpendMinor: 10000n });
    expect(row!.cacMinor).toBe('2500.0000'); // 10000 / 4
  });

  it('is HONEST: 0 new customers → cacMinor null (never divide-by-zero)', async () => {
    const pool = fakePool([
      { currency_code: 'INR', new_customers: 0, acquisition_spend_minor: '5000' },
    ]);
    const [row] = await computeCac(BRAND, WINDOW, { srPool: pool });
    expect(row!.newCustomers).toBe(0);
    expect(row!.acquisitionSpendMinor).toBe(5000n);
    expect(row!.cacMinor).toBeNull();
  });

  it('is per-currency and deterministically ordered (never blends currencies)', async () => {
    const pool = fakePool([
      { currency_code: 'INR', new_customers: 2, acquisition_spend_minor: '6000' },
      { currency_code: 'AED', new_customers: 1, acquisition_spend_minor: '3000' },
    ]);
    const rows = await computeCac(BRAND, WINDOW, { srPool: pool });
    expect(rows.map((r) => r.currency_code)).toEqual(['AED', 'INR']);
    expect(rows.find((r) => r.currency_code === 'INR')!.cacMinor).toBe('3000.0000');
    expect(rows.find((r) => r.currency_code === 'AED')!.cacMinor).toBe('3000.0000');
  });
});
