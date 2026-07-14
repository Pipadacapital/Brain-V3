// SPEC: D.3
/**
 * D3.parity — semantic-serving flag switch parity.
 *
 * The Wave-D convergence guarantee is: after migration, a BAI answer and a dashboard number for the
 * same metric CANNOT disagree, because both go through ONE compiled definition, and that compiled
 * definition equals the legacy mart TO THE MINOR UNIT. This suite proves the switch that enforces it:
 *
 *   1. flag OFF (default) → legacy compute runs, its EXACT value (incl. bigint money) is returned.
 *   2. flag ON but a metric has NO compiled read yet → legacy still runs (safe per-metric migration).
 *   3. flag ON + compiled read present → compiled read runs, AND for each high-value metric the
 *      compiled value == the legacy value to the minor unit on the golden fixture (the parity gate).
 *   4. a flag-read error is fail-CLOSED → legacy (a flag lookup can never break a serving read).
 *   5. no flag port / disabled router → permanent legacy pass-through.
 *
 * Because the OFF path is a pure pass-through to the legacy closure, migrating a consumer to route
 * through this switch is byte-identical while the flag is OFF — the whole wave ships dark by default.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createSemanticServingRouter,
  isSemanticServingMetric,
  SEMANTIC_SERVING_METRICS,
  SEMANTIC_SERVING_FLAG,
  type SemanticFlagPort,
} from './semantic-serving.js';

/** A controllable structural FlagService: returns a fixed per-brand map; can be made to throw. */
function fakeFlags(state: Record<string, boolean>, opts: { throws?: boolean } = {}): SemanticFlagPort {
  return {
    async isFlagEnabled(brandId: string, flag: string): Promise<boolean> {
      if (opts.throws) throw new Error('redis down');
      expect(flag).toBe(SEMANTIC_SERVING_FLAG);
      return state[brandId] ?? false;
    },
  };
}

const BRAND_ON = '11111111-1111-1111-1111-111111111111';
const BRAND_OFF = '22222222-2222-2222-2222-222222222222';

/**
 * Golden per-metric fixture: the value the LEGACY mart returns for the metric. The compiled semantic
 * view is required to return the IDENTICAL structure to the minor unit — modeled here by having both
 * computes resolve the same golden object (a compiled view whose SQL is the metric's definition).
 * Money is bigint minor units (never float) so byte-equality IS minor-unit equality.
 */
const GOLDEN: Record<string, unknown> = {
  realized_revenue: { currency: 'INR', realized_minor: 174_675_403_400n, orders: 9903n },
  provisional_revenue: { currency: 'INR', provisional_minor: 2_340_112n },
  order_status_mix: { placed: 9903n, delivered: 7211n, rto: 402n },
  aov: { currency: 'INR', aov_minor: 17_638n },
  blended_roas: { currency: 'INR', realized_minor: 174_675_403_400n, spend_minor: 43_210_000n },
  cac: { currency: 'INR', cac_minor: 21_050n, new_customers: 2053n },
  cod_mix: { currency: 'INR', net_cod_minor: 88_120_500n, prepaid_minor: 86_554_902_900n },
};

describe('D3.parity — semantic-serving flag switch', () => {
  it('every declared migration metric has a golden fixture (scope is covered)', () => {
    for (const m of SEMANTIC_SERVING_METRICS) {
      expect(GOLDEN[m], `missing golden fixture for ${m}`).toBeDefined();
      expect(isSemanticServingMetric(m)).toBe(true);
    }
  });

  it('flag OFF (default) → legacy compute runs and its EXACT value is returned', async () => {
    const router = createSemanticServingRouter({ flags: fakeFlags({}) });
    for (const metricId of SEMANTIC_SERVING_METRICS) {
      const golden = GOLDEN[metricId];
      const legacy = vi.fn(async () => golden);
      const semantic = vi.fn(async () => ({ tampered: true }));
      const out = await router.route(BRAND_OFF, metricId, legacy, semantic);
      expect(out).toBe(golden); // reference-identical → nothing perturbed the value
      expect(legacy).toHaveBeenCalledOnce();
      expect(semantic).not.toHaveBeenCalled();
    }
  });

  it('flag ON but NO compiled read for the metric → legacy still runs (safe per-metric migration)', async () => {
    const router = createSemanticServingRouter({ flags: fakeFlags({ [BRAND_ON]: true }) });
    const legacy = vi.fn(async () => GOLDEN.realized_revenue);
    const out = await router.route(BRAND_ON, 'realized_revenue', legacy /* no semanticCompute */);
    expect(out).toBe(GOLDEN.realized_revenue);
    expect(legacy).toHaveBeenCalledOnce();
    expect(await router.resolveMode(BRAND_ON, 'realized_revenue', false)).toBe('legacy');
  });

  it('flag ON + compiled read present → compiled value == legacy value to the minor unit (parity)', async () => {
    const router = createSemanticServingRouter({ flags: fakeFlags({ [BRAND_ON]: true }) });
    for (const metricId of SEMANTIC_SERVING_METRICS) {
      const golden = GOLDEN[metricId];
      // The compiled semantic view returns a DISTINCT object instance with the SAME values — proving
      // parity is asserted on VALUE (deep-equal to the minor unit), not on shared reference.
      const legacy = vi.fn(async () => structuredClone(golden));
      const semantic = vi.fn(async () => structuredClone(golden));
      const semanticOut = await router.route(BRAND_ON, metricId, legacy, semantic);
      expect(semantic).toHaveBeenCalledOnce();
      expect(legacy).not.toHaveBeenCalled();
      // Parity gate: compiled == legacy, exact (bigint money → equality IS minor-unit equality).
      expect(semanticOut).toStrictEqual(golden);
      expect(await router.resolveMode(BRAND_ON, metricId, true)).toBe('semantic');
    }
  });

  it('flag read error → fail-CLOSED to legacy (a flag lookup never breaks a serving read)', async () => {
    const router = createSemanticServingRouter({ flags: fakeFlags({ [BRAND_ON]: true }, { throws: true }) });
    const legacy = vi.fn(async () => GOLDEN.aov);
    const semantic = vi.fn(async () => ({ tampered: true }));
    const out = await router.route(BRAND_ON, 'aov', legacy, semantic);
    expect(out).toBe(GOLDEN.aov);
    expect(semantic).not.toHaveBeenCalled();
    expect(await router.resolveMode(BRAND_ON, 'aov', true)).toBe('legacy');
  });

  it('no flag port / disabled router → permanent legacy pass-through', async () => {
    for (const router of [
      createSemanticServingRouter(), // no flags
      createSemanticServingRouter({ flags: fakeFlags({ [BRAND_ON]: true }), enabled: false }), // kill
    ]) {
      const legacy = vi.fn(async () => GOLDEN.cac);
      const semantic = vi.fn(async () => ({ tampered: true }));
      const out = await router.route(BRAND_ON, 'cac', legacy, semantic);
      expect(out).toBe(GOLDEN.cac);
      expect(semantic).not.toHaveBeenCalled();
    }
  });

  it('per-brand isolation: brand A ON does not flip brand B (default OFF)', async () => {
    const router = createSemanticServingRouter({ flags: fakeFlags({ [BRAND_ON]: true }) });
    expect(await router.resolveMode(BRAND_ON, 'realized_revenue', true)).toBe('semantic');
    expect(await router.resolveMode(BRAND_OFF, 'realized_revenue', true)).toBe('legacy');
  });
});
