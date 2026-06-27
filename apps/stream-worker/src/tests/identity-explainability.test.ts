/**
 * identity-explainability — the read-only assembly that explains WHY an identity decision was made.
 *
 * Pure-domain unit tests over explainIdentityDecision / explainMerge / explainSplit (no IO).
 *
 * Invariants under test:
 *   1. A MERGE explanation cites the identifier_combo, matcher_id, rule_version + integer confidence.
 *   2. It is HASH-ONLY: the narrative uses 12-hex prefixes, never a raw email/phone.
 *   3. A SPLIT (unmerge) explanation names the reversed merge + its reason.
 *   4. Confidence is reported as `unknown` when neither the decision nor evidence carries a verdict
 *      (it is NEVER fabricated).
 *   5. Deterministic: the same inputs produce an identical explanation.
 */
import { describe, it, expect } from 'vitest';
import type { ConfidenceVerdict, IdentityDecision } from '@brain/contracts';
import {
  explainIdentityDecision,
  explainMerge,
  explainSplit,
} from '../domain/identity/IdentityExplainability.js';
import type { DecisionEvidence } from '../domain/identity/decisions/EvidenceStore.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const CANON = 'aaaaaaaa-0000-0000-0000-000000000001';
const MERGED = 'bbbbbbbb-0000-0000-0000-000000000002';
const MERGE_ID = 'cccccccc-0000-0000-0000-000000000003';
const HASH_EMAIL = 'a1b2c3d4e5f6'.padEnd(64, '0');

const verdict: ConfidenceVerdict = {
  score: 100,
  band: 'exact',
  reasons: ['strong_key:email'],
  matcher_id: 'deterministic-union-find',
  rule_version: 'v1-deterministic',
  identifier_combo: [{ identifier_type: 'email', identifier_hash: HASH_EMAIL }],
};

const merge: Extract<IdentityDecision, { command: 'merge' }> = {
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

const unmerge: Extract<IdentityDecision, { command: 'unmerge' }> = {
  command: 'unmerge',
  brand_id: BRAND,
  rule_version: 'v1-deterministic',
  decided_at: '2026-03-01T00:00:00.000Z',
  merge_id: MERGE_ID,
  canonical_brain_id: CANON,
  merged_brain_id: MERGED,
  reason: 'operator: false-positive stitch',
  compensation: { kind: 'remerge', merge_id: MERGE_ID, canonical_brain_id: CANON, merged_brain_id: MERGED },
};

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

describe('explainIdentityDecision — merge / split explanations', () => {
  it('cites identifier_combo, matcher_id, rule_version + integer confidence for a MERGE', () => {
    const ex = explainMerge(merge, evidence);
    expect(ex.command).toBe('merge');
    expect(ex.citations.matcher_id).toBe('deterministic-union-find');
    expect(ex.citations.rule_version).toBe('v1-deterministic');
    expect(ex.citations.confidence_score).toBe(100);
    expect(ex.citations.identifier_combo).toEqual(evidence.identifier_combo);
    expect(ex.citations.merge_id).toBe(MERGE_ID);
    // Narrative cites the matcher + rule + canonical/merged ids.
    expect(ex.narrative).toContain('deterministic-union-find');
    expect(ex.narrative).toContain(CANON);
    expect(ex.narrative).toContain(MERGED);
  });

  it('is hash-only: the narrative cites a 12-hex prefix, never raw PII', () => {
    const ex = explainMerge(merge, evidence);
    expect(ex.narrative).toContain('a1b2c3d4e5f6'); // 12-hex prefix
    expect(ex.narrative).not.toContain('@'); // no raw email
    // The full 64-hex is truncated to a prefix in the human narrative.
    expect(ex.narrative).not.toContain(HASH_EMAIL);
  });

  it('explains a SPLIT (unmerge): names the reversed merge + its reason', () => {
    const ex = explainSplit(unmerge);
    expect(ex.command).toBe('unmerge');
    expect(ex.headline).toContain('Split');
    expect(ex.narrative).toContain(MERGE_ID);
    expect(ex.narrative).toContain('false-positive stitch');
  });

  it('reports confidence as unknown when no verdict/evidence is present (never fabricated)', () => {
    const ex = explainSplit(unmerge); // unmerge carries no verdict, no evidence passed
    expect(ex.citations.confidence_score).toBeNull();
    expect(ex.citations.confidence_band).toBeNull();
  });

  it('is deterministic: identical inputs → identical explanation', () => {
    const a = explainIdentityDecision(merge, evidence);
    const b = explainIdentityDecision(merge, evidence);
    expect(a).toEqual(b);
  });
});
