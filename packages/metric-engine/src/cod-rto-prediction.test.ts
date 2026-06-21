/**
 * cod-rto-prediction.test.ts — unit tests for computeRtoRiskDistribution (RTO-risk distribution).
 *
 * Re-pointed to the silver_checkout_signal Silver seam: tests inject a fully-mocked SilverScope
 * (withSilverBrand → runScoped) returning ONE aggregate row (the latest-per-order bucket counts).
 * No DB required. All assertions are SPEC-DERIVED LITERALS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return {
    ...actual,
    withSilverBrand: vi.fn(),
  };
});

import { computeRtoRiskDistribution } from './cod-rto-prediction.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000004';

function setupScope(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({ runScoped: async () => rows as never[] } as never),
  );
}

interface DistRow {
  total: string;
  high: string;
  medium: string;
  low: string;
  control: string;
  unknown: string;
  synthetic_cnt: string;
}

function distRow(o: Partial<DistRow> = {}): DistRow {
  return { total: '0', high: '0', medium: '0', low: '0', control: '0', unknown: '0', synthetic_cnt: '0', ...o };
}

beforeEach(() => vi.clearAllMocks());

describe('computeRtoRiskDistribution — RTO-risk distribution (silver_checkout_signal)', () => {
  it('hasData=false when there are no predictions in the window', async () => {
    setupScope([distRow({ total: '0' })]);
    const r = await computeRtoRiskDistribution(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(false);
    expect(r.orderCount).toBe(0n);
    expect(r.high).toBe(0n);
    expect(r.dataSource).toBe('live');
  });

  it('buckets the latest-per-order risk flags exactly', async () => {
    setupScope([
      distRow({ total: '10', high: '3', medium: '2', low: '4', control: '1', unknown: '0', synthetic_cnt: '0' }),
    ]);
    const r = await computeRtoRiskDistribution(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(true);
    expect(r.orderCount).toBe(10n);
    expect(r.high).toBe(3n);
    expect(r.medium).toBe(2n);
    expect(r.low).toBe(4n);
    expect(r.control).toBe(1n);
    expect(r.unknown).toBe(0n);
    expect(r.dataSource).toBe('live');
  });

  it('counts an unrecognized/missing flag into unknown', async () => {
    setupScope([distRow({ total: '5', high: '2', unknown: '3' })]);
    const r = await computeRtoRiskDistribution(BRAND_ID, fakeDeps);
    expect(r.orderCount).toBe(5n);
    expect(r.unknown).toBe(3n);
  });

  it('dataSource is "synthetic" when any contributing row is synthetic', async () => {
    setupScope([distRow({ total: '4', high: '4', synthetic_cnt: '4' })]);
    const r = await computeRtoRiskDistribution(BRAND_ID, fakeDeps);
    expect(r.dataSource).toBe('synthetic');
  });

  it('all count fields are bigint (I-S07 — no floats)', async () => {
    setupScope([distRow({ total: '2', high: '1', low: '1' })]);
    const r = await computeRtoRiskDistribution(BRAND_ID, fakeDeps);
    expect(typeof r.orderCount).toBe('bigint');
    expect(typeof r.high).toBe('bigint');
  });
});
