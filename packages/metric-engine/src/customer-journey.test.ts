/**
 * customer-journey.test.ts — unit tests for getCustomerJourneySummary (journey-intelligence Gold seam).
 *
 * Tests the pure fold (honest no_data + integer-only rate/averages + bigint counts + brain_anon_id-keyed
 * top journeys + boolean/null normalization) by mocking the Silver/Gold seam (withSilverBrand) with a
 * pass-through that hands `fn` a SilverScope whose runScoped returns fixture rows. No StarRocks required.
 *
 * SPEC-DERIVED LITERALS only — every assertion is a concrete value derived from the fixture.
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

import { getCustomerJourneySummary } from './customer-journey.js';
import { withSilverBrand } from './silver-deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);

const BRAND_ID = '00000000-0000-0000-0000-000000000001';
const fakeDeps = { srPool: {} as never };

/**
 * Wire withSilverBrand to hand `fn` a scope whose runScoped returns, in order, the queued result sets.
 * The seam first reads the summary aggregate, then (when non-empty) the top-journeys list.
 */
function setupSequence(resultSets: unknown[][]) {
  withSilverBrandMock.mockImplementation(async (_pool, _brandId, fn) => {
    const queue = [...resultSets];
    const scope = { runScoped: vi.fn(async () => queue.shift() ?? []) };
    return fn(scope as never);
  });
}

/** Capture the brandId actually passed into the seam (tenant-scope assertion). */
function captureBrand(resultSets: unknown[][]): { brandId: string | undefined } {
  const captured: { brandId: string | undefined } = { brandId: undefined };
  withSilverBrandMock.mockImplementation(async (_pool, brandId, fn) => {
    captured.brandId = brandId;
    const queue = [...resultSets];
    const scope = { runScoped: vi.fn(async () => queue.shift() ?? []) };
    return fn(scope as never);
  });
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getCustomerJourneySummary — journey-intelligence Gold fold', () => {
  it('hasData=false when the brand has zero journeys (honest no_data)', async () => {
    setupSequence([[{ journey_count: '0', converted_count: '0', total_touchpoints: '0', avg_days_to_convert: null }]]);
    const result = await getCustomerJourneySummary(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(false);
    expect(result.journeyCount).toBe(0n);
    expect(result.convertedJourneyCount).toBe(0n);
    expect(result.conversionRatePct).toBe(0);
    expect(result.avgDaysToConvert).toBe(null);
    expect(result.topJourneys).toEqual([]);
  });

  it('hasData=false when the seam returns no aggregate row at all', async () => {
    setupSequence([[]]);
    const result = await getCustomerJourneySummary(BRAND_ID, fakeDeps);
    expect(result.hasData).toBe(false);
    expect(result.journeyCount).toBe(0n);
  });

  it('summary counts are exact bigints; conversion rate is integer 0-100', async () => {
    // 200 journeys, 50 converted → 50*100/200 = 25 (integer). total touchpoints 800 → avg 800/200 = 4.
    setupSequence([
      [{ journey_count: '200', converted_count: '50', total_touchpoints: '800', avg_days_to_convert: '3.7' }],
      [],
    ]);
    const result = await getCustomerJourneySummary(BRAND_ID, fakeDeps);

    expect(result.hasData).toBe(true);
    expect(result.journeyCount).toBe(200n);
    expect(typeof result.journeyCount).toBe('bigint');
    expect(result.convertedJourneyCount).toBe(50n);
    expect(result.conversionRatePct).toBe(25);
    expect(result.totalTouchpoints).toBe(800n);
    expect(result.avgTouchpointsPerJourney).toBe(4);
    // avg_days_to_convert floored: 3.7 → 3.
    expect(result.avgDaysToConvert).toBe(3);
  });

  it('integer rate truncates (no float): 1 of 3 converted → 33', async () => {
    setupSequence([
      [{ journey_count: '3', converted_count: '1', total_touchpoints: '3', avg_days_to_convert: null }],
      [],
    ]);
    const result = await getCustomerJourneySummary(BRAND_ID, fakeDeps);
    // 1*100/3 = 33 (integer division), avg touchpoints 3/3 = 1.
    expect(result.conversionRatePct).toBe(33);
    expect(result.avgTouchpointsPerJourney).toBe(1);
    expect(result.avgDaysToConvert).toBe(null);
  });

  it('projects top journeys keyed by brain_anon_id with normalized boolean + null days', async () => {
    setupSequence([
      [{ journey_count: '2', converted_count: '1', total_touchpoints: '12', avg_days_to_convert: '2' }],
      [
        {
          brain_anon_id: 'anon-a', touchpoint_count: '9', distinct_channels: 3, distinct_sessions: '4',
          first_channel: 'paid_meta', last_channel: 'direct',
          first_touch_at: '2026-06-10 09:00:00', last_touch_at: '2026-06-12 18:00:00',
          converted: 1, days_to_convert: 2,
        },
        {
          brain_anon_id: 'anon-b', touchpoint_count: '3', distinct_channels: 1, distinct_sessions: '1',
          first_channel: 'direct', last_channel: 'direct',
          first_touch_at: '2026-06-11 10:00:00', last_touch_at: '2026-06-11 10:30:00',
          converted: 0, days_to_convert: null,
        },
      ],
    ]);
    const result = await getCustomerJourneySummary(BRAND_ID, fakeDeps);

    expect(result.topJourneys).toHaveLength(2);
    const a = result.topJourneys[0];
    expect(a?.brainAnonId).toBe('anon-a');
    expect(a?.touchpointCount).toBe(9n);
    expect(typeof a?.touchpointCount).toBe('bigint');
    expect(a?.distinctChannels).toBe(3);
    expect(a?.distinctSessions).toBe(4n);
    expect(a?.firstChannel).toBe('paid_meta');
    expect(a?.converted).toBe(true);
    expect(a?.daysToConvert).toBe(2);

    const b = result.topJourneys[1];
    expect(b?.converted).toBe(false);
    expect(b?.daysToConvert).toBe(null);
    expect(b?.firstTouchAt).toBe('2026-06-11 10:00:00');
  });

  it('reads through the seam with the SESSION brandId (tenant-scoped; D-1)', async () => {
    const captured = captureBrand([
      [{ journey_count: '1', converted_count: '0', total_touchpoints: '2', avg_days_to_convert: null }],
      [],
    ]);
    await getCustomerJourneySummary(BRAND_ID, fakeDeps);
    expect(captured.brandId).toBe(BRAND_ID);
  });
});
