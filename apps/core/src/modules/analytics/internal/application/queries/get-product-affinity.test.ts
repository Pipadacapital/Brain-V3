/**
 * get-product-affinity.test.ts — regression guard for the BFF contract drift
 * "pairs.0.support_pct: Expected string, received number" on the product detail page.
 *
 * gold_product_affinity stores support_pct as a ROUND(...,2) DOUBLE; the Trino serving view returns it
 * as a JS number, but the wire contract (ProductAffinityPairDtoSchema.support_pct = z.string()) and the
 * UI (`${rate}%`) expect a 2dp string. The query must coerce it. These tests stub the Silver/Gold read
 * seam so they run without Trino.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the read seam: withSilverBrand just hands `fn` a scope whose runScoped returns our fixture rows
// (mimicking mv_gold_product_affinity, where support_pct arrives as a Trino double → JS number).
const runScoped = vi.fn();
vi.mock('@brain/metric-engine', () => ({
  withSilverBrand: (_pool: unknown, _brandId: string, fn: (s: { runScoped: typeof runScoped }) => unknown) =>
    fn({ runScoped }),
  BRAND_PREDICATE: 'brand_id = ?',
}));

import { getProductAffinity } from './get-product-affinity.js';
import { ProductAffinityPairDtoSchema } from '@brain/contracts';

describe('getProductAffinity — support_pct contract coercion', () => {
  beforeEach(() => runScoped.mockReset());

  it('coerces the mart DOUBLE support_pct to a 2dp string so the BFF contract holds', async () => {
    runScoped.mockResolvedValue([
      { product_b: '1986', co_purchase_count: 387, support_pct: 20.43 },
      { product_b: '1971', co_purchase_count: 91, support_pct: 4.8 },
    ]);

    const res = await getProductAffinity('brand-1', '1863', 10, { srPool: {} as never });

    expect(res.state).toBe('has_data');
    if (res.state !== 'has_data') return;
    expect(res.pairs).toHaveLength(2);
    expect(res.pairs[0]).toEqual({ product_b: '1986', co_purchase_count: '387', support_pct: '20.43' });
    expect(res.pairs[1]?.support_pct).toBe('4.80'); // 4.8 → consistent 2dp string
    // Every pair satisfies the exact wire contract that was failing on the product page.
    for (const p of res.pairs) expect(() => ProductAffinityPairDtoSchema.parse(p)).not.toThrow();
  });

  it('returns honest no_data when the product has no co-purchase pairs', async () => {
    runScoped.mockResolvedValue([]);
    const res = await getProductAffinity('brand-1', 'x', 10, { srPool: {} as never });
    expect(res.state).toBe('no_data');
  });
});
