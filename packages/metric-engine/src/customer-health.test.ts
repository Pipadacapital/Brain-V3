/**
 * customer-health.test.ts — unit tests for getCustomerHealthSummary (deterministic per-customer
 * health/churn band over the Gold mart mv_gold_customer_health).
 *
 * Injects a fully-mocked SilverScope (withSilverBrand → runScoped). Two runScoped calls per invocation:
 *   1. the band-distribution summary row, 2. the at-risk customer list. We dispatch on call order.
 * All assertions are SPEC-DERIVED LITERALS — mutation-resistant. No DB required.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return { ...actual, withSilverBrand: vi.fn() };
});

import { getCustomerHealthSummary } from './customer-health.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000002';

/** Mock the seam: first runScoped → summary rows, second → at-risk rows. */
function setupScope(summaryRows: unknown[], riskRows: unknown[]) {
  let call = 0;
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({
      runScoped: async () => (call++ === 0 ? (summaryRows as never[]) : (riskRows as never[])),
    } as never),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('getCustomerHealthSummary', () => {
  it('hasData=false and zeroed counts when the brand has no customers', async () => {
    setupScope([{ customer_count: '0', healthy_count: '0', at_risk_count: '0', churned_count: '0' }], []);
    const result = await getCustomerHealthSummary(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(false);
    expect(result.customerCount).toBe(0n);
    expect(result.healthyCount).toBe(0n);
    expect(result.atRiskCount).toBe(0n);
    expect(result.churnedCount).toBe(0n);
    expect(result.atRiskCustomers).toEqual([]);
  });

  it('returns the band distribution as bigints', async () => {
    setupScope(
      [{ customer_count: '12', healthy_count: '7', at_risk_count: '3', churned_count: '2' }],
      [],
    );
    const result = await getCustomerHealthSummary(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(true);
    expect(result.customerCount).toBe(12n);
    expect(result.healthyCount).toBe(7n);
    expect(result.atRiskCount).toBe(3n);
    expect(result.churnedCount).toBe(2n);
  });

  it('maps at-risk customer rows: recency/score as numbers, frequency/value as bigint', async () => {
    setupScope(
      [{ customer_count: '2', healthy_count: '0', at_risk_count: '1', churned_count: '1' }],
      [
        {
          brain_id: 'brain-churned',
          recency_days: '240',
          frequency: '1',
          health_score: '5',
          health_band: 'churned',
          last_order_at: '2025-09-01T00:00:00Z',
          lifetime_value_minor: '150000',
          currency_code: 'INR',
        },
        {
          brain_id: 'brain-atrisk',
          recency_days: '120',
          frequency: '4',
          health_score: '35',
          health_band: 'at_risk',
          last_order_at: '2026-02-01T00:00:00Z',
          lifetime_value_minor: '450000',
          currency_code: 'INR',
        },
      ],
    );
    const result = await getCustomerHealthSummary(BRAND_ID, fakeDeps);
    expect(result.atRiskCustomers).toHaveLength(2);
    const churned = result.atRiskCustomers[0];
    expect(churned?.brainId).toBe('brain-churned');
    expect(churned?.recencyDays).toBe(240);
    expect(churned?.frequency).toBe(1n);
    expect(churned?.healthScore).toBe(5);
    expect(churned?.healthBand).toBe('churned');
    expect(churned?.lifetimeValueMinor).toBe(150000n);
    expect(churned?.currencyCode).toBe('INR');
    expect(result.atRiskCustomers[1]?.healthBand).toBe('at_risk');
  });

  it('defaults an unknown band to at_risk and null money to 0n', async () => {
    setupScope(
      [{ customer_count: '1', healthy_count: '0', at_risk_count: '1', churned_count: '0' }],
      [
        {
          brain_id: 'brain-x',
          recency_days: '100',
          frequency: '2',
          health_score: '30',
          health_band: null,
          last_order_at: null,
          lifetime_value_minor: null,
          currency_code: null,
        },
      ],
    );
    const result = await getCustomerHealthSummary(BRAND_ID, fakeDeps);
    const row = result.atRiskCustomers[0];
    expect(row?.healthBand).toBe('at_risk');
    expect(row?.lifetimeValueMinor).toBe(0n);
    expect(row?.currencyCode).toBe(null);
    expect(row?.lastOrderAt).toBe(null);
  });
});
