/**
 * cod-rto-rates.test.ts — unit tests for computeCodRtoRates (RTO% by pincode cohort)
 *
 * Re-pointed to the silver_shipment Silver seam: tests inject a fully-mocked SilverScope
 * (withSilverBrand → runScoped) returning per-(pincode, terminal_class) cohort rows. No DB required.
 *
 * All assertions are SPEC-DERIVED LITERALS — mutation-resistant. Row shape mirrors the live query:
 *   { pincode, terminal_class ∈ rto|delivered|other, cnt, synthetic_cnt }.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return {
    ...actual,
    withSilverBrand: vi.fn(),
  };
});

import { computeCodRtoRates } from './cod-rto-rates.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000002';

/** Mock the seam so runScoped returns the given cohort rows array. */
function setupScope(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({ runScoped: async () => rows as never[] } as never),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('computeCodRtoRates — RTO% by pincode cohort (silver_shipment)', () => {
  it('hasData=false and overallRtoRatePct=null when no terminal shipment rows exist', async () => {
    setupScope([]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(false);
    expect(result.overallRtoRatePct).toBe(null);
    expect(result.totalTerminal).toBe(0n);
    expect(result.totalRto).toBe(0n);
    expect(result.cohorts).toEqual([]);
  });

  it('overallRtoRatePct exact value: 3 RTO out of 12 terminal = 25.00', async () => {
    setupScope([
      { pincode: '110001', terminal_class: 'rto', cnt: '3', synthetic_cnt: '0' },
      { pincode: '110001', terminal_class: 'delivered', cnt: '9', synthetic_cnt: '0' },
    ]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(true);
    expect(result.totalTerminal).toBe(12n);
    expect(result.totalRto).toBe(3n);
    expect(result.overallRtoRatePct).toBe('25.00');
    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]?.pincode).toBe('110001');
    expect(result.cohorts[0]?.terminalCount).toBe(12n);
    expect(result.cohorts[0]?.rtoCount).toBe(3n);
    expect(result.cohorts[0]?.rtoRatePct).toBe('25.00');
  });

  it('non-round bps: 1 RTO out of 3 terminal = 33.33 (integer truncation)', async () => {
    setupScope([
      { pincode: '400001', terminal_class: 'rto', cnt: '1', synthetic_cnt: '0' },
      { pincode: '400001', terminal_class: 'delivered', cnt: '2', synthetic_cnt: '0' },
    ]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.totalTerminal).toBe(3n);
    expect(result.totalRto).toBe(1n);
    expect(result.overallRtoRatePct).toBe('33.33');
    expect(result.cohorts[0]?.rtoRatePct).toBe('33.33');
  });

  it('100% RTO rate: all terminal shipments are RTO = 100.00', async () => {
    setupScope([{ pincode: '560001', terminal_class: 'rto', cnt: '5', synthetic_cnt: '0' }]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.totalTerminal).toBe(5n);
    expect(result.totalRto).toBe(5n);
    expect(result.overallRtoRatePct).toBe('100.00');
  });

  it('0% RTO rate: no RTO shipments = 0.00', async () => {
    setupScope([{ pincode: '600001', terminal_class: 'delivered', cnt: '10', synthetic_cnt: '0' }]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.totalTerminal).toBe(10n);
    expect(result.totalRto).toBe(0n);
    expect(result.overallRtoRatePct).toBe('0.00');
    expect(result.cohorts[0]?.rtoRatePct).toBe('0.00');
  });

  it('dataSource is "synthetic" when any contributing row is synthetic-stamped', async () => {
    setupScope([
      { pincode: '110001', terminal_class: 'delivered', cnt: '5', synthetic_cnt: '3' },
      { pincode: '110001', terminal_class: 'rto', cnt: '2', synthetic_cnt: '2' },
    ]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.dataSource).toBe('synthetic');
  });

  it('dataSource is "live" when no synthetic rows', async () => {
    setupScope([{ pincode: '110001', terminal_class: 'delivered', cnt: '4', synthetic_cnt: '0' }]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.dataSource).toBe('live');
  });

  it('null pincode → "unknown" cohort + pincodePending=true when no real pincode', async () => {
    setupScope([
      { pincode: null, terminal_class: 'rto', cnt: '2', synthetic_cnt: '0' },
      { pincode: null, terminal_class: 'delivered', cnt: '3', synthetic_cnt: '0' },
    ]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.pincodePending).toBe(true);
    expect(result.cohorts).toHaveLength(1);
    expect(result.cohorts[0]?.pincode).toBe('unknown');
  });

  it('pincodePending=false when at least one row carries a real pincode', async () => {
    setupScope([{ pincode: '110001', terminal_class: 'delivered', cnt: '5', synthetic_cnt: '0' }]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.pincodePending).toBe(false);
  });

  it('only terminal_class=rto counts as RTO (other terminal classes do not)', async () => {
    setupScope([
      { pincode: '110001', terminal_class: 'rto', cnt: '5', synthetic_cnt: '0' },
      { pincode: '110001', terminal_class: 'delivered', cnt: '4', synthetic_cnt: '0' },
      { pincode: '110001', terminal_class: 'other', cnt: '1', synthetic_cnt: '0' },
    ]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.totalRto).toBe(5n);
    expect(result.totalTerminal).toBe(10n); // rto + delivered + other
    expect(result.overallRtoRatePct).toBe('50.00');
  });

  it('cohorts sorted descending by rtoCount then terminalCount', async () => {
    setupScope([
      { pincode: '111111', terminal_class: 'rto', cnt: '1', synthetic_cnt: '0' },
      { pincode: '111111', terminal_class: 'delivered', cnt: '4', synthetic_cnt: '0' },
      { pincode: '222222', terminal_class: 'rto', cnt: '3', synthetic_cnt: '0' },
      { pincode: '222222', terminal_class: 'delivered', cnt: '3', synthetic_cnt: '0' },
    ]);
    const result = await computeCodRtoRates(BRAND_ID, fakeDeps);
    expect(result.cohorts[0]?.pincode).toBe('222222'); // rtoCount=3 sorts first
    expect(result.cohorts[1]?.pincode).toBe('111111');
    expect(result.overallRtoRatePct).toBe('36.36'); // 4/11
  });
});
