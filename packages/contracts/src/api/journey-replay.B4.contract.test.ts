// SPEC: B.4
/**
 * B.4 contract — Journey Replay (?as_of=) + Explainability round-trips.
 *
 * Asserts the shared response contract: replayed:true is REQUIRED on the replay surface, every
 * journey item carries matched_via + brain_id_asof + estimated, and identity_asof carries the shared
 * identity_evidence [{identifier_type, first_seen, source}] (the same item WB-B3's trace endpoint uses).
 */
import { describe, it, expect } from 'vitest';
import {
  JourneyReplaySchema,
  JourneyEventDtoSchema,
  IdentityAsOfStateSchema,
} from './analytics.api.v1.js';
// The shared identity_evidence item is owned by the WB-B3 journey-api contract (reused by B.4).
import { IdentityEvidenceItemSchema } from './journey-api.v1.js';

const EVENT = {
  touchpoint_id: 'tp-1',
  sequence_number: '3',
  occurred_at: '2026-07-01 12:01:00',
  event_category: 'behaviour',
  event_type: 'page.viewed',
  channel: 'referral',
  campaign: null,
  revenue_minor: null,
  currency_code: null,
  is_composite: false,
  identity_confidence: 1,
  data_version: 1,
  matched_via: 'deterministic',
  brain_id_asof: '44444444-4444-4444-8444-444444444444',
  estimated: false,
};

describe('B.4 — JourneyEventDto explainability fields', () => {
  it('accepts an item carrying matched_via + brain_id_asof + estimated', () => {
    expect(JourneyEventDtoSchema.parse(EVENT).matched_via).toBe('deterministic');
  });

  it('REJECTS an item missing matched_via (explainability is required on every row)', () => {
    const { matched_via: _omit, ...rest } = EVENT;
    const r = JourneyEventDtoSchema.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain('matched_via');
  });

  it('accepts an optional probabilistic-overlay confidence', () => {
    expect(JourneyEventDtoSchema.parse({ ...EVENT, estimated: true, confidence: 0.97 }).confidence).toBe(0.97);
  });
});

describe('B.4 — IdentityAsOfState / identity_evidence (shared with WB-B3 trace)', () => {
  it('round-trips identity_evidence items', () => {
    const item = { identifier_type: 'email', first_seen: '2026-07-01 12:00:00', source: 'identity_map' };
    expect(IdentityEvidenceItemSchema.parse(item)).toEqual(item);
    expect(IdentityAsOfStateSchema.parse({ identified: true, evidence: [item] }).identified).toBe(true);
  });
});

describe('B.4 — JourneyReplay response', () => {
  it('round-trips a has_data replay with replayed:true + identity_asof', () => {
    const payload = {
      state: 'has_data' as const,
      replayed: true as const,
      as_of: '2026-07-01T10:00:00.000Z',
      brain_id: '44444444-4444-4444-8444-444444444444',
      events: [EVENT],
      identity_asof: {
        identified: true,
        evidence: [{ identifier_type: 'email', first_seen: '2026-07-01 12:00:00', source: 'identity_map' }],
      },
      next_cursor: null,
      data_source: 'live' as const,
    };
    const parsed = JourneyReplaySchema.parse(payload);
    expect(parsed.state).toBe('has_data');
    if (parsed.state === 'has_data') {
      expect(parsed.replayed).toBe(true);
      expect(parsed.events[0]?.matched_via).toBe('deterministic');
    }
  });

  it('round-trips honest-empty replay (still marked replayed:true)', () => {
    const parsed = JourneyReplaySchema.parse({ state: 'no_data', replayed: true, as_of: '2026-07-01T10:00:00.000Z' });
    expect(parsed).toEqual({ state: 'no_data', replayed: true, as_of: '2026-07-01T10:00:00.000Z' });
  });

  it('REJECTS replayed:false on the replay surface (batch reconstruction is never a live read)', () => {
    const r = JourneyReplaySchema.safeParse({ state: 'no_data', replayed: false, as_of: '2026-07-01T10:00:00.000Z' });
    expect(r.success).toBe(false);
  });
});
