/**
 * InMemoryDecisionLog.test.ts — the append-then-reference ledger semantics.
 *
 * Proves: append records the command + version + evidence_ref + inverse; read returns it; the log
 * is append-only + idempotent on decision_id; insertion order is preserved.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { DecisionEngine } from '../../domain/identity/decisions/DecisionEngine.js';
import type { DecisionLogEntry } from '../../domain/identity/decisions/DecisionLogRepository.js';
import type { ResolveOutcome, ExtractedIdentifier } from '../../domain/identity/IdentityResolver.js';
import type { ConfidenceVerdict } from '@brain/contracts';
import { InMemoryDecisionLog } from './InMemoryDecisionLog.js';

const BRAND = '11111111-1111-1111-1111-111111111111';
const BRAIN_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const RULE = 'v1-deterministic';
const NOW = '2026-06-27T00:00:00.000Z';
const h = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const emailId: ExtractedIdentifier = { type: 'email', hash: h('e'), tier: 'strong', confidence: 'high' };
const verdict: ConfidenceVerdict = {
  score: 100, band: 'exact', reasons: ['strong_key:email'],
  matcher_id: 'deterministic-union-find', rule_version: RULE,
  identifier_combo: [{ identifier_type: 'email', identifier_hash: h('e') }],
};
const engine = new DecisionEngine();

function entryFor(brainId: string): DecisionLogEntry {
  const outcome: ResolveOutcome = {
    action: 'minted', brainId, newLinks: [emailId],
    phoneGuardUpdates: [], routeToReview: false, contactPiiWrites: [],
  };
  const decision = engine.decide({ brand_id: BRAND, rule_version: RULE, decided_at: NOW, outcome, verdict });
  const decision_id = DecisionEngine.decisionId(decision);
  return { decision_id, brand_id: BRAND, decision, evidence_ref: decision_id, recorded_at: NOW };
}

describe('InMemoryDecisionLog', () => {
  it('appends and reads back the issued command + inverse + evidence_ref', async () => {
    const log = new InMemoryDecisionLog();
    const entry = entryFor(BRAIN_A);
    const receipt = await log.append(entry);
    expect(receipt.appended).toBe(true);

    const got = await log.read({ brand_id: BRAND, decision_id: entry.decision_id });
    expect(got).not.toBeNull();
    expect(got!.decision.command).toBe('mint');
    expect(got!.evidence_ref).toBe(entry.decision_id);
    expect(got!.decision.compensation).toEqual({ kind: 'tombstone_brain_id', brain_id: BRAIN_A });
  });

  it('is idempotent on decision_id (replay is a no-op, no duplicate row)', async () => {
    const log = new InMemoryDecisionLog();
    const entry = entryFor(BRAIN_A);
    const first = await log.append(entry);
    const second = await log.append(entry);
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
    expect(log.all()).toHaveLength(1);
  });

  it('preserves append order', async () => {
    const log = new InMemoryDecisionLog();
    const a = entryFor('aaaaaaaa-0000-0000-0000-00000000000a');
    const b = entryFor('aaaaaaaa-0000-0000-0000-00000000000b');
    await log.append(a);
    await log.append(b);
    expect(log.all().map((e) => e.decision_id)).toEqual([a.decision_id, b.decision_id]);
  });

  it('read returns null for an unknown decision', async () => {
    const log = new InMemoryDecisionLog();
    expect(await log.read({ brand_id: BRAND, decision_id: 'nope' })).toBeNull();
  });
});
