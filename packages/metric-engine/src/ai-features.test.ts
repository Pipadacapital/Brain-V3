/**
 * ai-features.test.ts — unit tests for getAiFeatures (Gold ai_features serving seam).
 *
 * Injects a fully-mocked SilverScope (withSilverBrand → runScoped). The seam issues TWO scoped reads:
 *   1. summary  (SELECT COUNT(*) ... ) — feature_count / converted_count / currency_code
 *   2. rows     (SELECT brain_id, ...) — the per-customer feature vector
 * The mock routes by inspecting the SQL (COUNT(*) → summary, else → rows). No DB required.
 *
 * Assertions are SPEC-DERIVED LITERALS (mutation-resistant). Money parsed as BIGINT minor units.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return {
    ...actual,
    withSilverBrand: vi.fn(),
  };
});

import { getAiFeatures } from './ai-features.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000002';

/** Mock the seam: route the summary vs rows read by SQL content. */
function setupScope(summaryRow: unknown, rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({
      runScoped: async (sql: string) =>
        (sql.includes('COUNT(*)') ? [summaryRow] : rows) as never[],
    } as never),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('getAiFeatures — Gold ai_features serving seam', () => {
  it('hasData=false and empty vector when the brand has no feature rows', async () => {
    setupScope({ feature_count: '0', converted_count: '0', currency_code: null }, []);
    const result = await getAiFeatures(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(false);
    expect(result.featureCount).toBe(0n);
    expect(result.convertedCount).toBe(0n);
    expect(result.currencyCode).toBe(null);
    expect(result.features).toEqual([]);
  });

  it('summary money + counts parse as BIGINT minor units', async () => {
    setupScope(
      { feature_count: '3', converted_count: '2', currency_code: 'INR' },
      [
        {
          brain_id: 'b-1',
          order_count: '4',
          lifetime_value_minor: '120000',
          avg_order_value_minor: '30000',
          currency_code: 'INR',
          recency_days: 5,
          distinct_channels: '3',
          converted_flag: 1,
        },
      ],
    );
    const result = await getAiFeatures(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(true);
    expect(result.featureCount).toBe(3n);
    expect(result.convertedCount).toBe(2n);
    expect(result.currencyCode).toBe('INR');
    expect(result.features).toHaveLength(1);
    const f = result.features[0]!;
    expect(f.brainId).toBe('b-1');
    expect(f.orderCount).toBe(4n);
    expect(f.lifetimeValueMinor).toBe(120000n);
    expect(f.avgOrderValueMinor).toBe(30000n);
    expect(f.currencyCode).toBe('INR');
    expect(f.recencyDays).toBe(5);
    expect(f.distinctChannels).toBe(3n);
    expect(f.convertedFlag).toBe(true);
  });

  it('converted_flag honors both boolean true and numeric 1; false otherwise', async () => {
    setupScope(
      { feature_count: '3', converted_count: '2', currency_code: 'USD' },
      [
        { brain_id: 'a', order_count: '1', lifetime_value_minor: '10', avg_order_value_minor: '10', currency_code: 'USD', recency_days: 1, distinct_channels: '1', converted_flag: true },
        { brain_id: 'b', order_count: '1', lifetime_value_minor: '10', avg_order_value_minor: '10', currency_code: 'USD', recency_days: 1, distinct_channels: '1', converted_flag: 1 },
        { brain_id: 'c', order_count: '0', lifetime_value_minor: '0', avg_order_value_minor: '0', currency_code: 'USD', recency_days: null, distinct_channels: '0', converted_flag: 0 },
      ],
    );
    const result = await getAiFeatures(BRAND_ID, fakeDeps);
    expect(result.features.map((f) => f.convertedFlag)).toEqual([true, true, false]);
  });

  it('null recency_days maps to null (honest, never coerced to 0)', async () => {
    setupScope(
      { feature_count: '1', converted_count: '0', currency_code: 'AED' },
      [{ brain_id: 'x', order_count: '0', lifetime_value_minor: '0', avg_order_value_minor: '0', currency_code: 'AED', recency_days: null, distinct_channels: '0', converted_flag: 0 }],
    );
    const result = await getAiFeatures(BRAND_ID, fakeDeps);
    expect(result.features[0]!.recencyDays).toBe(null);
  });

  it('large minor-unit value survives as BIGINT (no float precision loss)', async () => {
    setupScope(
      { feature_count: '1', converted_count: '1', currency_code: 'INR' },
      [{ brain_id: 'whale', order_count: '7', lifetime_value_minor: '9007199254740993', avg_order_value_minor: '1286742750677284', currency_code: 'INR', recency_days: 2, distinct_channels: '5', converted_flag: 1 }],
    );
    const result = await getAiFeatures(BRAND_ID, fakeDeps);
    expect(result.features[0]!.lifetimeValueMinor).toBe(9007199254740993n);
    expect(result.features[0]!.avgOrderValueMinor).toBe(1286742750677284n);
  });
});
