/**
 * IdentityAuditDecisionLog.test.ts — the ADDITIVE identity_audit mapping (no DB).
 *
 * Proves the pure detail-builder writes the new fields into the existing `detail` JSONB without
 * touching the schema, that the CHECK-constrained `action` bucket + NOT-NULL brain_id anchor +
 * merge_id column are derived correctly, and that the evidence (incl. identifier_combo) round-trips
 * out of the persisted detail. The live PG round-trip is verified by the human.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { DecisionEngine, NIL_BRAIN_ID } from '../../domain/identity/decisions/DecisionEngine.js';
import type { DecisionLogEntry } from '../../domain/identity/decisions/DecisionLogRepository.js';
import type { ResolveOutcome, ExtractedIdentifier } from '../../domain/identity/IdentityResolver.js';
import type { ConfidenceVerdict, IdentityDecision } from '@brain/contracts';
import {
  buildAuditDetail,
  parseAuditEvidence,
  parseAuditEntry,
  mapCommandToAction,
  anchorBrainId,
  mergeIdOf,
} from './IdentityAuditDecisionLog.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRAIN_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BRAIN_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const RULE = 'v1-deterministic';
const NOW = '2026-06-27T00:00:00.000Z';
const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const EMAIL_HASH = h('e');
const PHONE_HASH = h('p');

const verdict: ConfidenceVerdict = {
  score: 100, band: 'exact', reasons: ['strong_key:email', 'strong_key:phone'],
  matcher_id: 'deterministic-union-find', rule_version: RULE,
  identifier_combo: [
    { identifier_type: 'email', identifier_hash: EMAIL_HASH },
    { identifier_type: 'phone', identifier_hash: PHONE_HASH },
  ],
};
const engine = new DecisionEngine();
const emailId: ExtractedIdentifier = { type: 'email', hash: EMAIL_HASH, tier: 'strong', confidence: 'high' };

function mintDecision(): IdentityDecision {
  const outcome: ResolveOutcome = {
    action: 'minted', brainId: BRAIN_A, newLinks: [emailId],
    phoneGuardUpdates: [], routeToReview: false, contactPiiWrites: [],
  };
  return engine.decide({ brand_id: BRAND, rule_version: RULE, decided_at: NOW, outcome, verdict });
}

describe('IdentityAuditDecisionLog — additive detail mapping', () => {
  it('records command + version + evidence_ref + inverse, plus the round-tripping evidence', () => {
    const decision = mintDecision();
    const decision_id = DecisionEngine.decisionId(decision);
    const evidence = engine.buildEvidence(decision, verdict, { thresholds: { phone_guard_threshold: 10 } });
    const entry: DecisionLogEntry = { decision_id, brand_id: BRAND, decision, evidence_ref: decision_id, recorded_at: NOW };

    const detail = buildAuditDetail(entry, evidence);
    expect(detail['command']).toBe('mint');
    expect(detail['rule_version']).toBe(RULE);
    expect(detail['evidence_ref']).toBe(decision_id);
    expect(detail['compensation']).toEqual({ kind: 'tombstone_brain_id', brain_id: BRAIN_A });

    // Evidence (identifier_combo) round-trips back out of the persisted detail — NOT lost as [].
    const reread = parseAuditEvidence(BRAND, detail);
    expect(reread).not.toBeNull();
    expect(reread!.identifier_combo).toEqual(verdict.identifier_combo);
    expect(reread!.identifier_combo).toHaveLength(2);
    expect(reread!.score).toBe(100);
    expect(reread!.thresholds).toEqual({ phone_guard_threshold: 10 });
  });

  it('parseAuditEntry recovers the decision_id + evidence_ref', () => {
    const decision = mintDecision();
    const decision_id = DecisionEngine.decisionId(decision);
    const detail = buildAuditDetail(
      { decision_id, brand_id: BRAND, decision, evidence_ref: decision_id, recorded_at: NOW },
      null,
    );
    const entry = parseAuditEntry(BRAND, detail);
    expect(entry.decision_id).toBe(decision_id);
    expect(entry.evidence_ref).toBe(decision_id);
  });

  it('maps every command to a CHECK-allowed action bucket', () => {
    expect(mapCommandToAction('mint')).toBe('mint');
    expect(mapCommandToAction('link')).toBe('link');
    expect(mapCommandToAction('merge')).toBe('merge');
    expect(mapCommandToAction('unmerge')).toBe('unmerge');
    // suppress + route_to_review have no graph commit → neutral 'link' bucket (true command in detail)
    expect(mapCommandToAction('suppress')).toBe('link');
    expect(mapCommandToAction('route_to_review')).toBe('link');
  });

  it('anchors brain_id per command (suppress → NIL sentinel)', () => {
    const merge = engine.unmerge({ brand_id: BRAND, rule_version: RULE, decided_at: NOW, merge_id: h('m').slice(0, 8) + '-0000-5000-8000-000000000000', canonical_brain_id: BRAIN_A, merged_brain_id: BRAIN_B, reason: 'x' });
    expect(anchorBrainId(mintDecision())).toBe(BRAIN_A);
    expect(anchorBrainId(merge)).toBe(BRAIN_A);
    expect(mergeIdOf(merge)).toBe(merge.merge_id);
    expect(mergeIdOf(mintDecision())).toBeNull();

    const suppressed = new Date('2026-07-27T00:00:00.000Z');
    const [sup] = engine.deriveSuppressions({
      brand_id: BRAND, rule_version: RULE, decided_at: NOW, verdict,
      outcome: {
        action: 'minted', brainId: BRAIN_A, newLinks: [emailId],
        phoneGuardUpdates: [{ identifier_type: 'phone', identifier_value: PHONE_HASH, profile_count: 11, suppress: true, suppressed_until: suppressed }],
        routeToReview: false, contactPiiWrites: [],
      },
    });
    expect(anchorBrainId(sup!)).toBe(NIL_BRAIN_ID);
  });
});
