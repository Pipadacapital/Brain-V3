/**
 * ScopedRecompute — pure unit tests.
 *
 * These tests run with zero infrastructure: no Kafka, no StarRocks, no Redis.
 * They verify DETERMINISM (same event → same output) and CORRECTNESS (a merge of A+B
 * affects exactly {A,B}, never a third brand or id; a suppression of X affects exactly {X}).
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  mapIdentityEventToScopedRecompute,
  CUSTOMER_GRAINED_MARTS,
  MART_TO_MV,
  type IdentityChangeInput,
  type ScopedRecompute,
} from './ScopedRecompute.js';

// ── Test fixtures ──────────────────────────────────────────────────────────────

const BRAND_A = randomUUID();
const BRAND_B = randomUUID();
const BRAIN_CANONICAL = randomUUID();
const BRAIN_MERGED_AWAY = randomUUID();
const BRAIN_SUPPRESSED = randomUUID();
const NOW = '2026-06-27T10:00:00Z';

function mergedInput(overrides?: Partial<{
  event_id: string;
  brand_id: string;
  canonical_brain_id: string;
  merged_brain_id: string;
}>): IdentityChangeInput {
  return {
    event_name: 'identity.merged',
    event_id:   overrides?.event_id    ?? randomUUID(),
    brand_id:   overrides?.brand_id    ?? BRAND_A,
    payload: {
      canonical_brain_id: overrides?.canonical_brain_id ?? BRAIN_CANONICAL,
      merged_brain_id:    overrides?.merged_brain_id    ?? BRAIN_MERGED_AWAY,
    },
  };
}

function suppressedInput(overrides?: Partial<{
  event_id: string;
  brand_id: string;
  brain_id: string;
}>): IdentityChangeInput {
  return {
    event_name: 'identity.suppressed',
    event_id:   overrides?.event_id ?? randomUUID(),
    brand_id:   overrides?.brand_id ?? BRAND_A,
    payload: { brain_id: overrides?.brain_id ?? BRAIN_SUPPRESSED },
  };
}

// ── Correctness: affected_brain_ids ───────────────────────────────────────────

describe('mapIdentityEventToScopedRecompute — affected_brain_ids correctness', () => {
  it('merged: affected set is exactly {canonical, merged_away} — no third id', () => {
    const result = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    expect(result.affected_brain_ids).toHaveLength(2);
    expect(result.affected_brain_ids).toContain(BRAIN_CANONICAL);
    expect(result.affected_brain_ids).toContain(BRAIN_MERGED_AWAY);
  });

  it('merged: a merge of A+B never includes a third brain_id', () => {
    const unrelated = randomUUID();
    const result = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    expect(result.affected_brain_ids).not.toContain(unrelated);
    expect(result.affected_brain_ids).toHaveLength(2);
  });

  it('merged: self-merge (canonical === merged_away) deduplicates to exactly one id', () => {
    const sameId = randomUUID();
    const result = mapIdentityEventToScopedRecompute(
      mergedInput({ canonical_brain_id: sameId, merged_brain_id: sameId }),
      NOW,
    );
    expect(result.affected_brain_ids).toHaveLength(1);
    expect(result.affected_brain_ids[0]).toBe(sameId);
  });

  it('suppressed: affected set is exactly {brain_id} — single subject', () => {
    const result = mapIdentityEventToScopedRecompute(suppressedInput(), NOW);
    expect(result.affected_brain_ids).toHaveLength(1);
    expect(result.affected_brain_ids[0]).toBe(BRAIN_SUPPRESSED);
  });

  it('suppressed: no unrelated ids appear in affected set', () => {
    const unrelated = randomUUID();
    const result = mapIdentityEventToScopedRecompute(suppressedInput(), NOW);
    expect(result.affected_brain_ids).not.toContain(unrelated);
  });
});

// ── Correctness: brand isolation ───────────────────────────────────────────────

describe('mapIdentityEventToScopedRecompute — brand isolation', () => {
  it('output brand_id equals input brand_id — no cross-brand leakage', () => {
    const resultA = mapIdentityEventToScopedRecompute(mergedInput({ brand_id: BRAND_A }), NOW);
    const resultB = mapIdentityEventToScopedRecompute(mergedInput({ brand_id: BRAND_B }), NOW);
    expect(resultA.brand_id).toBe(BRAND_A);
    expect(resultB.brand_id).toBe(BRAND_B);
  });

  it('different brands → different request_ids (brand_id is in the deterministic key)', () => {
    const eventId = randomUUID();
    const resultA = mapIdentityEventToScopedRecompute(mergedInput({ brand_id: BRAND_A, event_id: eventId }), NOW);
    const resultB = mapIdentityEventToScopedRecompute(mergedInput({ brand_id: BRAND_B, event_id: eventId }), NOW);
    expect(resultA.request_id).not.toBe(resultB.request_id);
  });
});

// ── Determinism: same event → same output ─────────────────────────────────────

describe('mapIdentityEventToScopedRecompute — determinism', () => {
  it('merged: same event_id → same request_id on two invocations', () => {
    const eventId = randomUUID();
    const r1 = mapIdentityEventToScopedRecompute(mergedInput({ event_id: eventId }), NOW);
    const r2 = mapIdentityEventToScopedRecompute(mergedInput({ event_id: eventId }), NOW);
    expect(r1.request_id).toBe(r2.request_id);
  });

  it('merged: different event_ids → different request_ids', () => {
    const r1 = mapIdentityEventToScopedRecompute(mergedInput({ event_id: randomUUID() }), NOW);
    const r2 = mapIdentityEventToScopedRecompute(mergedInput({ event_id: randomUUID() }), NOW);
    expect(r1.request_id).not.toBe(r2.request_id);
  });

  it('suppressed: same event_id → same request_id', () => {
    const eventId = randomUUID();
    const r1 = mapIdentityEventToScopedRecompute(suppressedInput({ event_id: eventId }), NOW);
    const r2 = mapIdentityEventToScopedRecompute(suppressedInput({ event_id: eventId }), NOW);
    expect(r1.request_id).toBe(r2.request_id);
  });

  it('merged: affected_brain_ids are sorted (canonical order)', () => {
    // Feed with canonical > merged_away in string order — result must still be sorted.
    const a = '00000000-0000-0000-0000-000000000001';
    const b = '00000000-0000-0000-0000-000000000002';
    const r1 = mapIdentityEventToScopedRecompute(
      mergedInput({ canonical_brain_id: b, merged_brain_id: a }), NOW,
    );
    const r2 = mapIdentityEventToScopedRecompute(
      mergedInput({ canonical_brain_id: a, merged_brain_id: b }), NOW,
    );
    // Both orderings must produce the same sorted array.
    expect(r1.affected_brain_ids).toEqual([a, b]);
    expect(r2.affected_brain_ids).toEqual([a, b]);
  });
});

// ── Correctness: affected_marts / affected_mvs ────────────────────────────────

describe('mapIdentityEventToScopedRecompute — affected marts', () => {
  it('affected_marts is the full CUSTOMER_GRAINED_MARTS set', () => {
    const result = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    expect(result.affected_marts).toBe(CUSTOMER_GRAINED_MARTS); // exact same reference
    expect(Array.from(result.affected_marts)).toEqual(Array.from(CUSTOMER_GRAINED_MARTS));
  });

  it('affected_mvs has one entry per mart and each maps to a brain_serving.mv_* name', () => {
    const result = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    expect(result.affected_mvs).toHaveLength(CUSTOMER_GRAINED_MARTS.length);
    for (const mv of result.affected_mvs) {
      expect(mv).toMatch(/^brain_serving\.mv_/);
    }
  });

  it('affected_mvs align with MART_TO_MV for every mart', () => {
    const result = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    const expected = CUSTOMER_GRAINED_MARTS.map((m) => MART_TO_MV[m]);
    expect(result.affected_mvs).toEqual(expected);
  });

  it('suppressed: same mart set as merged', () => {
    const merged = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    const suppressed = mapIdentityEventToScopedRecompute(suppressedInput(), NOW);
    expect(Array.from(suppressed.affected_marts)).toEqual(Array.from(merged.affected_marts));
  });
});

// ── Metadata fields ────────────────────────────────────────────────────────────

describe('mapIdentityEventToScopedRecompute — metadata', () => {
  it('source_event_id matches the input event_id', () => {
    const eventId = randomUUID();
    const result = mapIdentityEventToScopedRecompute(mergedInput({ event_id: eventId }), NOW);
    expect(result.source_event_id).toBe(eventId);
  });

  it('trigger_event reflects the input event_name', () => {
    const merged = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    const suppressed = mapIdentityEventToScopedRecompute(suppressedInput(), NOW);
    expect(merged.trigger_event).toBe('identity.merged');
    expect(suppressed.trigger_event).toBe('identity.suppressed');
  });

  it('requested_at reflects the now argument', () => {
    const customNow = '2026-01-01T00:00:00Z';
    const result = mapIdentityEventToScopedRecompute(mergedInput(), customNow);
    expect(result.requested_at).toBe(customNow);
  });

  it('request_id is a valid UUID format', () => {
    const result = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    expect(result.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

// ── Type exhaustiveness seam ───────────────────────────────────────────────────
// The erased arm is a SEAM — not yet a live event, but the type system + mapper switch
// are wired. Verify the seam compiles and returns the correct structure.
describe('mapIdentityEventToScopedRecompute — erased seam', () => {
  it('erased: single brain_id affected (mirrors suppressed)', () => {
    const erasedId = randomUUID();
    const erasedInput: IdentityChangeInput = {
      event_name: 'identity.erased',
      event_id:   randomUUID(),
      brand_id:   BRAND_A,
      payload:    { brain_id: erasedId },
    };
    const result = mapIdentityEventToScopedRecompute(erasedInput, NOW);
    expect(result.affected_brain_ids).toEqual([erasedId]);
    expect(result.trigger_event).toBe('identity.erased');
  });
});

// ── Output shape ───────────────────────────────────────────────────────────────
describe('mapIdentityEventToScopedRecompute — output shape', () => {
  it('all required fields are present on merged result', () => {
    const result: ScopedRecompute = mapIdentityEventToScopedRecompute(mergedInput(), NOW);
    expect(result.brand_id).toBeTruthy();
    expect(result.request_id).toBeTruthy();
    expect(result.source_event_id).toBeTruthy();
    expect(result.trigger_event).toBeTruthy();
    expect(result.affected_brain_ids.length).toBeGreaterThan(0);
    expect(result.affected_marts.length).toBeGreaterThan(0);
    expect(result.affected_mvs.length).toBeGreaterThan(0);
    expect(result.requested_at).toBeTruthy();
  });
});
