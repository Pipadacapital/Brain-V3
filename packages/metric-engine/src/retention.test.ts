/**
 * retention.test.ts — unit tests for computeRetention (B7 — repeat-purchase / returning-customer
 * retention seam over brain_serving.mv_gold_retention).
 *
 * Tests inject a fully-mocked SilverScope (withSilverBrand → runScoped) returning the per-cohort rows.
 * No DB required. Rates are asserted as EXACT decimal strings derived from integer operands (no float);
 * the brand-level totals are asserted to be recomputed NON-additively from the SUMMED cohort components
 * (ADR-004). Counts are bigint. All assertions are spec-derived literals (mutation-resistant).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return {
    ...actual,
    withSilverBrand: vi.fn(),
  };
});

import { computeRetention } from './retention.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000002';

/** Mock the seam so the single runScoped call returns `rows`. */
function setupScope(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({ runScoped: async () => rows as never[] } as never),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('computeRetention — gold_retention cohort retention', () => {
  it('hasData=false, null rates and zero totals when the brand has no cohorts', async () => {
    setupScope([]);
    const result = await computeRetention(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(false);
    expect(result.cohorts).toEqual([]);
    expect(result.totals.cohortCustomers).toBe(0n);
    expect(result.totals.repeatPurchaseRatePct).toBeNull();
    expect(result.totals.returningCustomerRatePct).toBeNull();
    expect(result.totals.avgOrdersPerCustomer).toBeNull();
  });

  it('maps a cohort row: counts as bigint, stored bps re-expressed as exact percent/ratio strings', async () => {
    // cohort of 4 customers, 2 repeat (>=2 orders), 7 total orders, 3 repeat orders (7-4).
    //   repeat_purchase_rate = 2/4   = 5000 bps  = 50.00%
    //   returning_customer_rate = 3/7 = 4285 bps (integer floor) ≈ 42.85%
    //   avg_orders_per_customer = 7/4 = 17500 bps = 1.75
    setupScope([
      {
        cohort_month: '2026-01',
        currency_code: 'INR',
        cohort_customers: '4',
        repeat_customers: '2',
        total_orders: '7',
        repeat_orders: '3',
        repeat_purchase_rate_bps: '5000',
        returning_customer_rate_bps: '4285',
        avg_orders_per_customer_bps: '17500',
      },
    ]);
    const result = await computeRetention(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(true);
    expect(result.cohorts).toHaveLength(1);
    const c = result.cohorts[0]!;
    expect(c.cohortMonth).toBe('2026-01');
    expect(c.currencyCode).toBe('INR');
    expect(c.cohortCustomers).toBe(4n);
    expect(c.repeatCustomers).toBe(2n);
    expect(c.totalOrders).toBe(7n);
    expect(c.repeatOrders).toBe(3n);
    expect(c.repeatPurchaseRatePct).toBe('50.00'); // 5000 bps → 50.00%
    expect(c.returningCustomerRatePct).toBe('42.85'); // 4285 bps → 42.85%
    expect(c.avgOrdersPerCustomer).toBe('1.75'); // 7/4 recomputed exactly
  });

  it('totals are recomputed NON-additively from the SUMMED cohort components (ADR-004)', async () => {
    // Two cohorts; the brand headline rate must derive from the SUMS, not average the per-cohort rates.
    //   totals: customers = 4+6 = 10, repeat = 2+3 = 5, orders = 7+9 = 16, repeat_orders = 3+3 = 6
    //   repeat_purchase_rate = 5/10  = 50.00%
    //   returning_customer_rate = 6/16 = 37.50%
    //   avg_orders_per_customer = 16/10 = 1.60
    setupScope([
      {
        cohort_month: '2026-01',
        currency_code: 'INR',
        cohort_customers: '4',
        repeat_customers: '2',
        total_orders: '7',
        repeat_orders: '3',
        repeat_purchase_rate_bps: '5000',
        returning_customer_rate_bps: '4285',
        avg_orders_per_customer_bps: '17500',
      },
      {
        cohort_month: '2026-02',
        currency_code: 'INR',
        cohort_customers: '6',
        repeat_customers: '3',
        total_orders: '9',
        repeat_orders: '3',
        repeat_purchase_rate_bps: '5000',
        returning_customer_rate_bps: '3333',
        avg_orders_per_customer_bps: '15000',
      },
    ]);
    const result = await computeRetention(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(true);
    expect(result.totals.cohortCustomers).toBe(10n);
    expect(result.totals.repeatCustomers).toBe(5n);
    expect(result.totals.totalOrders).toBe(16n);
    expect(result.totals.repeatOrders).toBe(6n);
    expect(result.totals.repeatPurchaseRatePct).toBe('50.00');
    expect(result.totals.returningCustomerRatePct).toBe('37.50');
    expect(result.totals.avgOrdersPerCustomer).toBe('1.60');
  });

  it('null stored bps (e.g. zero-order cohort) surfaces as null rate, ratio still guarded', async () => {
    setupScope([
      {
        cohort_month: '2026-03',
        currency_code: 'INR',
        cohort_customers: '2',
        repeat_customers: '0',
        total_orders: '0',
        repeat_orders: '0',
        repeat_purchase_rate_bps: '0',
        returning_customer_rate_bps: null, // total_orders=0 → mart emits NULL
        avg_orders_per_customer_bps: '0',
      },
    ]);
    const result = await computeRetention(BRAND_ID, fakeDeps);
    const c = result.cohorts[0]!;
    expect(c.repeatPurchaseRatePct).toBe('0.00');
    expect(c.returningCustomerRatePct).toBeNull();
    expect(c.avgOrdersPerCustomer).toBe('0.00'); // 0/2 = 0.00, denominator guarded
  });
});
