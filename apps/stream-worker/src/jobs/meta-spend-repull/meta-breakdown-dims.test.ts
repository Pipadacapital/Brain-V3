import { describe, it, expect } from 'vitest';
import { META_BREAKDOWN_DIMS } from './meta-insights-client.js';

/**
 * Meta Insights `breakdowns=` combination validity guard.
 *
 * Prod 2026-07-16: geo was ['country','region','dma'] — but `dma` is EXCLUSIVE in Meta's geo breakdowns
 * (US-only; cannot combine with country/region), so `breakdowns=country,region,dma` returned HTTP 400
 * code=100 "invalid parameter" on EVERY geo pass and failed the whole Meta backfill (records=0). These
 * assertions stop that (and similar invalid combos) from being reintroduced.
 */
describe('META_BREAKDOWN_DIMS — valid Meta breakdown combinations', () => {
  it('geo does NOT combine dma with country/region (Meta rejects it)', () => {
    const geo = META_BREAKDOWN_DIMS.geo;
    const hasDma = geo.includes('dma');
    const hasCountryOrRegion = geo.includes('country') || geo.includes('region');
    expect(hasDma && hasCountryOrRegion).toBe(false);
  });

  it('geo is the valid country+region grain', () => {
    expect(META_BREAKDOWN_DIMS.geo).toEqual(['country', 'region']);
  });

  it('every family declares at least one dimension', () => {
    for (const [family, dims] of Object.entries(META_BREAKDOWN_DIMS)) {
      expect(dims.length, `${family} must declare ≥1 breakdown dimension`).toBeGreaterThan(0);
    }
  });
});
