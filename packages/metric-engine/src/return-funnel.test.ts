/**
 * return-funnel.test.ts — unit tests for the RETURN funnel seam (SR-10, silver_return mart).
 *
 * Tests the pure folds (per-return_class counts in deterministic order + integer completion% +
 * honest no_data + by-courier rollup) by mocking the Silver seam (withSilverBrand) with a
 * pass-through that routes each runScoped call to fixture rows by SQL shape. No Trino required.
 *
 * SPEC-DERIVED LITERALS only — every assertion is a concrete value derived from the fixture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return { ...actual, withSilverBrand: vi.fn() };
});

import { computeReturnFunnel } from './return-funnel.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);

const BRAND_ID = '00000000-0000-0000-0000-000000000001';
const fakeDeps = { srPool: {} as never };
const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-30T23:59:59Z') };

/** Route each query to the right fixture set by SQL fingerprint (summary / by-class / by-courier). */
function setup(opts: {
  summary?: { total: number; completed: number };
  byClass?: { return_class: string; count: number }[];
  byCourier?: { k: string; total: number; completed: number }[];
}) {
  withSilverBrandMock.mockImplementation(async (_pool, _brandId, fn) => {
    const scope = {
      runScoped: vi.fn(async (sql: string) => {
        if (/GROUP BY return_class/.test(sql)) return opts.byClass ?? [];
        if (/GROUP BY courier/.test(sql)) return opts.byCourier ?? [];
        return opts.summary ? [opts.summary] : [{ total: 0, completed: 0 }];
      }),
    };
    return fn(scope as never);
  });
}

beforeEach(() => vi.clearAllMocks());

describe('computeReturnFunnel', () => {
  it('hasData=false when the brand has zero returns in the window (honest no_data)', async () => {
    setup({ summary: { total: 0, completed: 0 } });
    const r = await computeReturnFunnel(BRAND_ID, fakeDeps, RANGE);
    expect(r.hasData).toBe(false);
    expect(r.total).toBe(0n);
    expect(r.byClass).toEqual([]);
    expect(r.byCourier).toEqual([]);
  });

  it('folds counts + completion% (integer bps) and orders buckets initiated→completed', async () => {
    // total=10, completed=4 → completion% = 4/10 = 40.00
    setup({
      summary: { total: 10, completed: 4 },
      byClass: [
        // intentionally OUT of funnel order to prove deterministic re-ordering
        { return_class: 'return_completed', count: 4 },
        { return_class: 'return_initiated', count: 3 },
        { return_class: 'return_in_transit', count: 2 },
        { return_class: 'return_delivered', count: 1 },
      ],
    });
    const r = await computeReturnFunnel(BRAND_ID, fakeDeps, RANGE);
    expect(r.hasData).toBe(true);
    expect(r.total).toBe(10n);
    expect(r.completed).toBe(4n);
    expect(r.inProgress).toBe(6n);
    expect(r.completionPct).toBe('40.00');
    expect(r.byClass.map((b) => b.return_class)).toEqual([
      'return_initiated',
      'return_in_transit',
      'return_delivered',
      'return_completed',
    ]);
    expect(r.byClass.map((b) => b.count)).toEqual([3n, 2n, 1n, 4n]);
  });

  it('omits empty return_class buckets and rolls up by courier', async () => {
    setup({
      summary: { total: 5, completed: 5 },
      byClass: [{ return_class: 'return_completed', count: 5 }],
      byCourier: [
        { k: 'Delhivery', total: 3, completed: 3 },
        { k: 'BlueDart', total: 2, completed: 2 },
      ],
    });
    const r = await computeReturnFunnel(BRAND_ID, fakeDeps, RANGE);
    expect(r.completionPct).toBe('100.00');
    expect(r.byClass).toEqual([{ return_class: 'return_completed', count: 5n }]);
    expect(r.byCourier).toEqual([
      { courier: 'Delhivery', total: 3n, completed: 3n },
      { courier: 'BlueDart', total: 2n, completed: 2n },
    ]);
  });
});
