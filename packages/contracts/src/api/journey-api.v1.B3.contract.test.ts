// SPEC: B.3
/**
 * B3 — Wave-B Journey API contracts (customer timeline / trace; AMD-14).
 * Locks the honest-empty unions, the matched_via serialization (AUD-JE-34/35: populated coarse
 * basis on ledger/trace paths, null only on the cache hot path) + nullable journey_version
 * (AMD-11), and the identity_evidence explainability shape. (The compare surface was removed
 * in the Wave-3 cleanup — AUD-IMPL-020.)
 */
import { describe, it, expect } from 'vitest';
import {
  CustomerJourneyTimelineSchema,
  JourneyTraceSchema,
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

  it('accepts the serving source with an ISO ts + a numeric journey_version + populated matched_via (AUD-JE-34)', () => {
    const parsed = CustomerJourneyTimelineSchema.parse({
      state: 'has_data',
      brain_id: 'b1',
      items: [
        { ts: '2026-07-01 10:00:00 UTC', type: 'order.placed', channel: 'paid_meta', campaign: 'x', url_path: null, session_id: null, matched_via: 'order', journey_version: 2 },
        { ts: '2026-07-01 09:00:00 UTC', type: 'page.viewed', channel: 'referral', campaign: null, url_path: null, session_id: null, matched_via: 'deterministic', journey_version: 1 },
      ],
      next_cursor: 'abc',
      journey_version: 2,
      source: 'serving',
      data_source: 'live',
    });
    expect(parsed.state === 'has_data' && parsed.source).toBe('serving');
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
