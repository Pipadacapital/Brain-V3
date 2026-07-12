// SPEC: B.3
/**
 * B3 — Wave-B Journey API contracts (customer timeline / trace / compare; AMD-14).
 * Locks the honest-empty unions, the matched_via serialization (AUD-JE-34/35: populated coarse
 * basis on ledger/trace paths, null only on the cache hot path) + nullable journey_version
 * (AMD-11), the identity_evidence explainability shape, and the compare t_minus_conversion_ms
 * nullability.
 */
import { describe, it, expect } from 'vitest';
import {
  CustomerJourneyTimelineSchema,
  JourneyTraceSchema,
  JourneyCompareSchema,
  IdentityEvidenceItemSchema,
} from './journey-api.v1.js';

describe('B3 CustomerJourneyTimeline (1) /api/v1/customers/:brainId/journey', () => {
  it('accepts an honest no_data with no has_data fields', () => {
    expect(CustomerJourneyTimelineSchema.parse({ state: 'no_data' })).toEqual({ state: 'no_data' });
  });

  it('accepts a has_data page (cache source: matched_via + journey_version null)', () => {
    const parsed = CustomerJourneyTimelineSchema.parse({
      state: 'has_data',
      brain_id: 'b1',
      items: [
        { ts: 1720000000000, type: 'page.viewed', channel: 'direct', campaign: null, url_path: '/p', session_id: 's', matched_via: null, journey_version: null },
      ],
      next_cursor: null,
      journey_version: null,
      source: 'cache',
      data_source: 'live',
    });
    expect(parsed.state).toBe('has_data');
  });

  it('accepts the Trino source with an ISO ts + a numeric journey_version + populated matched_via (AUD-JE-34)', () => {
    const parsed = CustomerJourneyTimelineSchema.parse({
      state: 'has_data',
      brain_id: 'b1',
      items: [
        { ts: '2026-07-01 10:00:00 UTC', type: 'order.placed', channel: 'paid_meta', campaign: 'x', url_path: null, session_id: null, matched_via: 'order', journey_version: 2 },
        { ts: '2026-07-01 09:00:00 UTC', type: 'page.viewed', channel: 'referral', campaign: null, url_path: null, session_id: null, matched_via: 'deterministic', journey_version: 1 },
      ],
      next_cursor: 'abc',
      journey_version: 2,
      source: 'trino',
      data_source: 'live',
    });
    expect(parsed.state === 'has_data' && parsed.source).toBe('trino');
    expect(parsed.state === 'has_data' && parsed.items[0]?.matched_via).toBe('order');
  });

  it('rejects an unknown source', () => {
    expect(
      CustomerJourneyTimelineSchema.safeParse({
        state: 'has_data', brain_id: 'b', items: [], next_cursor: null, journey_version: null, source: 'redis', data_source: 'live',
      }).success,
    ).toBe(false);
  });
});

describe('B3 JourneyTrace (2) /api/v1/journeys/trace', () => {
  it('accepts a has_data trace with lookback touches (matched_via populated, AUD-JE-35) + identity_evidence', () => {
    const parsed = JourneyTraceSchema.parse({
      state: 'has_data',
      order_id: 'ord-1',
      brain_id: 'b1',
      lookback_days: 30,
      touches: [
        { touch_seq: 1, occurred_at: '2026-07-01 09:00:00 UTC', channel: 'referral', event_type: 'page.viewed', utm_campaign: null, landing_path: '/', matched_via: 'deterministic' },
        { touch_seq: 2, occurred_at: '2026-07-01 09:05:00 UTC', channel: 'direct', event_type: 'page.viewed', utm_campaign: null, landing_path: '/x', matched_via: 'anonymous' },
      ],
      identity_evidence: [
        { identifier_type: 'email', first_seen: '2026-06-01 10:00:00 UTC', source: 'merge' },
      ],
      data_source: 'live',
    });
    expect(parsed.state === 'has_data' && parsed.identity_evidence[0]?.identifier_type).toBe('email');
  });

  it('identity_evidence item requires a type/first_seen/source', () => {
    expect(IdentityEvidenceItemSchema.safeParse({ identifier_type: 'phone', first_seen: 't', source: 'silver_identity_map' }).success).toBe(true);
    expect(IdentityEvidenceItemSchema.safeParse({ identifier_type: 'phone' }).success).toBe(false);
  });

  it('honest no_data union carries no fields', () => {
    expect(JourneyTraceSchema.parse({ state: 'no_data' })).toEqual({ state: 'no_data' });
  });
});

describe('B3 JourneyCompare (3) /api/v1/journeys/compare', () => {
  it('accepts two journeys; t_minus_conversion_ms nullable + sequence_number bigint-string', () => {
    const parsed = JourneyCompareSchema.parse({
      left: {
        brain_id: 'L',
        conversion_at: '2026-07-01 12:00:00 UTC',
        touches: [
          { sequence_number: '1', occurred_at: '2026-07-01 09:00:00 UTC', event_type: 'page.viewed', channel: 'direct', campaign: null, is_composite: false, t_minus_conversion_ms: 10800000 },
          { sequence_number: '2', occurred_at: '2026-07-01 12:00:00 UTC', event_type: 'order.placed', channel: 'paid_meta', campaign: 'c', is_composite: true, t_minus_conversion_ms: 0 },
        ],
      },
      right: { brain_id: 'R', conversion_at: null, touches: [] },
      data_source: 'live',
    });
    expect(parsed.left.touches[1]?.t_minus_conversion_ms).toBe(0);
    expect(parsed.right.conversion_at).toBeNull();
  });

  it('rejects a float sequence_number (money/position is bigint-string only)', () => {
    expect(
      JourneyCompareSchema.safeParse({
        left: { brain_id: 'L', conversion_at: null, touches: [{ sequence_number: 1.5, occurred_at: 't', event_type: 'x', channel: null, campaign: null, is_composite: false, t_minus_conversion_ms: null }] },
        right: { brain_id: 'R', conversion_at: null, touches: [] },
        data_source: 'live',
      }).success,
    ).toBe(false);
  });
});
