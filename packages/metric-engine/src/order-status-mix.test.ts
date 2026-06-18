/**
 * order-status-mix.test.ts — unit tests for computeOrderStatusMix (Silver mix).
 *
 * Tests the pure fold (counts + integer share math + BIGINT money + honest no_data)
 * by mocking the Silver seam (withSilverBrand) with a pass-through that hands `fn` a
 * SilverScope whose runScoped returns fixture rows. No StarRocks required.
 *
 * SPEC-DERIVED LITERALS only — every assertion is a concrete value derived from the
 * fixture, not a tautology. Share values are hand-computed basis points.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the Silver seam BEFORE importing the module under test ──────────────
vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return {
    ...actual, // keep BRAND_PREDICATE etc.
    withSilverBrand: vi.fn(),
  };
});

import { computeOrderStatusMix } from './order-status-mix.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);

const BRAND_ID = '00000000-0000-0000-0000-000000000001';
const fakeDeps = { srPool: {} as never };
const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-18T23:59:59Z') };

/** Wire withSilverBrand to call fn with a scope whose runScoped returns the fixture rows. */
function setupRows(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_pool, _brandId, fn) => {
    const scope = { runScoped: vi.fn(async () => rows) };
    return fn(scope as never);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeOrderStatusMix — Silver order-status-mix fold', () => {

  it('hasData=false when the brand has zero Silver rows in the window (honest no_data)', async () => {
    setupRows([]);
    const result = await computeOrderStatusMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.hasData).toBe(false);
    expect(result.currencyCode).toBe(null);
    expect(result.total).toBe(0n);
    expect(result.byState).toEqual([]);
  });

  it('counts + total are exact bigints over the grouped rows', async () => {
    // placed=10, delivered=70, rto=20 → total=100
    setupRows([
      { lifecycle_state: 'placed',    cnt: '10', value_minor: '100000', currency_code: 'INR' },
      { lifecycle_state: 'delivered', cnt: '70', value_minor: '700000', currency_code: 'INR' },
      { lifecycle_state: 'rto',       cnt: '20', value_minor: '200000', currency_code: 'INR' },
    ]);
    const result = await computeOrderStatusMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.hasData).toBe(true);
    expect(result.total).toBe(100n);
    expect(typeof result.total).toBe('bigint');
    const placed = result.byState.find((b) => b.lifecycleState === 'placed');
    const delivered = result.byState.find((b) => b.lifecycleState === 'delivered');
    const rto = result.byState.find((b) => b.lifecycleState === 'rto');
    expect(placed?.count).toBe(10n);
    expect(delivered?.count).toBe(70n);
    expect(rto?.count).toBe(20n);
  });

  it('share percentages are exact 2dp integer-math strings (no float)', async () => {
    // total = 100 → placed 10/100 = 10.00; delivered 70/100 = 70.00; rto 20/100 = 20.00
    setupRows([
      { lifecycle_state: 'placed',    cnt: '10', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'delivered', cnt: '70', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'rto',       cnt: '20', value_minor: '0', currency_code: 'INR' },
    ]);
    const result = await computeOrderStatusMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.byState.find((b) => b.lifecycleState === 'placed')?.sharePct).toBe('10.00');
    expect(result.byState.find((b) => b.lifecycleState === 'delivered')?.sharePct).toBe('70.00');
    expect(result.byState.find((b) => b.lifecycleState === 'rto')?.sharePct).toBe('20.00');
  });

  it('share with a non-round ratio truncates to 2dp via basis points', async () => {
    // total = 3 → each 1/3: bps = (1*10000)/3 = 3333 → '33.33'
    setupRows([
      { lifecycle_state: 'placed',    cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'confirmed', cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'delivered', cnt: '1', value_minor: '0', currency_code: 'INR' },
    ]);
    const result = await computeOrderStatusMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.total).toBe(3n);
    for (const b of result.byState) expect(b.sharePct).toBe('33.33');
  });

  it('money (valueMinor) is BIGINT minor units and exact (I-S07)', async () => {
    setupRows([
      { lifecycle_state: 'delivered', cnt: '2', value_minor: '12345', currency_code: 'INR' },
    ]);
    const result = await computeOrderStatusMix(BRAND_ID, fakeDeps, RANGE);

    const delivered = result.byState.find((b) => b.lifecycleState === 'delivered');
    expect(typeof delivered?.valueMinor).toBe('bigint');
    expect(delivered?.valueMinor).toBe(12345n);
    expect(result.currencyCode).toBe('INR');
  });

  it('throws on a fractional minor-unit value (I-S07 runtime boundary)', async () => {
    setupRows([
      { lifecycle_state: 'delivered', cnt: '1', value_minor: '100.50', currency_code: 'INR' },
    ]);
    await expect(computeOrderStatusMix(BRAND_ID, fakeDeps, RANGE)).rejects.toThrow(SyntaxError);
  });

  it('isTerminal flag matches the canonical terminal set', async () => {
    setupRows([
      { lifecycle_state: 'placed',    cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'confirmed', cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'delivered', cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'cancelled', cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'rto',       cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'refunded',  cnt: '1', value_minor: '0', currency_code: 'INR' },
    ]);
    const result = await computeOrderStatusMix(BRAND_ID, fakeDeps, RANGE);

    const terminal = new Map(result.byState.map((b) => [b.lifecycleState, b.isTerminal]));
    expect(terminal.get('placed')).toBe(false);
    expect(terminal.get('confirmed')).toBe(false);
    expect(terminal.get('delivered')).toBe(true);
    expect(terminal.get('cancelled')).toBe(true);
    expect(terminal.get('rto')).toBe(true);
    expect(terminal.get('refunded')).toBe(true);
  });

  it('emits states in canonical order (placed→confirmed→delivered→cancelled→rto→refunded)', async () => {
    // Provide rows out of order; output must be canonical.
    setupRows([
      { lifecycle_state: 'refunded',  cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'placed',    cnt: '1', value_minor: '0', currency_code: 'INR' },
      { lifecycle_state: 'delivered', cnt: '1', value_minor: '0', currency_code: 'INR' },
    ]);
    const result = await computeOrderStatusMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.byState.map((b) => b.lifecycleState)).toEqual(['placed', 'delivered', 'refunded']);
  });
});
