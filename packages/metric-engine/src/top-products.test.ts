/**
 * top-products.test.ts — unit tests for computeTopProducts (Silver order-line rollup).
 *
 * Tests the pure fold (BIGINT units/GMV/order-count + currency pick + honest no_data) by
 * mocking the Silver seam (withSilverBrand) with a pass-through whose runScoped returns
 * fixture rows. No StarRocks required (the SQL itself is verified live separately).
 *
 * SPEC-DERIVED LITERALS only — every assertion is a concrete value from the fixture.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return { ...actual, withSilverBrand: vi.fn() };
});

import { computeTopProducts } from './top-products.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const BRAND_ID = '00000000-0000-0000-0000-000000000001';
const fakeDeps = { srPool: {} as never };
const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-18T23:59:59Z') };

let lastSql = '';
let lastParams: unknown[] = [];
function setupRows(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_pool, _brandId, fn) => {
    const scope = {
      runScoped: vi.fn(async (sql: string, params: unknown[]) => {
        lastSql = sql;
        lastParams = params;
        return rows;
      }),
    };
    return fn(scope as never);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lastSql = '';
  lastParams = [];
});

describe('computeTopProducts — Silver order-line product rollup', () => {
  it('hasData=false on zero Silver rows (honest no_data, never an empty fabricated list)', async () => {
    setupRows([]);
    const r = await computeTopProducts(BRAND_ID, fakeDeps, RANGE);
    expect(r.hasData).toBe(false);
    expect(r.currencyCode).toBe(null);
    expect(r.products).toEqual([]);
  });

  it('maps units / line GMV / order count to exact bigints + picks the currency', async () => {
    setupRows([
      { sku: 'SKU-A', title: 'Aye', units: '12', line_gmv_minor: '600000', order_count: '8', currency_code: 'INR' },
      { sku: 'SKU-B', title: 'Bee', units: '3', line_gmv_minor: '75150', order_count: '3', currency_code: 'INR' },
    ]);
    const r = await computeTopProducts(BRAND_ID, fakeDeps, RANGE);
    expect(r.hasData).toBe(true);
    expect(r.currencyCode).toBe('INR');
    expect(r.products).toHaveLength(2);
    expect(r.products[0]).toEqual({ sku: 'SKU-A', title: 'Aye', units: 12n, lineGmvMinor: 600000n, orderCount: 8n });
    expect(r.products[1]).toEqual({ sku: 'SKU-B', title: 'Bee', units: 3n, lineGmvMinor: 75150n, orderCount: 3n });
  });

  it('tolerates a null title and numeric (non-string) column values from the driver', async () => {
    setupRows([{ sku: 'SKU-C', title: null, units: 5, line_gmv_minor: 250000, order_count: 5, currency_code: 'AED' }]);
    const r = await computeTopProducts(BRAND_ID, fakeDeps, RANGE);
    expect(r.products[0]).toEqual({ sku: 'SKU-C', title: null, units: 5n, lineGmvMinor: 250000n, orderCount: 5n });
    expect(r.currencyCode).toBe('AED');
  });

  it('clamps the limit into [1, 50] and binds the [from,to] window as StarRocks timestamps', async () => {
    setupRows([{ sku: 'X', title: 'X', units: '1', line_gmv_minor: '1', order_count: '1', currency_code: 'INR' }]);
    await computeTopProducts(BRAND_ID, fakeDeps, RANGE, 999);
    expect(lastSql).toMatch(/LIMIT 50/);          // clamped to MAX_LIMIT
    expect(lastSql).toContain('GROUP BY sku');
    expect(lastSql).toContain('ORDER BY line_gmv_minor DESC');
    expect(lastParams).toEqual(['2026-06-01 00:00:00', '2026-06-18 23:59:59']);

    await computeTopProducts(BRAND_ID, fakeDeps, RANGE, 0);
    expect(lastSql).toMatch(/LIMIT 10/);          // 0 → DEFAULT_LIMIT
  });
});
