/**
 * checkout-funnel.test.ts — unit tests for computeCheckoutFunnel (Shopflo abandoned checkout)
 *
 * Re-pointed to the silver_checkout_signal Silver seam: tests inject a fully-mocked SilverScope
 * (withSilverBrand → runScoped) returning ONE aggregate row. currency_code now rides on the row
 * (the mapper stamps it into the Silver mart) — no separate brand read. No DB required.
 *
 * All assertions are SPEC-DERIVED LITERALS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return {
    ...actual,
    withSilverBrand: vi.fn(),
  };
});

import { computeCheckoutFunnel } from './checkout-funnel.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000003';

/** Mock the seam so runScoped returns the given aggregate row array. */
function setupScope(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({ runScoped: async () => rows as never[] } as never),
  );
}

beforeEach(() => vi.clearAllMocks());

// ── Helper: builds a funnel aggregate row (as silver_checkout_signal SUM/COUNT shape) ──

interface FunnelRow {
  abandoned: string;
  discount_applied: string;
  with_address: string;
  abandoned_value: string;
  synthetic_cnt: string;
  currency_code: string | null;
}

function funnelRow(overrides: Partial<FunnelRow> = {}): FunnelRow {
  return {
    abandoned: '0',
    discount_applied: '0',
    with_address: '0',
    abandoned_value: '0',
    synthetic_cnt: '0',
    currency_code: 'INR',
    ...overrides,
  };
}

describe('computeCheckoutFunnel — Shopflo abandoned-checkout funnel (silver_checkout_signal)', () => {

  it('hasData=false when abandonedCount is 0 (no checkout_abandoned rows in window)', async () => {
    setupScope([funnelRow({ abandoned: '0', currency_code: null })]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(false);
    expect(result.abandonedCount).toBe(0n);
    expect(result.discountAppliedCount).toBe(0n);
    expect(result.withAddressCount).toBe(0n);
    expect(result.abandonedValueMinor).toBe(0n);
    expect(result.dataSource).toBe('live');
  });

  it('hasData=false when currencyCode is null (no currency on the rows)', async () => {
    setupScope([funnelRow({ abandoned: '5', currency_code: null })]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(false);
    expect(result.currencyCode).toBe(null);
  });

  it('returns exact funnel counts and abandonedValueMinor for a normal case', async () => {
    setupScope([
      funnelRow({
        abandoned:        '10',
        discount_applied: '4',
        with_address:     '7',
        abandoned_value:  '250000', // INR 2500.00 in minor units (paise)
        synthetic_cnt:    '0',
      }),
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(true);
    expect(result.currencyCode).toBe('INR');
    expect(result.abandonedCount).toBe(10n);
    expect(result.discountAppliedCount).toBe(4n);
    expect(result.withAddressCount).toBe(7n);
    expect(result.abandonedValueMinor).toBe(250000n);
    expect(result.dataSource).toBe('live');
  });

  it('all money and count fields are bigint (I-S07 — no floats)', async () => {
    setupScope([
      funnelRow({
        abandoned:        '3',
        discount_applied: '1',
        with_address:     '2',
        abandoned_value:  '99900',
        synthetic_cnt:    '0',
      }),
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(typeof result.abandonedCount).toBe('bigint');
    expect(typeof result.discountAppliedCount).toBe('bigint');
    expect(typeof result.withAddressCount).toBe('bigint');
    expect(typeof result.abandonedValueMinor).toBe('bigint');
    expect(result.abandonedCount).toBe(3n);
    expect(result.abandonedValueMinor).toBe(99900n);
  });

  it('throws on fractional-minor-unit abandonedCount (I-S07 boundary)', async () => {
    // BigInt('10.5') throws SyntaxError — the engine enforces integer-only.
    setupScope([funnelRow({ abandoned: '10.5' })]);

    await expect(computeCheckoutFunnel(BRAND_ID, fakeDeps)).rejects.toThrow(SyntaxError);
  });

  it('dataSource is "synthetic" when synthetic_cnt > 0', async () => {
    setupScope([funnelRow({ abandoned: '5', abandoned_value: '10000', synthetic_cnt: '3' })]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.dataSource).toBe('synthetic');
  });

  it('dataSource is "live" when synthetic_cnt is 0', async () => {
    setupScope([funnelRow({ abandoned: '2', abandoned_value: '5000', synthetic_cnt: '0' })]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.dataSource).toBe('live');
  });

  it('abandonedValueMinor truncates trailing ".00" from SQL numeric text (split on ".")', async () => {
    setupScope([funnelRow({ abandoned: '5', abandoned_value: '250000.00', synthetic_cnt: '0' })]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.abandonedValueMinor).toBe(250000n);
  });

  it('discountAppliedCount=0n and withAddressCount=0n when no discount or address rows', async () => {
    setupScope([
      funnelRow({
        abandoned:        '8',
        discount_applied: '0',
        with_address:     '0',
        abandoned_value:  '80000',
        synthetic_cnt:    '0',
      }),
    ]);

    const result = await computeCheckoutFunnel(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(true);
    expect(result.discountAppliedCount).toBe(0n);
    expect(result.withAddressCount).toBe(0n);
    expect(result.abandonedValueMinor).toBe(80000n);
  });

});
