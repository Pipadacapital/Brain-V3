/**
 * google-entity-sync unit tests — the deterministic ad.entity.updated event_id (A3).
 *
 * The id must be: (1) stable for the same (brand, level, entity, syncDate) → intra-day MERGE dedup;
 * (2) DISTINCT per day → a new day re-states the SCD so silver picks up status/name changes;
 * (3) DISTINCT per level/entity; (4) UUID-shaped (v5 layout) like the spend event_id.
 */
import { describe, it, expect } from 'vitest';
import { entityEventId, AD_ENTITY_UPDATED_EVENT_NAME } from './run.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('entityEventId (ad.entity.updated)', () => {
  it('event name literal is the SHARED canonical type', () => {
    expect(AD_ENTITY_UPDATED_EVENT_NAME).toBe('ad.entity.updated');
  });

  it('is deterministic for the same grain + syncDate (intra-day idempotency)', () => {
    const a = entityEventId(BRAND, 'campaign', '123', '2026-06-28');
    const b = entityEventId(BRAND, 'campaign', '123', '2026-06-28');
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it('changes per day so silver re-states the dimension', () => {
    const day1 = entityEventId(BRAND, 'campaign', '123', '2026-06-28');
    const day2 = entityEventId(BRAND, 'campaign', '123', '2026-06-29');
    expect(day1).not.toBe(day2);
  });

  it('is distinct per level and per entity', () => {
    const camp = entityEventId(BRAND, 'campaign', '123', '2026-06-28');
    const adset = entityEventId(BRAND, 'adset', '123', '2026-06-28');
    const ad = entityEventId(BRAND, 'ad', '123', '2026-06-28');
    const other = entityEventId(BRAND, 'campaign', '999', '2026-06-28');
    expect(new Set([camp, adset, ad, other]).size).toBe(4);
  });

  it('is brand-scoped (different brand → different id)', () => {
    const a = entityEventId(BRAND, 'campaign', '123', '2026-06-28');
    const b = entityEventId('22222222-2222-2222-2222-222222222222', 'campaign', '123', '2026-06-28');
    expect(a).not.toBe(b);
  });
});
