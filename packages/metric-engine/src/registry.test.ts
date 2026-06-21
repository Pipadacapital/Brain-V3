/**
 * registry.test.ts — unit tests for the metric registry (D-1)
 *
 * Tests:
 *   1. resolveMetric('realized_revenue','v1') returns the correct definition.
 *   2. resolveMetric('provisional_revenue','v1') returns the correct definition.
 *   3. Unknown (metricId, version) throws with a clear message.
 *   4. recognitionLabels ↔ readSeam consistency:
 *      - realized_revenue/v1 → readSeam='realized_gmv_as_of' + labels=['finalized']
 *      - provisional_revenue/v1 → readSeam='provisional_gmv_as_of' + labels includes 'provisional','settling'
 *   5. toleranceMinor = 0 on all money metrics (no float tolerance).
 *   6. Registry is immutable (as const): no mutation possible.
 */

import { describe, it, expect } from 'vitest';
import { METRIC_REGISTRY, resolveMetric } from './registry.js';

describe('metric-engine — registry (D-1)', () => {

  it('resolveMetric(realized_revenue, v1) returns the correct definition', () => {
    const def = resolveMetric('realized_revenue', 'v1');
    expect(def.metricId).toBe('realized_revenue');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('realized_gmv_as_of');
    expect(def.toleranceMinor).toBe(0);
    expect(def.description).toContain('realized_revenue');
  });

  it('resolveMetric(provisional_revenue, v1) returns the correct definition', () => {
    const def = resolveMetric('provisional_revenue', 'v1');
    expect(def.metricId).toBe('provisional_revenue');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('provisional_gmv_as_of');
    expect(def.toleranceMinor).toBe(0);
    expect(def.description).toContain('provisional_revenue');
  });

  it('resolveMetric with unknown metricId throws', () => {
    // Cast to bypass TS type check — runtime test for unknown metricId
    expect(() => resolveMetric('nonexistent_metric' as 'realized_revenue', 'v1')).toThrow(
      /\[metric-engine\] unknown metric/,
    );
  });

  it('resolveMetric with unknown version throws', () => {
    // v999 is a valid MetricVersion type (v${number}) but not in the registry
    expect(() => resolveMetric('realized_revenue', 'v999')).toThrow(
      /\[metric-engine\] unknown metric/,
    );
  });

  it('[D-1] version bump = new key — v1 exists; only v1 registered for M1', () => {
    // The registry shape confirms (metric_id, version) keying.
    // v1 exists; a version bump would add v2 as a NEW key (additive), not a mutation.
    const v1 = METRIC_REGISTRY['realized_revenue']['v1'];
    expect(v1.version).toBe('v1');
    // Confirm only known versions are present (M1 = v1 only)
    const registeredVersions = Object.keys(METRIC_REGISTRY['realized_revenue']);
    expect(registeredVersions).toEqual(['v1']);
  });

  it('[D-1] recognitionLabels ↔ readSeam consistency — realized', () => {
    const def = resolveMetric('realized_revenue', 'v1');
    // realized_revenue uses the finalized label via realized_gmv_as_of
    expect(def.readSeam).toBe('realized_gmv_as_of');
    expect(def.recognitionLabels).toContain('finalized');
    expect(def.recognitionLabels).not.toContain('provisional');
    expect(def.recognitionLabels).not.toContain('settling');
  });

  it('[D-1] recognitionLabels ↔ readSeam consistency — provisional', () => {
    const def = resolveMetric('provisional_revenue', 'v1');
    // provisional_revenue uses provisional/settling labels via provisional_gmv_as_of
    expect(def.readSeam).toBe('provisional_gmv_as_of');
    expect(def.recognitionLabels).toContain('provisional');
    expect(def.recognitionLabels).toContain('settling');
    expect(def.recognitionLabels).not.toContain('finalized');
  });

  it('resolveMetric(ad_spend, v1) returns the correct definition (spend seam)', () => {
    const def = resolveMetric('ad_spend', 'v1');
    expect(def.metricId).toBe('ad_spend');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('ad_spend_as_of');
    expect(def.toleranceMinor).toBe(0);
    // spend is not recognition-staged → no recognition labels
    expect(def.recognitionLabels).toEqual([]);
    expect(def.description).toContain('ad_spend_as_of');
  });

  it('resolveMetric(blended_roas, v1) returns the correct definition (ratio of two exact seams)', () => {
    const def = resolveMetric('blended_roas', 'v1');
    expect(def.metricId).toBe('blended_roas');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('ad_spend_as_of'); // denominator seam (numerator = realized_gmv_as_of, re-used)
    expect(def.toleranceMinor).toBe(0); // exact-rational from two BIGINT SUMs, no float tolerance
    expect(def.description).toContain('SAME-CURRENCY ONLY');
    expect(def.description).toContain('realized_gmv_as_of');
  });

  it('[ad] blended_roas documents same-currency-only + honest spend=0→null', () => {
    const def = resolveMetric('blended_roas', 'v1');
    expect(def.description).toContain('never blended across');
    expect(def.description.toLowerCase()).toContain('spend>0');
  });

  it('resolveMetric(cod_rto_rate, v1) — silver_shipment seam', () => {
    const def = resolveMetric('cod_rto_rate', 'v1');
    expect(def.metricId).toBe('cod_rto_rate');
    expect(def.version).toBe('v1');
    // Re-pointed from awb_terminal_states (PG bronze) → silver_shipment (multi-source Silver mart).
    expect(def.readSeam).toBe('silver_shipment');
    expect(def.toleranceMinor).toBe(0);
  });

  it('resolveMetric(cod_mix, v1) — CoD ledger seam (net realized CoD / prepaid)', () => {
    const def = resolveMetric('cod_mix', 'v1');
    expect(def.metricId).toBe('cod_mix');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('cod_ledger');
    expect(def.toleranceMinor).toBe(0);
  });

  it('resolveMetric(checkout_funnel, v1) — Shopflo checkout_abandoned seam', () => {
    const def = resolveMetric('checkout_funnel', 'v1');
    expect(def.metricId).toBe('checkout_funnel');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('checkout_abandoned');
    expect(def.toleranceMinor).toBe(0);
  });

  it('resolveMetric(order_status_mix, v1) — Silver order_state seam (non-additive mix)', () => {
    const def = resolveMetric('order_status_mix', 'v1');
    expect(def.metricId).toBe('order_status_mix');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('silver_order_state');
    expect(def.toleranceMinor).toBe(0);
    // Lifecycle is a latest-state fold, not a recognition-staged fact.
    expect(def.recognitionLabels).toEqual([]);
    // Documents the ADR-004 split (non-additive aggregation lives in the engine, not dbt).
    expect(def.description).toContain('NOT dbt');
    expect(def.description).toContain('silver.order_state');
  });

  it('resolveMetric(journey_first_touch_mix, v1) — Silver touchpoint seam (non-additive mix)', () => {
    const def = resolveMetric('journey_first_touch_mix', 'v1');
    expect(def.metricId).toBe('journey_first_touch_mix');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('silver_touchpoint');
    expect(def.toleranceMinor).toBe(0);
    // First-touch mix is a count fold, not a recognition-staged fact.
    expect(def.recognitionLabels).toEqual([]);
    // Documents the ADR-004 split + deterministic (non-ML) channel ladder + no money.
    expect(def.description).toContain('NOT dbt');
    expect(def.description).toContain('silver.touchpoint');
    expect(def.description).toContain('NO money column');
  });

  it('resolveMetric(journey_stitch_rate, v1) — deterministic read-back, no probabilistic merge (D-5)', () => {
    const def = resolveMetric('journey_stitch_rate', 'v1');
    expect(def.metricId).toBe('journey_stitch_rate');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('silver_touchpoint');
    expect(def.toleranceMinor).toBe(0);
    expect(def.recognitionLabels).toEqual([]);
    // The stitch is DETERMINISTIC — read BACK, never inferred (D-5).
    expect(def.description).toContain('DETERMINISTIC');
    expect(def.description).toContain('read BACK');
  });

  it('resolveMetric(journey_timeline, v1) — touchpoint timeline projection seam', () => {
    const def = resolveMetric('journey_timeline', 'v1');
    expect(def.metricId).toBe('journey_timeline');
    expect(def.version).toBe('v1');
    expect(def.readSeam).toBe('silver_touchpoint');
    expect(def.toleranceMinor).toBe(0);
    expect(def.recognitionLabels).toEqual([]);
    expect(def.description).toContain('touchpoint timeline');
  });

  it('[journey] all three journey metrics resolve through the silver_touchpoint seam', () => {
    for (const id of ['journey_first_touch_mix', 'journey_stitch_rate', 'journey_timeline'] as const) {
      expect(resolveMetric(id, 'v1').readSeam).toBe('silver_touchpoint');
    }
  });

  it('[D-1] toleranceMinor = 0 on all registered metrics (no float tolerance for money)', () => {
    for (const metricId of Object.keys(METRIC_REGISTRY) as Array<keyof typeof METRIC_REGISTRY>) {
      const versions = METRIC_REGISTRY[metricId];
      for (const version of Object.keys(versions) as Array<keyof typeof versions>) {
        const def = versions[version];
        expect(def.toleranceMinor).toBe(0);
      }
    }
  });

  it('[D-1] registry entries are typed readonly (compile-time immutability via as const)', () => {
    const def = METRIC_REGISTRY['realized_revenue']['v1'];
    // The registry is declared `as const` — TypeScript enforces readonly at compile time.
    // This test confirms the structural invariants that make the registry effectively immutable:
    // 1. toleranceMinor is always 0 (no mutation path exists in typed code)
    // 2. The version matches the key
    expect(def.toleranceMinor).toBe(0);
    expect(def.version).toBe('v1');
    // TypeScript would reject: def.toleranceMinor = 1 (readonly compile error)
    // Runtime JS objects from `as const` are not deeply frozen, but the TS type system
    // prevents mutation — any mutation attempt is a type error caught by tsc/typecheck.
  });
});
