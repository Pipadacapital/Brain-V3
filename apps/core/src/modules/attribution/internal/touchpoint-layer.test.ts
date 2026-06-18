/**
 * touchpoint-layer.test.ts — the attribution module's silver.touchpoint ownership descriptor.
 *
 * Pure domain descriptor — asserts the invariants the attribution bounded context declares
 * for the Silver layer it owns (grain, no-money, deterministic stitch, replay-safe).
 */

import { describe, it, expect } from 'vitest';
import { describeTouchpointLayer, TOUCHPOINT_LAYER } from './touchpoint-layer.js';

describe('attribution — silver.touchpoint layer descriptor', () => {
  it('declares the (brand_id, brain_anon_id, touch_seq) per-touch grain', () => {
    const d = describeTouchpointLayer();
    expect(d.mart).toBe('silver_touchpoint');
    expect(d.grain).toEqual(['brand_id', 'brain_anon_id', 'touch_seq']);
  });

  it('declares NO money column (touchpoints are not monetary)', () => {
    expect(describeTouchpointLayer().hasMoney).toBe(false);
  });

  it('declares the cart-stitch as DETERMINISTIC (read-back, never probabilistic — D-5)', () => {
    expect(describeTouchpointLayer().stitch).toBe('deterministic');
  });

  it('declares the layer replay-safe (idempotent dbt rebuild from Bronze)', () => {
    expect(describeTouchpointLayer().replaySafe).toBe(true);
  });

  it('the descriptor is frozen (a single immutable source of truth)', () => {
    expect(Object.isFrozen(TOUCHPOINT_LAYER)).toBe(true);
  });
});
