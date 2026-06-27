/**
 * Contract test: Customer360RecomputedEventSchema (the OPTIONAL Phase-2 recompute receipt).
 *
 * Validates that:
 *  1. A valid event parses + defaults (schema_version='1', gold_product='gold_customer_360',
 *     reason='scheduled_refresh').
 *  2. brand_id is always required on the envelope (I-S01) — the tenant key.
 *  3. brain_id is required in the payload (the subject whose 360 was rebuilt).
 *  4. event_name is pinned to 'intelligence.customer360.recomputed'.
 *  5. The reason enum is closed.
 */
import { describe, it, expect } from 'vitest';

import {
  Customer360RecomputedEventSchema,
  Customer360RecomputeReasonSchema,
  CUSTOMER360_RECOMPUTED_V1_EVENT_NAME,
} from './intelligence.customer360.recomputed.v1.js';

const VALID_EVENT = {
  event_id: '11111111-1111-4111-8111-111111111111',
  brand_id: '22222222-2222-4222-8222-222222222222',
  correlation_id: 'trace-abc-123',
  event_name: 'intelligence.customer360.recomputed',
  occurred_at: '2026-06-20T12:00:00Z',
  payload: {
    brain_id: 'brn_abc123',
    scope: { all: true },
  },
};

describe('Customer360RecomputedEventSchema — contract tests', () => {
  it('parses a valid event and applies defaults', () => {
    const r = Customer360RecomputedEventSchema.safeParse(VALID_EVENT);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.schema_version).toBe('1');
      expect(r.data.payload.gold_product).toBe('gold_customer_360');
      expect(r.data.payload.reason).toBe('scheduled_refresh');
      expect(r.data.payload.snapshot_id).toBeNull();
      // scope defaults flow through the reused CacheScopeSchema.
      expect(r.data.payload.scope.keys).toEqual([]);
      expect(r.data.payload.scope.key_prefixes).toEqual([]);
    }
  });

  it('requires brand_id on the envelope (I-S01)', () => {
    const { brand_id: _omit, ...noBrand } = VALID_EVENT;
    expect(Customer360RecomputedEventSchema.safeParse(noBrand).success).toBe(false);
  });

  it('requires brain_id in the payload (the rebuilt subject)', () => {
    const bad = { ...VALID_EVENT, payload: { scope: { all: true } } };
    expect(Customer360RecomputedEventSchema.safeParse(bad).success).toBe(false);
  });

  it('pins the event_name', () => {
    expect(CUSTOMER360_RECOMPUTED_V1_EVENT_NAME).toBe('intelligence.customer360.recomputed');
    const bad = { ...VALID_EVENT, event_name: 'something.else' };
    expect(Customer360RecomputedEventSchema.safeParse(bad).success).toBe(false);
  });

  it('closes the recompute-reason enum', () => {
    expect(Customer360RecomputeReasonSchema.safeParse('identity_merge').success).toBe(true);
    expect(Customer360RecomputeReasonSchema.safeParse('made_up').success).toBe(false);
  });
});
