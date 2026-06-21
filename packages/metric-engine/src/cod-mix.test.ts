/**
 * cod-mix.test.ts — unit tests for computeCodMix (CoD CM2 + mix)
 *
 * Re-pointed to the gold_revenue_ledger Silver/Gold seam (Phase G): one runScoped query returns
 * per-event_type signed sums + the per-row currency. Mocks withSilverBrand. No DB. SPEC-DERIVED LITERALS.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return { ...actual, withSilverBrand: vi.fn() };
});

import { computeCodMix } from './cod-mix.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000001';

/** Mock the seam so runScoped returns the given ledger-sum rows. */
function setupScope(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({ runScoped: async () => rows as never[] } as never),
  );
}

const INR = 'INR';

beforeEach(() => vi.clearAllMocks());

describe('computeCodMix — CoD CM2 + mix (gold_revenue_ledger)', () => {
  it('hasData=false when no cod_* ledger rows exist', async () => {
    setupScope([]);
    const r = await computeCodMix(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(false);
    expect(r.codSharePct).toBe(null);
    expect(r.codNetMinor).toBe(0n);
    expect(r.prepaidMinor).toBe(0n);
  });

  it('hasData=false when currencyCode is null (no currency on rows)', async () => {
    setupScope([{ event_type: 'cod_delivery_confirmed', sum_minor: '50000', currency_code: null }]);
    const r = await computeCodMix(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(false);
    expect(r.currencyCode).toBe(null);
  });

  it('codNetMinor is NEGATIVE when RTO clawback exceeds delivered', async () => {
    setupScope([
      { event_type: 'cod_delivery_confirmed', sum_minor: '30000', currency_code: INR },
      { event_type: 'cod_rto_clawback', sum_minor: '-45000', currency_code: INR },
    ]);
    const r = await computeCodMix(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(true);
    expect(r.codDeliveredMinor).toBe(30000n);
    expect(r.codRtoClawbackMinor).toBe(45000n);
    expect(r.codNetMinor).toBe(-15000n);
  });

  it('codSharePct null when denominator non-positive', async () => {
    setupScope([
      { event_type: 'cod_delivery_confirmed', sum_minor: '0', currency_code: INR },
      { event_type: 'cod_rto_clawback', sum_minor: '0', currency_code: INR },
    ]);
    const r = await computeCodMix(BRAND_ID, fakeDeps);
    expect(r.codSharePct).toBe(null);
  });

  it('codSharePct exact percentage for a normal case (75.00)', async () => {
    setupScope([
      { event_type: 'cod_delivery_confirmed', sum_minor: '75000', currency_code: INR },
      { event_type: 'finalization', sum_minor: '25000', currency_code: INR },
    ]);
    const r = await computeCodMix(BRAND_ID, fakeDeps);
    expect(r.hasData).toBe(true);
    expect(r.codNetMinor).toBe(75000n);
    expect(r.prepaidMinor).toBe(25000n);
    expect(r.codSharePct).toBe('75.00');
  });

  it('codSharePct partial bps (33.33)', async () => {
    setupScope([
      { event_type: 'cod_delivery_confirmed', sum_minor: '1000', currency_code: INR },
      { event_type: 'finalization', sum_minor: '2000', currency_code: INR },
    ]);
    expect((await computeCodMix(BRAND_ID, fakeDeps)).codSharePct).toBe('33.33');
  });

  it('money values are all bigint (I-S07)', async () => {
    setupScope([
      { event_type: 'cod_delivery_confirmed', sum_minor: '12345', currency_code: INR },
      { event_type: 'cod_rto_clawback', sum_minor: '-1000', currency_code: INR },
      { event_type: 'finalization', sum_minor: '5000', currency_code: INR },
    ]);
    const r = await computeCodMix(BRAND_ID, fakeDeps);
    expect(typeof r.codNetMinor).toBe('bigint');
    expect(r.codNetMinor).toBe(11345n);
    expect(r.codRtoClawbackMinor).toBe(1000n);
  });
});
