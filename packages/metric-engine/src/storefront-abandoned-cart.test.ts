/**
 * storefront-abandoned-cart.test.ts — unit tests for computeAbandonedCart AFTER the Brain V4 repoint
 * to the Gold mart gold_abandoned_cart (served via brain_serving.mv_gold_abandoned_cart).
 *
 * Injects a fully-mocked SilverScope (withSilverBrand → runScoped). One runScoped call per invocation
 * (the window SUM over the per-(day,currency) rows). We capture the SQL to PROVE the read goes through
 * the Gold serving view + the brand predicate. All assertions are SPEC-DERIVED LITERALS — no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return { ...actual, withSilverBrand: vi.fn() };
});

import { computeAbandonedCart } from './storefront-abandoned-cart.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const fakeDeps = { srPool: {} as never };
const BRAND_ID = '00000000-0000-0000-0000-000000000002';
const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-30T23:59:59Z') };

let capturedSql = '';
let capturedParams: unknown[] = [];

/** Mock the seam: the single runScoped → the window-aggregate row. Captures SQL + params. */
function setupScope(rows: unknown[]) {
  capturedSql = '';
  capturedParams = [];
  withSilverBrandMock.mockImplementation(async (_srPool, _brandId, fn) =>
    fn({
      runScoped: async (sql: string, params: unknown[] = []) => {
        capturedSql = sql;
        capturedParams = params;
        return rows as never[];
      },
    } as never),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('computeAbandonedCart (repointed to gold_abandoned_cart)', () => {
  it('reads the Gold serving view with the brand predicate + UTC date window', async () => {
    setupScope([{ cart_sessions: '0', converted_sessions: '0', abandoned_sessions: '0' }]);
    await computeAbandonedCart(BRAND_ID, fakeDeps, RANGE);
    expect(capturedSql).toContain('brain_serving.mv_gold_abandoned_cart');
    expect(capturedSql).not.toContain('silver_touchpoint');
    expect(capturedSql).toContain('cart_date BETWEEN ? AND ?');
    // The brand-predicate sentinel must be present + LAST in the WHERE (fail-closed isolation;
    // the real runScoped rewrites it to `brand_id = ?` — here the seam is mocked so the sentinel
    // is captured verbatim).
    expect(capturedSql).toContain(BRAND_PREDICATE);
    expect(capturedSql.trimEnd().endsWith(BRAND_PREDICATE)).toBe(true);
    expect(capturedParams).toEqual(['2026-06-01', '2026-06-30']);
  });

  it('hasData=false and zeroed counts when the brand has no cart sessions', async () => {
    setupScope([{ cart_sessions: '0', converted_sessions: '0', abandoned_sessions: '0' }]);
    const r = await computeAbandonedCart(BRAND_ID, fakeDeps, RANGE);
    expect(r.hasData).toBe(false);
    expect(r.cartSessions).toBe(0n);
    expect(r.convertedSessions).toBe(0n);
    expect(r.abandonedSessions).toBe(0n);
    expect(r.abandonmentRatePct).toBe(null);
    expect(r.recoveryRatePct).toBe(null);
  });

  it('aggregates the window rollup into counts + 2dp integer-basis-point rates', async () => {
    // 200 cart sessions, 50 recovered, 150 abandoned → 75.00% abandonment, 25.00% recovery.
    setupScope([{ cart_sessions: '200', converted_sessions: '50', abandoned_sessions: '150' }]);
    const r = await computeAbandonedCart(BRAND_ID, fakeDeps, RANGE);
    expect(r.hasData).toBe(true);
    expect(r.cartSessions).toBe(200n);
    expect(r.convertedSessions).toBe(50n);
    expect(r.abandonedSessions).toBe(150n);
    expect(r.abandonmentRatePct).toBe('75.00');
    expect(r.recoveryRatePct).toBe('25.00');
  });

  it('honest 0 recovery while the mart recovered_carts placeholder is 0 (never fabricated)', async () => {
    setupScope([{ cart_sessions: '80', converted_sessions: '0', abandoned_sessions: '30' }]);
    const r = await computeAbandonedCart(BRAND_ID, fakeDeps, RANGE);
    expect(r.hasData).toBe(true);
    expect(r.convertedSessions).toBe(0n);
    expect(r.recoveryRatePct).toBe('0.00');
    expect(r.abandonmentRatePct).toBe('37.50');
  });

  it('coerces null/absent aggregate to 0n (honest no_data)', async () => {
    setupScope([{ cart_sessions: null, converted_sessions: null, abandoned_sessions: null }]);
    const r = await computeAbandonedCart(BRAND_ID, fakeDeps, RANGE);
    expect(r.hasData).toBe(false);
    expect(r.cartSessions).toBe(0n);
  });
});
