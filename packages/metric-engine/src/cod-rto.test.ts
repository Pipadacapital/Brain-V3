/**
 * cod-rto.test.ts — unit tests for computeCodRto (COD/RTO outcome funnel, DR-006)
 *
 * One runScoped query returns the per-(brand, currency) gold_cod_rto rows. Mocks
 * withSilverBrand. No DB. SPEC-DERIVED LITERALS (bps are mart-computed integers; NULL bps
 * pass through verbatim — never a fabricated 0).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return { ...actual, withSilverBrand: vi.fn() };
});

import { computeCodRto } from './cod-rto.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000001';

/** Mock the seam so runScoped returns the given mart rows. */
function setupScope(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({ runScoped: async () => rows as never[] } as never),
  );
}

/** A full mart row with overridable fields (serving numerics arrive as string|number). */
function martRow(overrides: Record<string, unknown> = {}) {
  return {
    currency_code: 'INR',
    cod_orders: '10',
    cod_amount_minor: '1049800',
    predicted_rto: '3',
    actual_delivered: '6',
    actual_rto: '2',
    resolved: '8',
    rto_rate_bps: '2500',
    prediction_correct: '5',
    prediction_evaluated: '7',
    prediction_accuracy_bps: '7142',
    updated_at: '2026-07-19 09:27:54.919081',
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('computeCodRto — COD/RTO outcome funnel (gold_cod_rto)', () => {
  it('hasData=false when the brand has no mart rows', async () => {
    setupScope([]);
    const r = await computeCodRto(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(false);
    expect(r.byCurrency).toEqual([]);
  });

  it('maps a full row: money/counts are bigint (I-S07), bps are integers', async () => {
    setupScope([martRow()]);
    const r = await computeCodRto(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(true);
    expect(r.byCurrency).toHaveLength(1);
    const c = r.byCurrency[0]!;
    expect(c.currencyCode).toBe('INR');
    expect(typeof c.codAmountMinor).toBe('bigint');
    expect(c.codAmountMinor).toBe(1049800n);
    expect(c.codOrders).toBe(10n);
    expect(c.predictedRto).toBe(3n);
    expect(c.actualDelivered).toBe(6n);
    expect(c.actualRto).toBe(2n);
    expect(c.resolved).toBe(8n);
    expect(c.rtoRateBps).toBe(2500);
    expect(c.predictionCorrect).toBe(5n);
    expect(c.predictionEvaluated).toBe(7n);
    expect(c.predictionAccuracyBps).toBe(7142);
    expect(c.updatedAt).toBe('2026-07-19 09:27:54.919081');
  });

  it('NULL bps pass through as null — never a fabricated 0 (unresolved brand)', async () => {
    setupScope([
      martRow({
        predicted_rto: '0',
        actual_delivered: '0',
        actual_rto: '0',
        resolved: '0',
        rto_rate_bps: null,
        prediction_correct: '0',
        prediction_evaluated: '0',
        prediction_accuracy_bps: null,
      }),
    ]);
    const r = await computeCodRto(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(true);
    const c = r.byCurrency[0]!;
    expect(c.rtoRateBps).toBe(null);
    expect(c.predictionAccuracyBps).toBe(null);
    expect(c.resolved).toBe(0n);
    expect(c.predictionEvaluated).toBe(0n);
  });

  it('serving numerics arriving as JSON numbers coerce identically', async () => {
    setupScope([
      martRow({ cod_orders: 2, cod_amount_minor: 1459400, rto_rate_bps: 2500, prediction_accuracy_bps: 10000 }),
    ]);
    const c = (await computeCodRto(BRAND_ID, fakeDeps)).byCurrency[0]!;
    expect(c.codOrders).toBe(2n);
    expect(c.codAmountMinor).toBe(1459400n);
    expect(c.rtoRateBps).toBe(2500);
    expect(c.predictionAccuracyBps).toBe(10000);
  });

  it('orders currencies by COD-order volume desc, then code', async () => {
    setupScope([
      martRow({ currency_code: 'AED', cod_orders: '1' }),
      martRow({ currency_code: 'USD', cod_orders: '5' }),
      martRow({ currency_code: 'INR', cod_orders: '5' }),
    ]);
    const r = await computeCodRto(BRAND_ID, fakeDeps);
    expect(r.byCurrency.map((c) => c.currencyCode)).toEqual(['INR', 'USD', 'AED']);
  });
});
