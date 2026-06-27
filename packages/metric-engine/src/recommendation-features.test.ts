/**
 * recommendation-features.test.ts — unit tests for getRecommendationFeatures (Gold recommendation
 * features seam over brain_serving.mv_gold_recommendation_features).
 *
 * Tests inject a fully-mocked SilverScope (withSilverBrand → runScoped) returning the count row then
 * the per-customer feature rows. No DB required. Money is asserted as bigint minor units; integer day
 * counts as number|null. All assertions are spec-derived literals (mutation-resistant).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return {
    ...actual,
    withSilverBrand: vi.fn(),
  };
});

import { getRecommendationFeatures } from './recommendation-features.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000002';

/**
 * Mock the seam so runScoped returns `countRows` for the first (COUNT) call and `featureRows` for the
 * second (rows) call — matching the two sequential runScoped invocations in getRecommendationFeatures.
 */
function setupScope(countRows: unknown[], featureRows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) => {
    let call = 0;
    return fn({
      runScoped: async () => (call++ === 0 ? countRows : featureRows) as never[],
    } as never);
  });
}

beforeEach(() => vi.clearAllMocks());

describe('getRecommendationFeatures — Gold recommendation features', () => {
  it('hasData=false and empty rows when the brand has no customers', async () => {
    setupScope([{ customer_count: '0' }], []);
    const result = await getRecommendationFeatures(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(false);
    expect(result.customerCount).toBe(0n);
    expect(result.rows).toEqual([]);
  });

  it('maps a feature row: money as bigint minor, counts as bigint, days as number', async () => {
    setupScope(
      [{ customer_count: '1' }],
      [
        {
          brain_id: 'brain-1',
          recency_days: '12',
          frequency: '4',
          monetary_minor: '96419747',
          currency_code: 'INR',
          top_channel: 'paid_meta',
          distinct_products: '7',
          tenure_days: '365',
        },
      ],
    );
    const result = await getRecommendationFeatures(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(true);
    expect(result.customerCount).toBe(1n);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.brainId).toBe('brain-1');
    expect(row.recencyDays).toBe(12);
    expect(row.frequency).toBe(4n);
    expect(row.monetaryMinor).toBe(96419747n);
    expect(row.currencyCode).toBe('INR');
    expect(row.topChannel).toBe('paid_meta');
    expect(row.distinctProducts).toBe(7n);
    expect(row.tenureDays).toBe(365);
  });

  it('null behavioural/temporal fields degrade to null (anon-only / no last-seen)', async () => {
    setupScope(
      [{ customer_count: '1' }],
      [
        {
          brain_id: 'brain-2',
          recency_days: null,
          frequency: '0',
          monetary_minor: '0',
          currency_code: null,
          top_channel: null,
          distinct_products: '0',
          tenure_days: null,
        },
      ],
    );
    const result = await getRecommendationFeatures(BRAND_ID, fakeDeps);
    const row = result.rows[0]!;
    expect(row.recencyDays).toBe(null);
    expect(row.topChannel).toBe(null);
    expect(row.currencyCode).toBe(null);
    expect(row.tenureDays).toBe(null);
    expect(row.monetaryMinor).toBe(0n);
    expect(row.distinctProducts).toBe(0n);
  });

  it('truncates a decimal-formatted monetary value to bigint minor units', async () => {
    setupScope(
      [{ customer_count: '1' }],
      [
        {
          brain_id: 'brain-3',
          recency_days: 5,
          frequency: 2,
          monetary_minor: '500000.00',
          currency_code: 'AED',
          top_channel: 'direct',
          distinct_products: 3,
          tenure_days: 90,
        },
      ],
    );
    const result = await getRecommendationFeatures(BRAND_ID, fakeDeps);
    expect(result.rows[0]!.monetaryMinor).toBe(500000n);
  });
});
