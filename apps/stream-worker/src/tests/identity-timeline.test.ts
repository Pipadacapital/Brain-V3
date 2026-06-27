/**
 * identity-timeline — the read-side projection over the identity decision log.
 *
 * Pure-domain unit tests over buildIdentityTimeline + timelineRecordFromDecision (no DB).
 *
 * Invariants under test:
 *   1. Records are returned in CHRONOLOGICAL order (occurred_at asc) with a stable sequence index.
 *   2. A record matches the subject when it is the PRIMARY or the RELATED brain_id (merged-away side).
 *   3. Records for other identities / other brands are excluded (tenant + subject scoping).
 *   4. timelineRecordFromDecision maps a MergeDecision (+evidence) to canonical/merged + merge_id +
 *      the hash-only identifier_combo + the integer confidence — sourced from the EvidenceStore.
 *   5. timelineRecordFromDecision falls back to the decision's embedded verdict when no evidence.
 */
import { describe, it, expect } from 'vitest';
import type {
  ConfidenceVerdict,
  IdentityDecision,
} from '@brain/contracts';
import {
  buildIdentityTimeline,
  timelineRecordFromDecision,
  type IdentityTimelineRecord,
} from '../domain/identity/IdentityTimeline.js';
import type { DecisionLogEntry } from '../domain/identity/decisions/DecisionLogRepository.js';
import type { DecisionEvidence } from '../domain/identity/decisions/EvidenceStore.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const OTHER_BRAND = '99999999-9999-9999-9999-999999999999';
const CANON = 'aaaaaaaa-0000-0000-0000-000000000001';
const MERGED = 'bbbbbbbb-0000-0000-0000-000000000002';
const MERGE_ID = 'cccccccc-0000-0000-0000-000000000003';
const HASH_EMAIL = 'a'.repeat(64);
const HASH_PHONE = 'b'.repeat(64);

function rec(p: Partial<IdentityTimelineRecord> & { brain_id: string; action: IdentityTimelineRecord['action']; occurred_at: string }): IdentityTimelineRecord {
  return {
    brand_id: BRAND,
    identifier_types: [],
    identifier_combo: [],
    rule_version: 'v1-deterministic',
    ...p,
  };
}

describe('buildIdentityTimeline — chronological projection', () => {
  it('orders by occurred_at ascending and stamps a stable sequence', () => {
    const records: IdentityTimelineRecord[] = [
      rec({ brain_id: CANON, action: 'merge', occurred_at: '2026-03-01T00:00:00.000Z', decision_id: 'd3' }),
      rec({ brain_id: CANON, action: 'mint', occurred_at: '2026-01-01T00:00:00.000Z', decision_id: 'd1' }),
      rec({ brain_id: CANON, action: 'link', occurred_at: '2026-02-01T00:00:00.000Z', decision_id: 'd2' }),
    ];
    const tl = buildIdentityTimeline(BRAND, CANON, records);
    expect(tl.entries.map((e) => e.action)).toEqual(['mint', 'link', 'merge']);
    expect(tl.entries.map((e) => e.sequence)).toEqual([0, 1, 2]);
    expect(tl.count).toBe(3);
  });

  it('includes a record where the subject is the RELATED (merged-away) brain_id', () => {
    const records: IdentityTimelineRecord[] = [
      rec({ brain_id: CANON, related_brain_id: MERGED, action: 'merge', occurred_at: '2026-02-01T00:00:00.000Z', merge_id: MERGE_ID }),
    ];
    // Querying the MERGED-away identity still surfaces the merge that absorbed it.
    const tl = buildIdentityTimeline(BRAND, MERGED, records);
    expect(tl.count).toBe(1);
    expect(tl.entries[0]!.merge_id).toBe(MERGE_ID);
  });

  it('excludes other identities and other brands', () => {
    const records: IdentityTimelineRecord[] = [
      rec({ brain_id: CANON, action: 'mint', occurred_at: '2026-01-01T00:00:00.000Z' }),
      rec({ brain_id: 'dddddddd-0000-0000-0000-000000000004', action: 'mint', occurred_at: '2026-01-02T00:00:00.000Z' }),
      rec({ brand_id: OTHER_BRAND, brain_id: CANON, action: 'mint', occurred_at: '2026-01-03T00:00:00.000Z' }),
    ];
    const tl = buildIdentityTimeline(BRAND, CANON, records);
    expect(tl.count).toBe(1);
    expect(tl.entries[0]!.brain_id).toBe(CANON);
  });
});

// ── timelineRecordFromDecision ────────────────────────────────────────────────

const verdict: ConfidenceVerdict = {
  score: 100,
  band: 'exact',
  reasons: ['strong_key:email', 'strong_key:phone'],
  matcher_id: 'deterministic-union-find',
  rule_version: 'v1-deterministic',
  identifier_combo: [
    { identifier_type: 'email', identifier_hash: HASH_EMAIL },
    { identifier_type: 'phone', identifier_hash: HASH_PHONE },
  ],
};

const mergeDecision: IdentityDecision = {
  command: 'merge',
  brand_id: BRAND,
  rule_version: 'v1-deterministic',
  decided_at: '2026-02-01T00:00:00.000Z',
  merge_id: MERGE_ID,
  canonical_brain_id: CANON,
  merged_brain_id: MERGED,
  verdict,
  compensation: { kind: 'unmerge', merge_id: MERGE_ID, canonical_brain_id: CANON, merged_brain_id: MERGED },
};

function logEntry(decision: IdentityDecision): DecisionLogEntry {
  return { decision_id: MERGE_ID, brand_id: BRAND, decision, evidence_ref: MERGE_ID, recorded_at: decision.decided_at };
}

const evidence: DecisionEvidence = {
  decision_id: MERGE_ID,
  brand_id: BRAND,
  command: 'merge',
  rule_version: 'v1-deterministic',
  matcher_id: 'deterministic-union-find',
  matcher_version: 'v1-deterministic',
  score: 100,
  band: 'exact',
  signals: ['strong_key:email'],
  identifier_combo: [{ identifier_type: 'email', identifier_hash: HASH_EMAIL }],
  thresholds: { phone_guard_threshold: 10 },
  recorded_at: '2026-02-01T00:00:00.000Z',
};

describe('timelineRecordFromDecision — engine-side mapping', () => {
  it('maps a MergeDecision (+evidence) to canonical/merged + merge_id + evidence combo + integer score', () => {
    const r = timelineRecordFromDecision(logEntry(mergeDecision), evidence);
    expect(r.action).toBe('merge');
    expect(r.brain_id).toBe(CANON);
    expect(r.related_brain_id).toBe(MERGED);
    expect(r.merge_id).toBe(MERGE_ID);
    expect(r.confidence_score).toBe(100); // integer, from the EvidenceStore
    expect(r.identifier_combo).toEqual(evidence.identifier_combo); // evidence is the canonical source
    expect(r.decision_id).toBe(MERGE_ID);
  });

  it('falls back to the decision verdict when no evidence is supplied', () => {
    const r = timelineRecordFromDecision(logEntry(mergeDecision));
    expect(r.matcher_id).toBe('deterministic-union-find');
    expect(r.confidence_score).toBe(100);
    expect(r.identifier_combo).toHaveLength(2); // from the verdict
  });
});
